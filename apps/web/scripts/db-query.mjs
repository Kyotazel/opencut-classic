#!/usr/bin/env node
// Pembantu query manual: node scripts/db-query.mjs "SELECT ..."
// Dipakai untuk verifikasi cepat tanpa membuka klien MySQL.
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = raw.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const conn = await mysql.createConnection(url);
const sql = process.argv.slice(2).join(" ");
const [rows] = await conn.query(sql);
console.log(JSON.stringify(rows, null, 2));
await conn.end();
