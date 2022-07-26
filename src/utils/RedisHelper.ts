import { createClient } from 'redis'
import log from 'utils/logger'

let client: ReturnType<typeof createClient>

let isInitialized = false

export default async function initiateRedisClient() {
  try {
    client = createClient({
      password: process.env.REDIS_PASSWORD
    })
    await client.connect()
  } catch (error) {
    log.error('RedisHelper', 'Error connecting to redis, exiting')
    process.exit(1)
  }
}

export async function getRedisClient() {
  if (!isInitialized) {
    await initiateRedisClient()
    isInitialized = true
  }
  return client
}
