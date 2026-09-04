# Server Sync + Shared Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project + media tersimpan di server (source of truth), bisa dibuka dari browser mana pun, diproteksi 1 login shared.

**Architecture:** IndexedDB/OPFS tetap dipakai editor. Sync di batas: pull saat open (server lebih baru), push best-effort di ekor `saveCurrentProject` (debounce 800ms existing). Session cookie HMAC via middleware. Tanpa bedah inti editor.

**Tech Stack:** Next.js middleware (Edge, WebCrypto subtle only), route handlers, drizzle-orm mysql2, bun:test.

## Global Constraints

- Bahasa balasan ke user: Indonesia, ringkas.
- Tidak ada tool `apply_patch`: tulis file via heredoc `cat >` / `python3` lewat `exec_command`.
- Test DB WAJIB: `bun --env-file=.env.local test src/klip/__tests__/` dari `apps/web`.
- `bun -e` debug WAJIB diakhiri `process.exit(0)`.
- `drizzle-kit migrate` RUSAK di env ini (gagal diam-diam, pre-existing): generate via
  `bun run db:generate`, apply manual via `mysql --protocol=TCP -h 127.0.0.1 -u root klip < file.sql`
  (root tanpa password di TCP lokal, sudah terbukti), JANGAN `db:push` (butuh TTY).
- Env baru WAJIB `.optional()` di `src/env/web.ts`; JANGAN commit nilai secret.
- `src/klip/auth-session.ts` HANYA boleh pakai WebCrypto (`crypto.subtle`) karena dipakai
  middleware Edge (node:crypto tidak tersedia di Edge).
- Gaya kode: object-param tunggal (rule `opencut/prefer-object-params`), tanpa type assertion
  `as` (rule `no-unsafe-type-assertion`), parsing JSON via guard `isRecord`-style.
- Login rate-limit in-memory (Map) cukup (single instance dev).

---

## File Structure

- Create: `apps/web/src/klip/auth-session.ts` — HMAC session (isomorphic subtle).
- Test: `apps/web/src/klip/__tests__/auth-session.test.ts`.
- Modify: `apps/web/src/env/web.ts` — `APP_USER`, `APP_PASSWORD`, `APP_SESSION_KEY` opsional.
- Create: `apps/web/src/middleware.ts` — proteksi semua kecuali `/`, `/api/auth/login`, `/_next`, statis.
- Create: `apps/web/src/app/api/auth/login/route.ts`, `logout/route.ts`, `me/route.ts`.
- Modify: `apps/web/src/db/schema.ts` — `klipSyncProjects`, `klipSyncMedia`.
- Generate: `apps/web/migrations/0004_*.sql` via generate; apply manual.
- Create: `apps/web/src/app/api/sync/projects/route.ts` (GET list meta).
- Create: `apps/web/src/app/api/sync/projects/[id]/route.ts` (GET full, PUT upsert + 409).
- Create: `apps/web/src/app/api/sync/projects/[id]/media/route.ts` (GET list, POST upload).
- Create: `apps/web/src/app/api/sync/media/[assetId]/route.ts` (GET stream file).
- Modify: `apps/web/src/services/storage/service.ts` — tambah `getSerializedProject`, `putSerializedProject`.
- Create: `apps/web/src/klip/sync.ts` — `pullProject`, `pushProject`, base tracking localStorage.
- Modify: `apps/web/src/app/page.tsx` — ganti landing jadi form login (client component).
- Modify: editor page open (`apps/web/src/app/editor/[project_id]/page.tsx`) — pull-before-open.
- Modify: `apps/web/src/core/managers/project-manager.ts` `saveCurrentProject` — push best-effort di ekor.
- Modify: `apps/web/src/app/projects/page.tsx` — tombol "Upload ke server" + tombol Logout.
- Test: `apps/web/src/klip/__tests__/sync-api.test.ts`.

---

### Task 1: Session HMAC + env

