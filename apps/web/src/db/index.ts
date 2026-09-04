import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";
import { webEnv } from "@/env/web";

function createDb() {
	const pool = mysql.createPool(webEnv.DATABASE_URL);
	return drizzle(pool, { schema, mode: "default" });
}

let _db: ReturnType<typeof createDb> | null = null;

function getDb(): ReturnType<typeof createDb> {
	if (!_db) {
		_db = createDb();
	}

	return _db;
}

export const db = getDb();

export * from "./schema";
