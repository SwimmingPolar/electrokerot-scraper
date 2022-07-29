import fs from 'fs'
import { add, formatDistanceToNow } from 'date-fns'
// user defined
import * as RedisHelper from './redisHelper'
import * as MongoHelper from './mongoHelper'
import log from './logger'

// get all categories
const { CONFIG_FILE_PATH = '../../config/scrapConfig.json' } = process.env
const configFile = fs.readFileSync(CONFIG_FILE_PATH, {
  encoding: 'utf8'
})
const { itemsCategories = [] } = JSON.parse(configFile) as {
  itemsCategories: string[]
}

let averageSpeed = 0

export async function estimateTimeToCompletion() {
  const client = await RedisHelper.getRedisClient()
  const db = await MongoHelper.getDb()
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
    // iterate each category
    for await (const category of itemsCategories) {
      // get pending items
      const pendingItems =
        (await client.SMEMBERS(`pendingItems:${category}`)) || []
      // get items to be updated in db
      const collection = db.collection(category)

      // combine both
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
    // total works to insert/update
    const totalPages = await getRemainingPages()
    const totalItems = await getRemainingItems()

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
        // if average speed is integer, save for later use
        averageSpeed = averageRequestsPerSecond
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
          )} (avg. ${averageRequestsPerSecond.toFixed(3)} requests/s)`
        )
      }
    }, INTERVAL)
  }

  init()
  log.info('Estimating time to completion...')
}

// wait for pending work
export async function waitForPendingWork(pendingWorkTypePrefix: string) {
  const client = await RedisHelper.getRedisClient()
  const pendingWorksCategories =
    (await client.KEYS(`pending${pendingWorkTypePrefix}:*`)) || ([] as string[])
  const multi = client.multi()
  pendingWorksCategories.forEach(pendingWork => multi.SMEMBERS(pendingWork))
  const pendingWorks = ((await multi.exec()) as string[][]) || []
  const totalPendingWorks = pendingWorks.reduce(
    (acc, pendingWork) => acc + pendingWork.length,
    0
  )
  // roughly wait for pending works to prevent infinite loop
  return new Promise(resolve =>
    setTimeout(resolve, Math.ceil(totalPendingWorks / averageSpeed) * 1000)
  )
}
