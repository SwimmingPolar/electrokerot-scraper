import dotenv from 'dotenv'
if (process.env.NODE_ENV === 'development') {
  dotenv.config({
    path: 'config/dev.env'
  })
}
import fs from 'fs'
import fetch from 'node-fetch'
import { add, formatDistanceToNow } from 'date-fns'
// user defined
import {
  parseConfig,
  handlePending,
  log,
  retry,
  RedisHelper,
  MongoHelper
} from 'utils'
// types
import { WatchError } from 'redis'
import { CategoryMeta } from './utils/parseConfig'

// ignore prettier
;(async () => {
  const client = await RedisHelper.getRedisClient()

  // check scraper status
  const status = await client.GET('status')
  if (status === 'done') {
    log.error('ScraperMain', 'Scraper is already done')
    process.exit(0)
  }
  if (status !== 'running') {
    await parseConfig()
    await client.SET('status', 'running')
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
    log.error('HandlePending', error + '')
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
    log.error('ScrapPages', error + '')
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
    log.error('ScrapItems', error + '')
  }

  // exit the program
  // container will go down and running status will be reset if correctly configured
  // indicating that the scraper is ready to start again on next restart
  await client.SET('status', 'done')
  log.info('Scraper is done and exiting')
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

// wait for pending work
async function waitForPendingWork(pendingWorkTypePrefix: string) {
  const client = await RedisHelper.getRedisClient()
  return retry(function () {
    return new Promise<void>((resolve, reject) => {
      ;(async () => {
        const pendingWork =
          (await client.SMEMBERS(`pending${pendingWorkTypePrefix}`)) || []
        if (pendingWork.length === 0) {
          resolve()
        } else {
          setTimeout(reject, 500)
        }
      })()
    })
  })()
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

async function estimateTimeToCompletion() {
  const client = await RedisHelper.getRedisClient()
  const db = await MongoHelper.getDb()
  const remainingRequestsHistory: number[] = []
  const INTERVAL = 3000

  async function getRemainingPages() {
    // remaining pages
    const pages = await client.SMEMBERS('categories')
    const pendingPages = await client.SMEMBERS('pendingPages')
    const multi = client.multi()
    pages.forEach(page => multi.SMEMBERS(`pages:${page}`))
    pendingPages.forEach(pendingPage =>
      multi.SMEMBERS(`pendingPages:${pendingPage}`)
    )
    const results = (await multi.exec()) as string[][]
    const remainingPages = results.reduce(
      (totalPages, page) => totalPages + page.length,
      0
    )
    return remainingPages
  }
  async function getRemainingItems() {
    const { CONFIG_FILE_PATH = 'config/scrapConfig.json' } = process.env
    const configFile = fs.readFileSync(CONFIG_FILE_PATH, {
      encoding: 'utf8'
    })
    const { itemsCategories = [] } = JSON.parse(configFile) as {
      itemsCategories: string[]
    }

    let remainingItems = 0
    for await (const category of itemsCategories) {
      // pending items in redis
      const pendingItems =
        (await client.SMEMBERS(`pendingItems:${category}`)) || []
      // items to be updated in db
      const collection = db.collection(category)

      remainingItems +=
        pendingItems.length +
          (await collection.count({
            isUpdating: false,
            updatedAt: {
              $lt: new Date(new Date().setHours(13, 0, 0))
            }
          })) || 0
    }
    return remainingItems
  }

  async function init() {
    const totalPages = await getRemainingPages()
    const totalItems = await getRemainingItems()

    remainingRequestsHistory.push(totalPages + totalItems)

    // start timer
    setInterval(async () => {
      const remainingPages = await getRemainingPages()
      const remainingItems = await getRemainingItems()
      const remainingRequests = remainingPages + remainingItems

      remainingRequestsHistory.push(remainingRequests)
      // maintain history of remaining requests to 1000
      if (remainingRequestsHistory.length >= 1000) {
        remainingRequestsHistory.shift()
      }

      const averageProcessedRequestsPerInterval =
        remainingRequestsHistory
          .map((_, i, arr) => arr[i - 1] - arr[i])
          .filter(e => e)
          .reduce((prev, cur) => prev + cur, 0) /
        (remainingRequestsHistory.length - 1)

      const averageRequestsPerSecond =
        averageProcessedRequestsPerInterval / (INTERVAL / 1000)
      const estimatedTimeToCompletionInSeconds = Math.round(
        remainingRequests / averageRequestsPerSecond
      )

      if (Number.isInteger(estimatedTimeToCompletionInSeconds)) {
        const estimatedCompletionTime = add(new Date(), {
          seconds: estimatedTimeToCompletionInSeconds
        })

        process.stdout.write('\u001b[3J\u001b[2J\u001b[1J')
        console.clear()
        log.info('Total pages to scrap: ', `${remainingPages}/${totalPages}`)
        log.info('Total items to update: ', `${remainingItems}/${totalItems}`)
        log.info(
          // go up a line / clear current line
          'Estimated time to completion: ',
          `${formatDistanceToNow(
            estimatedCompletionTime
          )} (avg. ${averageRequestsPerSecond} requests/s)`
        )
      }
    }, INTERVAL)
  }

  log.info('Estimating time to completion...')
  init()
}
