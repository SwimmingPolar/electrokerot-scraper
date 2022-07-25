import { getRedisClient } from './RedisHelper'
import { getDb } from './MongodbHelper'

export default async function () {
  const client = await getRedisClient()

  // get pending categories and delete them from redis
  const [pendingCategories] =
    ((await client
      .multi()
      .SMEMBERS('pendingCategories')
      .DEL('pendingCategories')
      .exec()) as [string[]]) || []

  // add pending pages to each category
  pendingCategories.forEach(async category => {
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
      .SMEMBERS('pendingItemsCategories')
      .DEL('pendingItemsCategories')
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
            _id: item
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
