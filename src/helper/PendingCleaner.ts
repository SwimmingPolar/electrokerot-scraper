import { AnyBulkWriteOperation } from 'mongodb'
import { getDb, getRedisClient } from '../helper'

export async function pendingCleaner() {
  const client = await getRedisClient()
  // get pending categories and delete them from redis
  const [pendingPagesCategories] =
    ((await client
      .multi()
      .SMEMBERS('pendingPages')
      .DEL('pendingPages')
      .exec()) as [string[]]) || []

  // add pending pages to each category
  pendingPagesCategories.forEach(async category => {
    const [pendingPages] = (await client
      .multi()
      .SMEMBERS(`pendingPages:${category}`)
      .DEL(`pendingPages:${category}`)
      .exec()) as [string[]]

    await client
      .multi()
      .SADD('categories', category)
      .SADD(`pages:${category}`, pendingPages)
      .exec()
  })

  // get pending items
  const [pendingItemsCategories] =
    ((await client
      .multi()
      .SMEMBERS('pendingItems')
      .DEL('pendingItems')
      .exec()) as [string[]]) || []

  // reset isUpdating to false for each item
  const db = await getDb()
  const collection = db.collection('parts')
  const query = [] as AnyBulkWriteOperation[]
  pendingItemsCategories.forEach(async category => {
    // delete pending items from redis
    const [pendingItems] = (await client
      .multi()
      .SMEMBERS(`pendingItems:${category}`)
      .DEL(`pendingItems:${category}`)
      .exec()) as [string[]]

    // push query string which will reset isUpdating to false for each item
    query.push(
      ...pendingItems.map(item => ({
        updateOne: {
          filter: {
            _id: item,
            isUpdating: true
          },
          update: {
            $set: {
              isUpdating: false
            }
          }
        }
      }))
    )
  })
  // execute query
  if (query.length !== 0) {
    await collection.bulkWrite(query)
  }
}
