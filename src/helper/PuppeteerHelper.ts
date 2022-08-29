import { Browser } from 'puppeteer'
import puppeteer from 'puppeteer-extra'
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { log, randomUA } from '../utils'

let browser: Browser

puppeteer.use(AdblockerPlugin({ blockTrackers: true })).use(StealthPlugin())

export async function initiateBrowser() {
  const isProduction = process.env.NODE_ENV === 'production'
  const proxy = process.env.HTTP_PROXY
  const args = ['--disable-dev-shm-usage', '--no-sandbox']
  if (isProduction && proxy) {
    args.push(`--proxy-server=${proxy}`)
  }
  try {
    browser = await puppeteer.launch({
      defaultViewport: null,
      executablePath: isProduction
        ? process.env.PUPPETEER_EXECUTABLE_PATH
        : puppeteer.executablePath(),
      args,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-gpu'
      ]
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