**Files:**
- Modify: `apps/web/src/env/web.ts`
- Create: `apps/web/src/klip/auth-session.ts`
- Test: `apps/web/src/klip/__tests__/auth-session.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `createSession({keyHex}: ...): Promise<string>` (`expiry.hmacHex`),
  `verifySession({cookie,keyHex}: ...): Promise<{user:string}|null>`,
  `SESSION_COOKIE = "klip_session"`, `SESSION_DAYS = 30` untuk Task 2.

- [ ] **Step 1: Tambah env**

```ts
APP_USER: z.string().optional(),
APP_PASSWORD: z.string().optional(),
APP_SESSION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
```

- [ ] **Step 2: Test dulu**

```ts
import { describe, expect, test } from "bun:test";
import { createSession, verifySession } from "@/klip/auth-session";

const KEY = "ef".repeat(32);

describe("auth-session", () => {
	test("roundtrip valid", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie, keyHex: KEY })).toEqual({ user: "ordo" });
	});
	test("tampered ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie: `${cookie}x`, keyHex: KEY })).toBeNull();
	});
	test("expired ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo", daysValid: -1 });
		expect(await verifySession({ cookie, keyHex: KEY })).toBeNull();
	});
	test("key salah ditolak", async () => {
		const cookie = await createSession({ keyHex: KEY, user: "ordo" });
		expect(await verifySession({ cookie, keyHex: "00".repeat(32) })).toBeNull();
	});
});
```

- [ ] **Step 3: Run, pastikan FAIL** (`bun --env-file=.env.local test src/klip/__tests__/auth-session.test.ts`, ekspektasi Cannot find module).

- [ ] **Step 4: Implementasi** (WebCrypto saja):

```ts
export const SESSION_COOKIE = "klip_session";
export const SESSION_DAYS = 30;

