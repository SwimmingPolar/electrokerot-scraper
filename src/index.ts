import dotenv from 'dotenv'
if (process.env.NODE_ENV?.trim() === 'development') {
  dotenv.config({
    path: 'config/dev.env'
  })
}
import fs from 'fs'
import { WatchError } from 'redis'
// user defined
import {
  parseConfig,
  handlePending,
  log,
  retry,
  RedisHelper,
  MongoHelper,
  checkProxyStatus,
  estimateTimeToCompletion,
  waitForPendingWork
} from './utils'
// types
import { CategoryMeta } from './utils/parseConfig.js'

// ignore prettier
;(async () => {
  // check proxy status before start under production mode
  if (process.env.NODE_ENV?.trim() === 'production') {
    await checkProxyStatus()
  }

  await MongoHelper.initiateMongoClient()
  const client = await RedisHelper.getRedisClient()

  // check scraper status
  const status = await client.GET('status')
  if (status === 'done') {
    log.error('ScraperMain', 'Scraper is already done')
    process.exit(0)
  }
  if (status !== 'running') {
    try {
      await parseConfig()
      await client.SET('status', 'running')
    } catch (error) {
      log.error('ScraperMain', 'Error parsing config: ' + error)
      process.exit(1)
    }
  }

  // base urls for scraping pages and items
  const [pageBaseUrl, itemBaseUrl] = (await client
    .multi()
    .GET('pageBaseUrl')
    .GET('itemBaseUrl')
    .exec()) as [string, string]
  if (!pageBaseUrl || !itemBaseUrl) {
    log.error('ScraperMain', 'BaseUrl is not set')
    process.exit(1)
  }

  /**
   * Move pending work to current work bench
   */
  try {
    await handlePending()
  } catch (error) {
    log.error('ScraperMain', 'Error handling pending works' + error)
  }

  // start estimating time to completion
  estimateTimeToCompletion()

  /**
   * START PAGES SCRAPING
   */
  try {
    let categoriesLength: number
    do {
      /**
       * Check if there are categories to parse
       */
      const categories = await client.SMEMBERS('categories')
      categoriesLength = categories.length

      // if there is no categories left to scrap, move on to next stage
      if (categoriesLength === 0) {
        break
      }

      /**
       * Get random category from redis
       */
      const category = (await client.SRANDMEMBER('categories')) as string

      /**
       * Get 3 < n < 6 pages from redis
       */
      const pageCount = Math.ceil(Math.random() * 3 + 3)
      const pages = await client.SPOP(`pages:${category}`, pageCount)

      // if the current category has no pages to scrap, delete it from categories and continue
      if (pages.length === 0) {
        const multi = client.multi().DEL('categories')
        const leftCategories = categories.filter(c => c !== category)
        if (leftCategories.length > 0) {
          multi.SADD('categories', leftCategories).exec()
        }
        await multi.exec()
        continue
      }

      // get category meta information
      const categoryMeta = JSON.parse(
        (await client.GET(category)) || '{}'
      ) as CategoryMeta
      const { categoryNumber, minimumDate, ignoreWords, filters } = categoryMeta

      /**
       * Register pending pages to redis
       * to know when the current pages are scraped
       */
      await registerPendingWork('Pages', category, pages)

      /**
       * Send request to update pages
       */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const requestUrl =
        process.env.UPDATE_PAGES_URL || 'http://localhost:10000/updatePages'
      await sendRequest(requestUrl, {
        category,
        url: pageBaseUrl + categoryNumber,
        pages,
        minimumDate,
        ignoreWords,
        filters
      })
    } while (categoriesLength > 0)

    /**
     * Wait for all pending work before proceeding to next stage
     */
    await waitForPendingWork('Pages')
  } catch (error) {
    log.error('ScraperMain', 'Error parsing pages' + error)
    process.exit(1)
  }

  /**
   * START ITEMS SCRAPING
   */
  try {
    // get list of categories configured to be scraped
    const { CONFIG_FILE_PATH = 'config/scrapConfig.json' } = process.env
    const configFile = fs.readFileSync(CONFIG_FILE_PATH, {
      encoding: 'utf8'
    })
    const { itemsCategories = [] } = JSON.parse(configFile) as {
      itemsCategories: string[]
    }
    const itemsCategoriesBackup = [...itemsCategories]

    // if there is no items categories to scrap, exit
    const db = await MongoHelper.getDb()

    // return random category from given categories
    const getRandom = (categories: string[]) =>
      categories[Math.floor(Math.random() * categories.length)] || undefined
    while (itemsCategories.length > 0) {
      // get random category
      const category = getRandom(itemsCategories)
      // if category is not set, it means there is no categories to scrap
      if (!category) {
        break
      }

      /**
       * Get 5 < n < 10 items from random category which are not
       * currently updating and are not scraped yet
       */
      const collection = db.collection(category)
      const pcodes = await getRandomItems(collection)

      // if there is no items to scrap, remove category from itemsCategories
      if (pcodes.length === 0) {
        itemsCategories.splice(itemsCategories.indexOf(category), 1)
        continue
      }

      /**
       * Send request to update items
       */
      const requestUrl =
        process.env.UPDATE_ITEMS_URL || 'http://localhost:10000/updateItems'
      await sendRequest(requestUrl, {
        baseUrl: itemBaseUrl,
        category,
        pcodes
      })

      /**
       * Register pending items to redis
       */
      await registerPendingWork('Items', category, pcodes)
      await markIsUpdating(category, pcodes)
    }

    /**
     * Wait for all pending work before exiting
     */
    await waitForPendingWork('Items')

    /**
     * mark all items as scraped (isUpdating: false)
     */
    for await (const itemCategory of itemsCategoriesBackup) {
      const collection = db.collection(itemCategory)
      await collection.updateMany({}, { $set: { isUpdating: false } })
    }
  } catch (error) {
    log.error('ScraperMain', 'Error updating items' + error)
    process.exit(1)
  }

  // exit the program
  // container will go down and running status will be reset if correctly configured
  // indicating that the scraper is ready to start again on next restart
  await client.SET('status', 'done')
  log.info('Scraper is done and exiting')
  // exit the program without error
  process.exit(0)
})()

