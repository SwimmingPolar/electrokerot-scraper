import { add, formatDistanceToNow } from 'date-fns'
import fs from 'fs'
import { getDb, getRedisClient } from '../helper'
import { log } from '../utils'

// get all categories
const { CONFIG_FILE_PATH = 'config/scrapConfig.json' } = process.env
const configFile = fs.readFileSync(CONFIG_FILE_PATH, {
  encoding: 'utf8'
})
const { itemsCategories = [] } = JSON.parse(configFile) as {
  itemsCategories: string[]
}

export async function estimateTimeToCompletion() {
  const client = await getRedisClient()
  const db = await getDb()
  const processedRequestsHistory: number[] = []
  const INTERVAL = 3000
  const lastProcessedRequests = {
    items: 0,
    pages: 0
  }

  async function getRemainingPages() {
    // remaining pages
    const pages = await client.SMEMBERS('categories')
    const pendingPages = await client.SMEMBERS('pendingPages')
    const multi = client.multi()
    // get pending pages
    pendingPages.forEach(pendingPage =>
      multi.SMEMBERS(`pendingPages:${pendingPage}`)
    )
    // get pages to be scraped
    pages.forEach(page => multi.SMEMBERS(`pages:${page}`))
    // combine both
    const results = (await multi.exec()) as string[][]
    const remainingPages = results.reduce(
      (totalPages, page) => totalPages + page.length,
      0
    )
    return remainingPages
  }
  async function getRemainingItems() {
    let remainingItems = 0
    // get pending items
    for await (const category of itemsCategories) {
      const pendingItems =
        (await client.SMEMBERS(`pendingItems:${category}`)) || []
      remainingItems += pendingItems?.length || 0
    }
    // get to-be-updated items
    const updatePendingItems =
      (await db.collection('parts').countDocuments({
        isUpdating: false,
        updatedAt: {
          $lt: new Date(new Date().setHours(10, 0, 0))
        }
      })) || 0
    return remainingItems + updatePendingItems
  }

  async function getUpdatedWork() {
    const [itemsUpdated = 0, pagesUpdated = 0] = (await client
      .multi()
      .GET('updateCount:Items')
      .GET('updateCount:Pages')
      .exec()) as [number, number]
    return {
      itemsUpdated,
      pagesUpdated
    }
  }

  async function init() {
    // if the app restarts restore last updated works count
    const { itemsUpdated, pagesUpdated } = await getUpdatedWork()
    lastProcessedRequests.items = itemsUpdated
    lastProcessedRequests.pages = pagesUpdated

    // start timer
    setInterval(async () => {
      const remainingPages = await getRemainingPages()
      const remainingItems = await getRemainingItems()
      const remainingRequests = remainingPages + remainingItems

      const { itemsUpdated, pagesUpdated } = await getUpdatedWork()

      const requestsProcessed =
        +itemsUpdated -
        lastProcessedRequests.items +
        (+pagesUpdated - lastProcessedRequests.pages)

      processedRequestsHistory.push(requestsProcessed)
      // scraping a given request takes about 1.75 minute (105 seconds)
      // updater can hold max 10 requests to items
      // so, it takes at least 1050 seconds to get accurate avg speed
      // 1050 seconds / 3 seconds interval = 350 max histories
      if (processedRequestsHistory.length >= 350) {
        processedRequestsHistory.shift()
      }

      lastProcessedRequests.items = +itemsUpdated
      lastProcessedRequests.pages = +pagesUpdated

      const averageProcessedRequestsPerInterval =
        processedRequestsHistory.reduce((prev, cur) => prev + cur, 0) /
        processedRequestsHistory.length

      const averageRequestsPerSecond =
        averageProcessedRequestsPerInterval / (INTERVAL / 1000)
      const estimatedTimeToCompletionInSeconds = Math.round(
        remainingRequests / averageRequestsPerSecond
      )

      if (Number.isInteger(estimatedTimeToCompletionInSeconds)) {
        const estimatedCompletionTime = add(new Date(), {
          seconds: estimatedTimeToCompletionInSeconds
        })

        // total works to insert/update
        const totalPages = +remainingPages + +pagesUpdated
        const totalItems = +remainingItems + +itemsUpdated

        process.stdout.write('\u001b[3J\u001b[2J\u001b[1J')
        console.clear()
        log.info('Total pages to scrap: ', `${remainingPages}/${totalPages}`)
        log.info('Total items to update: ', `${remainingItems}/${totalItems}`)
        log.info(
          // go up a line / clear current line
          'Estimated time to completion: ',
          `${formatDistanceToNow(
            estimatedCompletionTime
          )} (avg. ${averageRequestsPerSecond.toFixed(3)} requests/s)`
        )
      }
    }, INTERVAL)
  }

  init()
  log.info('Estimating time to completion...')
}
