import dotenv from "dotenv";
dotenv.config({
  path: "../config/scraper/.env",
});
import { MongoClient } from "mongodb";

const categories = [
  "cpu",
  "mainboard",
  "memory",
  "graphics",
  "ssd",
  "hdd",
  "case",
  "power",
  "cooler",
];
(async () => {
  const client = await new MongoClient(process.env.MONGODB_URL).connect();
  // const client = await new MongoClient("mongodb://127.0.0.1:27017").connect();
  for await (const category of categories) {
    const collection = client.db(process.env.DB_NAME).collection(category);
    await collection.updateMany(
      {},
      {
        $set: {
          isUpdating: false,
          updatedAt: new Date(new Date().setHours(13, 0, 0, 0)),
        },
      }
    );
  }
  process.exit(0);
})();
