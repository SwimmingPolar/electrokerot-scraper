import { createClient } from 'redis'
import log from 'utils/logger'

const client = createClient({
  password: process.env.REDIS_PASSWORD
})

let isInitialized = false

export default async function initiateRedisClient() {
  try {
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
