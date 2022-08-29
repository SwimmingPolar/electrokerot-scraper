import { Db, MongoClient } from 'mongodb'
import { log, useCleanup } from '../utils'

let mongoClient: MongoClient
let db: Db

export async function initiateMongoClient() {
  try {
    const { MONGODB_URL = '' } = process.env
    mongoClient = await new MongoClient(MONGODB_URL).connect()

    const DB_NAME = process.env.DB_NAME || 'default_db'
    db = mongoClient.db(DB_NAME)

    useCleanup(async () => {
      await mongoClient.close()
    })
  } catch (error) {
    log.error('MongodbHelper', error + ', exiting')
    process.exit(1)
  }
}

export async function getMongoClient() {
  if (!mongoClient) {
    await initiateMongoClient()
  }
  return mongoClient
}

export async function getDb() {
  if (!mongoClient || !db) {
    await initiateMongoClient()
  }
  return db
}
