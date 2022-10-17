import { getBrowser } from '../helper'

const TIMEOUT = 120000

export async function pageIndexParser({
  baseUrl,
  categoryNumber,
  filters = []
}: {
  baseUrl: string
  categoryNumber: string
  filters: string[]
}) {
  const browser = await getBrowser()
  const page = await browser.newPage()

  try {
    /**
     * GOTO the target page
     */
    await page.goto(`${baseUrl}${categoryNumber}`, {
      timeout: TIMEOUT,
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
          timeout: TIMEOUT
        }
      )
      await page.click(
        '#frmProductList > div.option_nav > div.nav_header > div.head_opt > button'
      )
      await page.waitForSelector('#extendSearchOptionpriceCompare', {
        timeout: TIMEOUT
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
        timeout: TIMEOUT
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
          timeout: TIMEOUT
        })
      }

      // each tab/page will wait for 1~3 seconds to avoid too many requests
      await page.waitForTimeout(1000 * Math.ceil(Math.random() * 3))
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
      timeout: TIMEOUT
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
