import dotenv from 'dotenv'
dotenv.config({
  path: 'config/dev.env'
})
import { getRedisClient } from 'utils/RedisHelper'
import parseConfig, { CategoryMeta } from './utils/parseConfig'
import handlePending from './utils/handlePending'
import log from 'utils/logger'
import fetch from 'node-fetch'
import retry from 'utils/retry'

// ignore prettier
import { WatchError } from 'redis'
;(async () => {
  try {
    const client = await getRedisClient()

    const status = await client.GET('status')
    // if status is done, exit the program (container will go down and reset redis if correctly configured)
    if (status === 'done') {
      log.error('ScrapperMain', 'Scrapper is already done')
      process.exit(0)
    }
    // if status is not running, parse config (fresh start)
    if (status !== 'running') {
      await parseConfig()
    }
    // set status to running
    await client.SET('status', 'running')

    // move pending work to current work range
    try {
      await handlePending()
    } catch (error) {
      log.error('HandlePending', error + '')
    }

    /**
     * START PAGE SCRAPPING
     */
    const baseUrl = (await client.GET('baseUrl')) || ''
    if (!baseUrl) {
      log.error('ScrapperMain', 'BaseUrl is not set')
      process.exit(1)
    }
    let categoriesLength: number
    do {
      // check if there are categories to parse
      const categories = await client.SMEMBERS('categories')
      categoriesLength = categories.length

      // if there is no categories left to scrap, move on to next stage
      if (categoriesLength === 0) {
        break
      }

      // random category to scrap
      const category = (await client.SRANDMEMBER('categories')) || ''

      // get pages to scrap
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
                log.error('ScrapperMain1', error + '')
              }
            }
          })()
        })
      })()

      // send request to scrap pages
      await new Promise<void>((resolve, _) => {
        ;(async function request() {
          retry(fetch)('http://localhost:10000/updatePages', {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category,
              url: baseUrl + categoryNumber,
              pages,
              minimumDate,
              ignoreWords,
              filters
            })
          }).then(async response => {
            const status = response.status
            const result = (await response.json()) as { keepGoing: boolean }

            // if server is busy and keepGoing is false, try again
            if (status === 503 && result.keepGoing === false) {
              setTimeout(request, 0)
            }
            // if server is not busy and keepGoing is true, keep requesting pages to be scrapped
            else {
              resolve()
            }
          })
        })()
      })
    } while (categoriesLength > 0)

    // wait for all pending work to be done
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
    // exit the program
    // container will go down and running status will be reset if correctly configured
    // indicating that the scrapper is ready to start again on next restart
    await client.SET('status', 'done')
    log.info('Scrapper is done and exiting')
  } catch (error) {
    log.error('ScrapperMain', error + '')
  }
})()
