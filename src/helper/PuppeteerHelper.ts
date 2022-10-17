import puppeteer, { Browser } from 'puppeteer'
import { log, randomUA } from '../utils'

let browser: Browser

export async function initiateBrowser() {
  const isProduction = process.env.NODE_ENV?.trim() === 'production'
  const proxy = process.env.HTTP_PROXY?.trim()
  const args = ['--disable-dev-shm-usage', '--no-sandbox']
  if (isProduction && proxy) {
    args.push(`--proxy-server=${proxy}`)
  }

  try {
    browser = await puppeteer.launch({
      defaultViewport: null,
      executablePath: isProduction
        ? process.env.PUPPETEER_EXECUTABLE_PATH?.trim()
        : puppeteer.executablePath(),
      args
    })

    // re-open browser in case it crashes
    browser.on('disconnected', async () => {
      await initiateBrowser()
    })
  } catch (error) {
    log.error('PuppeteerHelper', error + '')
    process.exit(1)
  }
}

export async function getBrowser() {
  if (!browser) {
    await initiateBrowser()
  }
  return browser
}

export async function getPage() {
  const page = await (await getBrowser()).newPage()
  page.setUserAgent(randomUA())
  return page
}
