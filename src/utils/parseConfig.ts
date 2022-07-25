import fs from 'fs'
import initiateBrowser, { getPages } from './getPages'
import { getRedisClient } from './RedisHelper'
import log from './logger'

interface ScrapConfig {
  baseUrl: string
  minimumDate?: string
  ignoreWords?: string[]
  categories: Category[]
}

interface Category {
  category: string
  categoryNumber: string
  start?: string
  end?: string
  minimumDate?: string
  ignoreWords?: string[]
  filters?: Filter[]
}

interface Filter {
  name: string
  type: string
  value: string
}

export interface CategoryMeta {
  categoryNumber: string
  minimumDate?: string
  ignoreWords?: string[]
  filters?: string[]
}

export default async function parseConfig() {
  const client = await getRedisClient()
  const browser = await initiateBrowser()

  try {
    const configFilePath = process.env.CONFIG_PATH || 'config/scrapConfig.json'
    const configFile = fs.readFileSync(configFilePath, {
      encoding: 'utf8'
    })
    const config: ScrapConfig = JSON.parse(configFile)
    const { baseUrl, minimumDate, ignoreWords, categories } = config
    await client.SET('baseUrl', baseUrl)

    // PARSE each categories
    await Promise.allSettled(
      categories.map(async (category, i) => {
        const { category: categoryName } = category
        const { categoryNumber, filters = [] } = category
        // override minimumDate if specified in category
        const minimumDateOverride = !!minimumDate
          ? minimumDate
          : category.minimumDate

        // merge ignoreWords with ignoreWords in category
        const ignoreWordsMerged =
          ignoreWords?.concat(category.ignoreWords || []) || []

        // stringify filters
        const stringifiedFilters = filters.map(
          ({ type, value }) =>
            `${
              type === 'maker' ? '#searchMaker' : '#searchAttributeValue'
            }${value}`
        )

        const categoryMeta = {
          categoryNumber,
          minimumDate: minimumDateOverride,
          ignoreWords: ignoreWordsMerged,
          filters: stringifiedFilters
        }
        // set category meta to redis as strinified JSON
        await client.SET(categoryName, JSON.stringify(categoryMeta))

        let { start = '1', end } = category
        // if end is not defined, scrap all pages
        if (!end || end === '*') {
          end = await getPages({
            baseUrl,
            categoryNumber,
            filters: stringifiedFilters
          })
        }

        // split each page index into chunks and shuffle order
        const pages = Array.from(
          { length: +end - +start + 1 },
          (_, i) => +start + i + ''
        ).sort(() => Math.random() * 0.5)

        await client
          .multi()
          .SADD('categories', categoryName)
          .SADD(`pages:${categoryName}`, pages)
          .exec()
      })
    )
  } catch (error) {
    log.error('ParseConfig', error + '')
  } finally {
    browser.close()
  }
}