// register to pending work
// retry until transaction is successful
// if transaction fails then retry again
// multiple updater instances are accessing pending work at the same time
// so, transaction must guaranteed to be ACID oriented
async function registerPendingWork(
  pendingWorkTypePrefix: string,
  category: string,
  works: string[]
): Promise<void> {
  // get redis client
  const client = await RedisHelper.getRedisClient()
  return retry(function () {
    return new Promise<void>((resolve, reject) => {
      ;(async () => {
        try {
          // watch for changes in redis
          // if changes are detected then WatchError is thrown
          const pendingWorkCategoriesKey = `pending${pendingWorkTypePrefix}`
          const pendingWorkKey = `pending${pendingWorkTypePrefix}:${category}`
          await client.WATCH([pendingWorkCategoriesKey, pendingWorkKey])

          await client
            .multi()
            .SADD(pendingWorkKey, works)
            .SADD(pendingWorkCategoriesKey, category)
            .exec()
          resolve()
        } catch (error) {
          if (error instanceof WatchError) {
            reject()
          } else {
            log.error('Scrapper Main', 'Registering pending work: ' + error)
          }
        }
      })()
    })
  })()
}

async function markIsUpdating(category: string, pcodes: string[]) {
  const db = await MongoHelper.getDb()
  const collection = db.collection(category)

  const queries = pcodes.map(pcode => ({
    updateOne: {
      filter: { pcode },
      update: {
        $set: { isUpdating: true }
      }
    }
  }))

  await collection.bulkWrite(queries)
}

function sendRequest(url: string, body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new Promise<void>((resolve, _) => {
    ;(async function request() {
      retry(fetch)(url, {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(async response => {
        const status = response.status
        const result = (await response.json()) as { keepGoing: boolean }

        /**
         * KeepGoing: false - server is busy, then try again
         */
        if (status === 503 && result.keepGoing === false) {
          setTimeout(request, 0)
        } else {
          resolve()
        }
      })
    })()
  })
}

import { Collection } from 'mongodb'
async function getRandomItems(collection: Collection) {
  return (
    (
      (await collection
        .aggregate([
          {
            $match: {
              isUpdating: false,
              // updating starts at 13:00 and items that have
              // updatedAt time pass 13:00 are considered scraped
              updatedAt: { $lt: new Date(new Date().setHours(13, 0, 0)) }
            }
          },
          { $project: { pcode: 1 } },
          // limit items total to 5~10
          {
            $limit: Math.ceil(Math.random() * 5 + 5)
          }
        ])
        .toArray()) as { pcode: string }[]
    )?.map(({ pcode }) => pcode) || []
  )
}
