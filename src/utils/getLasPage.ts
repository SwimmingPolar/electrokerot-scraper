import { Browser } from 'puppeteer'
import puppeteer from 'puppeteer-extra'
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import log from './logger'
import randomUserAgent from './randomUserAgent'

let browser: Browser

puppeteer.use(AdblockerPlugin({ blockTrackers: true })).use(StealthPlugin())

export default async function initiateBrowser() {
  // execution context
  const isProduction = process.env.NODE_ENV === 'production'
  const proxy = process.env.HTTP_PROXY
  const args = ['--disable-dev-shm-usage', '--no-sandbox']
  if (isProduction && proxy) {
    args.push(`--proxy-server=${proxy}`)
  }
  // different config for execution context
  const puppeteerConfig = {
    defaultViewport: null,
    headless: isProduction ? true : false,
    executablePath: isProduction
      ? process.env.PUPPETEER_EXECUTABLE_PATH
      : puppeteer.executablePath(),
    args
  }

  if (!browser) {
    try {
      browser = await puppeteer.launch(puppeteerConfig)
      // re-open browser in case it crashes
      browser.on('disconnected', async () => {
        await initiateBrowser()
      })
    } catch (error) {
      log.error('PuppeteerHelper', error + '')
    }
  }
  return browser
}

export async function getLastPage({
  baseUrl,
  categoryNumber,
  filters = []
}: {
  baseUrl: string
  categoryNumber: string
  filters: string[]
}) {
  if (!browser) {
    await initiateBrowser()
  }
  const page = await browser.newPage()

  try {
    await page.setUserAgent(randomUserAgent())
    /**
     * GOTO the target page
     */
    await page.goto(`${baseUrl}${categoryNumber}`, {
      timeout: 120000,
      waitUntil: 'networkidle2'
    })

    /**
     * APPLY optional filters
     */
    // disconnect network to prevent redundant http requests
    if (filters && filters.length > 0) {
      // open filters
      await page.waitForSelector(
        '#frmProductList > div.option_nav > div.nav_header > div.head_opt > button',
        {
          timeout: 120000
        }
      )
      await page.click(
        '#frmProductList > div.option_nav > div.nav_header > div.head_opt > button'
      )
      await page.waitForSelector('#extendSearchOptionpriceCompare', {
        timeout: 120000
      })
      // disconnect network to prevent redundant http requests
      await page.setOfflineMode(true)
      filters.forEach(async (filter, index) => {
        // re-establish network connection
        if (filters.length - 1 === index) {
          await page.waitForTimeout(1500)
          await page.setOfflineMode(false)
        }
        await page.evaluate(filter => {
          const checkbox = document.querySelector<HTMLInputElement>(filter)
          checkbox?.click()
        }, filter)
      })
    }

    /**
     * SHOW 90 items per page
     */
    await page.waitForSelector(
      '#productListArea > div.prod_list_opts > div.view_opt > div.view_item.view_qnt > select',
      {
        timeout: 120000
      }
    )
    await page.select(
      '#productListArea > div.prod_list_opts > div.view_opt > div.view_item.view_qnt > select',
      '90'
    )

    /**
     * GOTO the last possible page
     */
    let IsNextPageAvailable = false
    do {
      const contentSelector = '.main_prodlist.main_prodlist_list'
      const nextButtonSelector =
        '#productListArea > div.prod_num_nav > div > a.nav_next'
      IsNextPageAvailable = await page.evaluate(
        (contentSelector, nextButtonSelector) => {
          document.querySelector<HTMLDivElement>(`${contentSelector}`)?.remove()
          // if there is next page, click it
          const nextButton =
            document.querySelector<HTMLAnchorElement>(nextButtonSelector)
          nextButton?.click()

          // if there is no next page, return false
          return !!document.querySelector<HTMLAnchorElement>(nextButtonSelector)
        },
        contentSelector,
        nextButtonSelector
      )

      // wait for the next page to load if there is one
      if (IsNextPageAvailable) {
        await page.waitForSelector(contentSelector, {
          timeout: 120000
        })
      }

      // each tab/page will wait for 0~3 seconds to avoid too many requests
      await page.waitForTimeout(1000 * Math.random() * 5)
    } while (IsNextPageAvailable)

    // CLICK last page
    const contentSelector = '.main_prodlist.main_prodlist_list'
    // click and return the last page number
    const lastPageNumber = await page.evaluate(contentSelector => {
      document.querySelector<HTMLDivElement>(`${contentSelector}`)?.remove()
      const lastPage = document.querySelector<HTMLAnchorElement>(
        '#productListArea > div.prod_num_nav > div > div > a:last-child'
      )
      lastPage?.click()

      return lastPage?.textContent || '1'
    }, contentSelector)

    // wait for the last page to load
    await page.waitForSelector(contentSelector, {
      timeout: 120000
    })

    const itemsLengthInLastPage = await page.evaluate(() => {
      return (
        document.querySelectorAll<HTMLLIElement>(
          '#productListArea > div.main_prodlist.main_prodlist_list > ul > li.prod_item.prod_layer[id^=productItem]'
        ).length || 0
      )
    })

    // total items in the category
    const totalItems = (+lastPageNumber - 1) * 90 + itemsLengthInLastPage

    // total pages in the category
    return Math.ceil(totalItems / 30) + ''
  } finally {
    await page.close()
  }
}
