import { getRedisClient } from './redisHelper'
import { getDb } from './mongoHelper'

export default async function () {
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
  pendingItemsCategories.forEach(async category => {
    const collection = db.collection(category)

    const [pendingItems] = (await client
      .multi()
      .SMEMBERS(`pendingItems:${category}`)
      .DEL(`pendingItems:${category}`)
      .exec()) as [string[]]

    await collection.bulkWrite(
      pendingItems.map(item => ({
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
}