async function hmacKey({ keyHex }: { keyHex: string }): Promise<CryptoKey> {
	const raw = Uint8Array.from(Buffer.from(keyHex, "hex"));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toHex({ bytes }: { bytes: ArrayBuffer }): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession({ keyHex, user, daysValid }: { keyHex: string; user: string; daysValid?: number }): Promise<string> {
	const expiry = Date.now() + (daysValid ?? SESSION_DAYS) * 86400 * 1000;
	const payload = `${user}:${expiry}`;
	const sig = await crypto.subtle.sign("HMAC", await hmacKey({ keyHex }), new TextEncoder().encode(payload));
	return `${expiry}.${toHex({ bytes: sig })}`;
}
```

`verifySession`: split `.`, cek expiry > now, recompute, compare byte-wise (loop + accumulasi, bukan `===` early-return), return `{ user: "ordo" }` (user tunggal, hardcode di pemanggil? Lebih baik: payload `${user}:${expiry}` dan user dicek == APP_USER di route login/me; modul session generik atas user apa pun).

- [ ] **Step 5: Run hijau + commit** (`feat(klip): hmac session helpers`).

---

### Task 2: Login/logout/me + middleware + halaman root

**Files:**
- Create: `apps/web/src/middleware.ts`
- Create: `apps/web/src/app/api/auth/login/route.ts`, `logout/route.ts`, `me/route.ts`
- Modify: `apps/web/src/app/page.tsx`

**Interfaces:**
- Consumes: Task 1.
- Produces: proteksi global + `/` form login untuk Task 6-7.

- [ ] **Step 1: `src/middleware.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/klip/auth-session";

export function middleware(request: NextRequest) {
	return NextResponse.next();
}
```

ISI REAL: baca cookie, jika path `/` biarkan; jika path diawali `/api/auth/login` biarkan; jika session valid -> next; jika halaman -> redirect `/`; jika `/api/*` -> 401 JSON. Key dari `process.env.APP_SESSION_KEY`; jika key belum dipasang -> tolak semua kecuali `/` dengan 503 JSON/pesan (jangan crash). Matcher:

```ts
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"] };
```

- [ ] **Step 2: `POST /api/auth/login`** — body `{ username, password }` (unknown-guard, tanpa `as`); bandingkan dengan env (jika env kosong -> 503 "belum dikonfigurasi"); rate-limit Map per IP (10/menit, 429); sukses -> set cookie httpOnly, sameSite lax, maxAge 30 hari, path `/`. Gagal -> 401 generik "Username/password salah" (jangan bedakan).

- [ ] **Step 3: `POST /api/auth/logout`** (hapus cookie), **`GET /api/auth/me`** (200 `{ user }` / 401).

- [ ] **Step 4: `src/app/page.tsx`** — ganti total jadi `"use client"` form login (username, password, submit -> POST login -> `window.location.href = "/projects"`, error text). Tanpa export `metadata` (client component). Hapus import landing yang tak terpakai.

- [ ] **Step 5: Test route pola existing + lint + commit** (`feat(klip): shared login + middleware`).
  Test: login sukses set cookie (baca header `set-cookie`), salah -> 401, tanpa env -> 503, me tanpa cookie -> 401. Rate-limit: 11x cepat -> 429 (loop 11 POST).

---

### Task 3: Skema sync + migrasi

**Files:**
- Modify: `apps/web/src/db/schema.ts`
- Generate: `apps/web/migrations/0004_*.sql`, apply MANUAL.

**Interfaces:**
- Consumes: pola FK cascade inline existing.
- Produces: `klipSyncProjects`, `klipSyncMedia` untuk Task 4.

- [ ] **Step 1: Tambah skema**

```ts
export const klipSyncProjects = mysqlTable("klip_sync_projects", {
	id: varchar("id", { length: 64 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	data: text("data", { mode: "text" }).notNull(),
	createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});
export type KlipSyncProject = typeof klipSyncProjects.$inferSelect;

export const klipSyncMedia = mysqlTable("klip_sync_media", {
	id: varchar("id", { length: 128 }).primaryKey(),
	projectId: varchar("project_id", { length: 64 }).notNull()
		.references(() => klipSyncProjects.id, { onDelete: "cascade" }),
	filePath: varchar("file_path", { length: 1024 }).notNull(),
	mime: varchar("mime", { length: 128 }).notNull(),
	size: int("size").notNull(),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});
export type KlipSyncMedia = typeof klipSyncMedia.$inferSelect;
```

CATATAN: `data` LONGTEXT — drizzle `text` MySQL default TEXT (64KB, kekecilan untuk timeline). Cek: jika `text("data")` generate `text` (bukan longtext), ubah kolom manual di SQL hasil generate menjadi `longtext` SEBELUM apply (timeline bisa >1MB). Verifikasi via `SHOW COLUMNS`.

- [ ] **Step 2: Generate + apply manual + verifikasi longtext**

```bash
cd /Users/oktaariaditya/ordo/klip-opencut/apps/web
bun run db:generate
# cek + perbaiki longtext bila perlu, lalu:
mysql --protocol=TCP -h 127.0.0.1 -u root klip < migrations/0004_xxxx.sql
mysql --protocol=TCP -h 127.0.0.1 -u root klip -e "SHOW TABLES LIKE 'klip_sync%'; SHOW COLUMNS FROM klip_sync_projects LIKE 'data';"
```

- [ ] **Step 3: Commit** (`feat(klip): sync tables schema`).

---

### Task 4: API sync

**Files:**
- Create: `apps/web/src/app/api/sync/projects/route.ts`
- Create: `apps/web/src/app/api/sync/projects/[id]/route.ts`
- Create: `apps/web/src/app/api/sync/projects/[id]/media/route.ts`
- Create: `apps/web/src/app/api/sync/media/[assetId]/route.ts`
- Test: `apps/web/src/klip/__tests__/sync-api.test.ts`

**Interfaces:**
- Consumes: Task 3. Auth dicek middleware (route tidak cek session sendiri).
- Produces: endpoint untuk Task 5-7.

- [ ] **Step 1: `GET /api/sync/projects`** -> `{ projects: [{ id, name, updatedAt }] }` (tanpa blob).

- [ ] **Step 2: `[id]/route.ts`** —
  GET: 404 jika tak ada; return `{ id, name, data, updatedAt }` (`data` = string JSON apa adanya).
  PUT: body `{ name: string, data: string (JSON, validasi JSON.parse bisa, maks 50MB via cek length), baseUpdatedAt: string|null }`.
  Jika row tak ada -> insert (base diabaikan). Jika ada dan `baseUpdatedAt` американ null dan `new Date(base) < row.updatedAt` -> 409 `{ serverUpdatedAt }`. Else update + return `{ updatedAt }`.

- [ ] **Step 3: `[id]/media/route.ts`** —
  GET: butuh project ada (404 jika tak ada); return `{ media: [{ id, mime, size, updatedAt }] }`.
  POST multipart: field `assetId` (string, cocokkan `^[A-Za-z0-9_-]{1,128}$`), `file` (<=500MB). Project harus ada (409 jika belum, suruh PUT project dulu). Simpan ke `sync-media/{projectId}/{assetId}` + nama file aman (sanitize: buang path, hanya basename; simpan dengan nama `{assetId}` + ekstensi dari mime map aman: mp4/webm/mov/png/jpg/jpeg/webp/mp3/wav/m4a/ogg, else `.bin`). Upsert row. Return `{ id, size }`.

- [ ] **Step 4: `media/[assetId]/route.ts` GET** — cari row (404 jika tak ada); stream file via `createReadStream` -> `Response` node (route handlers Node runtime default; set `content-type` dari row.mime, `cache-control: public, max-age=31536000, immutable`); 404 jika file hilang di disk (sekaligus hapus row yatim).

- [ ] **Step 5: Test (DB real + cleanup pola template-api.test.ts)** —
  PUT baru -> 200; PUT dengan base lama -> 409; GET list tanpa blob (assert tidak ada key `data`); upload media lalu GET stream byte-identik; media ke project tak ada -> 404/409; nama asset jahat (`../x`) -> 400.
  Lint + hijau + commit (`feat(klip): sync api`).

---

### Task 5: StorageService hooks + modul sync.ts

**Files:**
- Modify: `apps/web/src/services/storage/service.ts`
- Create: `apps/web/src/klip/sync.ts`

**Interfaces:**
- Consumes: Task 4, `storageService` (`saveMediaAsset`, `loadMediaAsset`, `loadAllMediaAssets`, `loadAllProjectsMetadata`).
- Produces: `pullProject({id})`, `pushProject({id})`, `getSyncBase/setSyncBase` untuk Task 6-7.

- [ ] **Step 1: Tambah 2 method publik di StorageService** (bungkus `projectsAdapter` yang private):

```ts
async getSerializedProject({ id }: { id: string }): Promise<SerializedProject | null> {
	return this.projectsAdapter.get(id);
}
async putSerializedProject({ project }: { project: SerializedProject }): Promise<void> {
	await this.projectsAdapter.set({ key: project.id, value: project });
}
```

Cek signature `StorageAdapter` (`get(key)`, `set({key,value})`) di `types.ts` sebelum tulis; sesuaikan. `SerializedProject` harus punya `id` (verifikasi di `types.ts`; jika key berbeda, pakai key yang benar).

- [ ] **Step 2: `src/klip/sync.ts`** —

```ts
export function getSyncBase({ id }: { id: string }): string | null {
	try { return localStorage.getItem(`klip_sync_base:${id}`); } catch { return null; }
}
export function setSyncBase({ id, updatedAt }: { id: string; updatedAt: string }): void {
	try { localStorage.setItem(`klip_sync_base:${id}`, updatedAt); } catch { /* abaikan */ }
}
```

`pullProject({id})`: GET project server (404 -> return `{ pulled: false }`); GET daftar media server; `putSerializedProject` (JSON.parse dari `data`); untuk tiap media server: cek `loadMediaAsset` lokal, jika null -> GET stream -> `new File([bytes], name?, {type: mime})` -> `saveMediaAsset` (metadata name = asset id, type dari mime: video|image|audio via map, else skip dengan hitung). `setSyncBase`. Return `{ pulled: true, skippedMedia: n }`.
`pushProject({id})`: ambil serialized lokal (`getSerializedProject`, null -> throw "project tidak ada di browser ini"); PUT `{ name: metadata.name, data: JSON.stringify(serialized), baseUpdatedAt: getSyncBase() }`; jika 409 -> throw `SyncConflictError` (class dengan `serverUpdatedAt`); GET media server -> `loadAllMediaAssets` lokal -> upload yang id-nya belum ada (POST multipart per file, nama file = asset id + ekstensi asal `mediaAsset.file.name`); `setSyncBase` dari respons. Return `{ updatedAt }`.
Parsing respons server: guard `isRecord`, tanpa `as`.

- [ ] **Step 3: Unit test + commit** (`feat(klip): sync pull push client`).
  Test: base get/set (mock localStorage implisit jsdom? bun test tanpa DOM — `localStorage` tak ada! Bungkus akses dengan `typeof localStorage === "undefined"` guard di implementasi (sudah ada try/catch tapi referensi `localStorage` tetap ReferenceError). Perbaiki: `const store = globalThis as ...` — tanpa `as`? Gunakan `typeof (globalThis as ...)`. Hmm tanpa assertion: `if (typeof localStorage === "undefined") return null;` — `typeof` guard pada identifier tak dikenal itu LEGAL dan tidak throw. Jadi: `if (typeof localStorage === "undefined") return null;` sebelum pakai. Test: set/get konsisten + aman saat tak ada (bun env) — di bun, `typeof localStorage` = "undefined" -> get null, set no-op. Assert itu.)

---

### Task 6: Pasang di open + save + tombol migrasi + logout

**Files:**
- Modify: `apps/web/src/app/editor/[project_id]/page.tsx` (cek nama folder exact: `[project_id]` vs `[project-id]`)
- Modify: `apps/web/src/core/managers/project-manager.ts`
- Modify: `apps/web/src/app/projects/page.tsx`
- (Opsional, 1 baris tiap file) tombol Logout di header editor.

**Interfaces:**
- Consumes: Task 5.

- [ ] **Step 1: Pull-before-open** — di editor page, sebelum `loadProject` lokal: fetch `GET /api/sync/projects/[id]`; jika 200 dan (lokal tak ada ATAU `server.updatedAt > lokal.metadata.updatedAt`): `pullProject` lalu lanjutkan load lokal. Bungkus try/catch: gagal sync -> lanjut lokal + toast "Sync gagal, pakai data lokal". (Cek exact load flow di file page sebelum edit.)

- [ ] **Step 2: Push di ekor `saveCurrentProject`** — setelah `storageService.saveProject` sukses:

```ts
try {
	const { pushProject } = await import("@/klip/sync");
	await pushProject({ id: updatedProject.metadata.id });
} catch (error) {
	if (error instanceof SyncConflictError) {
		this.syncConflict = { projectId: updatedProject.metadata.id, serverUpdatedAt: error.serverUpdatedAt };
		this.notify();
	} else {
		console.warn("Sync push gagal (data lokal aman):", error);
	}
}
```

`syncConflict` field + getter dibaca UI editor (badge/dialog). 409 UI: `window.confirm("Server lebih baru. Timpa dengan versi ini? (Batal = muat dari server)")` -> Timpa: `pushProject` ulang dengan base = serverUpdatedAt (tambah param `force` di sync.ts: kirim baseUpdatedAt = serverUpdatedAt) ; Batal: `pullProject` + reload halaman (`window.location.reload()`). Implementasi `force` WAJIB di Task 5 (tambahkan sekarang jika belum: `pushProject({id, forceBase?})`).

- [ ] **Step 3: Tombol "Upload ke server"** di header projects (samping Instagram): klik -> untuk tiap project lokal (`loadAllProjectsMetadata`): `pushProject` penuh (tanpa base check pertama kali? Untuk idempoten: selalu kirim base dari localStorage; server 409 hanya jika disentuh pihak lain — tampilkan per-project dan lanjutkan) + progres toast per project + ringkasan akhir (sukses/gagal per nama). Error satu project tidak hentikan sisanya.

- [ ] **Step 4: Tombol Logout** — header projects (samping Instagram) + header editor (samping Publish): POST `/api/auth/logout` -> `window.location.href = "/"`.

- [ ] **Step 5: Full test + lint + commit** (`feat(klip): sync hooks + migration button`).

---

## Self-Review

- Spec coverage: auth §2 (Task 1-2), tabel §3 (Task 3), API §4 (Task 4), sync.ts §5 (Task 5), migrasi §6 (Task 6.3), konflik §7 (Task 6.2 + force), testing §8 (tiap task), bukan-scope §9 (tidak ada task S3/realtime/history).
- Placeholder: LONGTEXT check eksplisit (Task 3), exact folder editor dicek dulu (Task 6.1), `force` di-backfill ke Task 5.
- Type consistency: `createSession/verifySession`, `SESSION_COOKIE`, `SyncConflictError`, `getSyncBase/setSyncBase`, `pullProject/pushProject` sama di semua task.
