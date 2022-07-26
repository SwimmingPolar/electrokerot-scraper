import dotenv from 'dotenv'
dotenv.config({
  path: 'config/dev.env'
})
import fs from 'fs'
import fetch from 'node-fetch'
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

  const status = await client.GET('status')
  if (status === 'done') {
    log.error('ScraperMain', 'Scraper is already done')
    process.exit(0)
  }
  if (status !== 'running') {
    await parseConfig()
    await client.SET('status', 'running')
  }

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
      const category = (await client.SRANDMEMBER('categories')) || ''

      /**
       * Remove pages from redis
       */
      const pages = await client.SPOP(`pages:${category}`, 5)
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
       * Register to redis to know when the current pages are scraped
       */
      // register to pending work
      // retry until transaction is successful
      // if transaction fails then retry again
      // multiple updater instances are also accessing pending work
      // so, transaction must be guaranteed to be ACID oriented
      await retry(function () {
        return new Promise<void>((resolve, reject) => {
          ;(async () => {
            try {
              // watch for changes in redis
              // if changes are detected then WatchError is thrown
              const pendingPagesCategory = `pendingPages:${category}`
              await client.WATCH(pendingPagesCategory)
              await client.WATCH('pendingCategories')
              await client
                .multi()
                .SADD(pendingPagesCategory, pages)
                .SADD('pendingCategories', category)
                .exec()
              resolve()
            } catch (error) {
              if (error instanceof WatchError) {
                reject()
              } else {
                log.error('ScraperMain', error + '')
              }
            }
          })()
        })
      })()

      /**
       * Send request to scrap pages
       */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      await new Promise<void>((resolve, _) => {
        ;(async function request() {
          retry(fetch)('http://localhost:10000/updatePages', {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category,
              url: pageBaseUrl + categoryNumber,
              pages,
              minimumDate,
              ignoreWords,
              filters
            })
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
    } while (categoriesLength > 0)

    /**
     * Wait for all pending work before proceeding to next stage
     */
    await retry(function () {
      return new Promise<void>((resolve, reject) => {
        ;(async () => {
          const pendingWork = (await client.SMEMBERS('pendingCategories')) || []
          if (pendingWork.length === 0) {
            resolve()
          } else {
            setTimeout(reject, 500)
          }
        })()
      })
    })()
  } catch (error) {
    log.error('ScrapPages', error + '')
  }

  /**
   * START ITEMS SCRAPING
   */
  try {
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
      const collection = db.collection(category)

      /**
       * Find 10 items that are not currently updating and are not scraped yet
       */
      const pcodes =
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
              // limit items total to 6~10
              {
                $limit: Math.ceil(Math.random() * 5 + 5)
              }
            ])
            .toArray()) as { pcode: string }[]
        )?.map(({ pcode }) => pcode) || []

      // if there is no items to scrap, remove category from itemsCategories
      if (pcodes.length === 0) {
        itemsCategories.splice(itemsCategories.indexOf(category), 1)
        continue
      }

      /**
       * Send request to scrap items
       */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      await new Promise<void>((resolve, _) => {
        ;(async function request() {
          retry(fetch)('http://localhost:10000/updateItems', {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl: itemBaseUrl,
              category,
              pcodes
            })
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

      /**
       * Register items to pending work
       */
      await retry(function () {
        return new Promise<void>((resolve, reject) => {
          ;(async () => {
            try {
              const pendingItemsCategory = `pendingItems:${category}`
              await client.WATCH(pendingItemsCategory)
              await client.WATCH('pendingItems')
              await client
                .multi()
                .SADD(pendingItemsCategory, pcodes)
                .SADD('pendingItems', category)
                .exec()
              resolve()
            } catch (error) {
              if (error instanceof WatchError) {
                reject()
              } else {
                log.error('ScraperMain', error + '')
              }
            }
          })()
        })
      })()
    }

    /**
     * Wait for all pending work before exiting
     */
    await retry(function () {
      return new Promise<void>((resolve, reject) => {
        ;(async () => {
          const pendingWork = (await client.SMEMBERS('pendingItems')) || []
          if (pendingWork.length === 0) {
            resolve()
          } else {
            setTimeout(reject, 500)
          }
        })()
      })
    })()

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
