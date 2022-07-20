import fs from 'fs'

interface Filter {
  name: string
  type: string
  value: string
}

interface Category {
  category: string
  categoryNumber: string
  start: string
  end?: string
  range?: string[]
  filters: Filter[]
}

interface ScrapConfig {
  baseUrl: string
  minimumDate?: Date
  ignoreWords?: string[]
  categories: Category[]
}

function getFilters() {
  const file = fs.readFileSync('config/scrapConfig.json', {
    encoding: 'utf8'
  })
  const config: ScrapConfig = JSON.parse(file)

  const { filters, categoryNumber } = config.categories[5]

  const filters = filters.map(
    ({ type, value }) =>
      `${type === 'maker' ? '#searchMaker' : '#searchAttributeValue'}${value}`
  )

  return { filters, categoryNumber }
}
