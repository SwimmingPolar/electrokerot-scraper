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
  let total = 0;
  for await (const category of categories) {
    const collection = client.db(process.env.DB_NAME).collection(category);
    const result = await collection.countDocuments({
      isUpdating: false,
      updatedAt: {
        $lt: new Date(new Date().setHours(13, 0, 0, 0)),
      },
    });
    total += result;
  }
  console.log(total);
  process.exit(0);
})();
