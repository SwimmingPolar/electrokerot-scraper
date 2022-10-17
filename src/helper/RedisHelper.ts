import { createClient } from 'redis'
import { log, useCleanup } from '../utils'

let client: ReturnType<typeof createClient>

let isInitialized = false

export async function initiateRedisClient() {
  try {
    client = createClient({
      url: process.env.REDIS_URL?.trim(),
      password: process.env.REDIS_PASSWORD?.trim()
    })
    await client.connect()
    client.on('error', async () => {
      await initiateRedisClient()
    })

    useCleanup(async () => {
      await client.quit()
    })
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
