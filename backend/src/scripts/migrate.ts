import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "../services/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = await readFile(path.join(__dirname, "../../migrations/001_initial.sql"), "utf8");

await getDatabase().query(migration);
await getDatabase().end();
console.log("Database migration 001_initial.sql applied.");
