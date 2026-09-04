# Instagram Publish (Multi-Account) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tombol Publish di editor: render MP4 di browser, kirim ke N akun Instagram (Reels) sekaligus, dengan login Instagram in-app.

**Architecture:** Server Next.js sebagai relay: simpan MP4 + job per akun di MySQL, upload resumable ke `graph.instagram.com` per akun, polling container sampai FINISHED lalu publish. Token terenkripsi AES-256-GCM, tidak pernah ke browser.

**Tech Stack:** Next.js route handlers, drizzle-orm mysql2, bun:test, node:crypto, Radix dialog (existing UI).

## Global Constraints

- Bahasa balasan ke user: Indonesia, ringkas.
- Tidak ada tool `apply_patch`: tulis file via heredoc `cat >` / `python3` lewat `exec_command`.
- Test DB WAJIB: `bun --env-file=.env.local test src/klip/__tests__/` dari `apps/web`.
- `bun -e` debug script WAJIB diakhiri `process.exit(0)` (import graph Next + mysql pool menggantung).
- `tsc --noEmit` lambat (~4 mnt); filter output dengan grep ke file yang diubah.
- Jangan commit secret. Env baru WAJIB opsional di `src/env/web.ts` (meledak saat dipakai, bukan saat import).
- ID generator: ikuti pola `newMediaId()` (`m_` + 12 hex) di `src/klip/upload.ts` via `generateUUID` dari `@/utils/id`.
- File video publish: `PUBLISH_DIR = "publishes"` di bawah `dataRoot()`, path portabel via `toPortablePath()`.

---

## File Structure

- Modify: `apps/web/src/db/schema.ts` — tambah `caption` di `klipProjects`; tabel baru `klipIgAccounts`, `klipIgPublishes`, `klipIgPublishItems`.
- Generate: `apps/web/migrations/0003_*.sql` — via `bun run db:generate` (jangan tulis manual).
- Modify: `apps/web/src/env/web.ts` — tambah `IG_APP_ID`, `IG_APP_SECRET`, `IG_REDIRECT_URI`, `IG_TOKEN_KEY` (semua `.optional()`).
- Create: `apps/web/src/klip/ig-token.ts` — enkripsi/dekripsi AES-256-GCM (pure, testable).
- Test: `apps/web/src/klip/__tests__/ig-token.test.ts`.
- Create: `apps/web/src/klip/ig-api.ts` — client Meta (OAuth exchange + reels publish), semua path API di konstanta `IG_API` agar verifikasi endpoint satu titik.
- Test: `apps/web/src/klip/__tests__/ig-api.test.ts` (fetch dimock).
- Create: `apps/web/src/app/api/klip/ig-accounts/route.ts` — GET list akun (tanpa token).
- Create: `apps/web/src/app/api/klip/ig-accounts/authorize/route.ts` — GET redirect ke instagram oauth.
- Create: `apps/web/src/app/api/klip/ig-accounts/callback/route.ts` — tukar code, simpan akun.
- Create: `apps/web/src/app/api/klip/ig-accounts/[id]/route.ts` — DELETE disconnect.
- Create: `apps/web/src/app/api/klip/publishes/route.ts` — POST buat job + upload MP4 (background process, tidak di-await).
- Create: `apps/web/src/app/api/klip/publishes/[id]/route.ts` — GET status job + items; POST retry item gagal.
- Modify: `apps/web/src/app/api/klip/projects/[id]/brand/route.ts` — tambah PATCH caption (cek file dulu; kalau tidak ada GET/PATCH di sana, buat `route.ts` PATCH baru di `[id]/caption/`).
- Create: `apps/web/src/components/editor/publish-button.tsx` — dialog publish (checkbox akun + caption + progres per akun), upload buffer hasil `editor.project.export()`.
- Modify: `apps/web/src/components/editor/editor-header.tsx` — pasang `PublishButton` di samping `ExportButton`.
- Test: `apps/web/src/klip/__tests__/ig-publish-api.test.ts` — job/item transitions + validasi input route (mock Meta).

---

### Task 1: Skema DB + migrasi

**Files:**
- Modify: `apps/web/src/db/schema.ts`
- Generate: `apps/web/migrations/0003_*.sql`

**Interfaces:**
- Consumes: pola `klipBrandLayers` (FK cascade inline) di file yang sama.
- Produces: `klipIgAccounts`, `klipIgPublishes`, `klipIgPublishItems`, `klipProjects.caption` untuk Task 3-6.

- [ ] **Step 1: Tambah skema**

```ts
// tambah di klipProjects, setelah sourceMediaId:
caption: text("caption"),

// tabel baru di akhir file:
export const klipIgAccounts = mysqlTable("klip_ig_accounts", {
	id: varchar("id", { length: 64 }).primaryKey(),
	igUserId: varchar("ig_user_id", { length: 64 }).notNull().unique(),
	username: varchar("username", { length: 255 }).notNull(),
	profilePicUrl: text("profile_pic_url"),
	accessTokenEnc: text("access_token_enc").notNull(),
	tokenExpiresAt: timestamp("token_expires_at"),
	status: mysqlEnum("status", ["active", "token_expired", "disconnected"])
		.default("active").notNull(),
	createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});
export type KlipIgAccount = typeof klipIgAccounts.$inferSelect;

export const klipIgPublishes = mysqlTable("klip_ig_publishes", {
	id: varchar("id", { length: 64 }).primaryKey(),
	projectId: varchar("project_id", { length: 64 }).notNull()
		.references(() => klipProjects.id, { onDelete: "cascade" }),
	caption: text("caption"),
	videoPath: varchar("video_path", { length: 1024 }).notNull(),
	status: mysqlEnum("status", ["processing", "done", "partial", "failed"])
		.default("processing").notNull(),
	createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});
export type KlipIgPublish = typeof klipIgPublishes.$inferSelect;

export const klipIgPublishItems = mysqlTable("klip_ig_publish_items", {
	id: varchar("id", { length: 64 }).primaryKey(),
	publishId: varchar("publish_id", { length: 64 }).notNull()
		.references(() => klipIgPublishes.id, { onDelete: "cascade" }),
	igAccountId: varchar("ig_account_id", { length: 64 }).notNull()
		.references(() => klipIgAccounts.id, { onDelete: "cascade" }),
	containerId: varchar("container_id", { length: 128 }),
	status: mysqlEnum("status", ["queued", "uploading", "processing", "published", "failed"])
		.default("queued").notNull(),
	permalink: text("permalink"),
	error: text("error"),
	attempts: int("attempts").default(0).notNull(),
	createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
});
export type KlipIgPublishItem = typeof klipIgPublishItems.$inferSelect;
```

- [ ] **Step 2: Generate + migrasi lokal**

```bash
cd /Users/oktaariaditya/ordo/klip-opencut/apps/web
bun run db:generate
bun run db:migrate
```

Expected: file `migrations/0003_*.sql` terbentuk berisi 3 CREATE TABLE + 1 ALTER TABLE; migrate sukses tanpa error.

- [ ] **Step 3: Commit**

```bash
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/db/schema.ts apps/web/migrations
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): schema for IG accounts and publish jobs"
```

---

### Task 2: Env + enkripsi token

**Files:**
- Modify: `apps/web/src/env/web.ts`
- Create: `apps/web/src/klip/ig-token.ts`
- Test: `apps/web/src/klip/__tests__/ig-token.test.ts`

**Interfaces:**
- Consumes: tidak ada (pure crypto).
- Produces: `encryptToken(plain: string): string`, `decryptToken(enc: string): string` untuk Task 3-4. Format `iv_hex:cipher_hex:tag_hex`.

- [ ] **Step 1: Tambah env opsional**

```ts
IG_APP_ID: z.string().optional(),
IG_APP_SECRET: z.string().optional(),
IG_REDIRECT_URI: z.string().optional(),
IG_TOKEN_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
```

`IG_TOKEN_KEY` = 32 byte hex. Wajib diisi di server sebelum fitur dipakai; validasi regex tetap jalan saat diisi.

- [ ] **Step 2: Tulis test dulu (TDD)**

```ts
import { describe, expect, test } from "bun:test";
import { decryptToken, encryptToken } from "@/klip/ig-token";

describe("ig-token", () => {
	test("roundtrip", () => {
		process.env.IG_TOKEN_KEY = "ab".repeat(32);
		const enc = encryptToken("token-rahasia-123");
		expect(enc).not.toContain("token-rahasia-123");
		expect(decryptToken(enc)).toBe("token-rahasia-123");
	});
	test("dua enkripsi menghasilkan ciphertext berbeda (IV acak)", () => {
		process.env.IG_TOKEN_KEY = "ab".repeat(32);
		expect(encryptToken("sama")).not.toBe(encryptToken("sama"));
	});
	test("tanpa key meledak dengan pesan jelas", () => {
		delete process.env.IG_TOKEN_KEY;
		expect(() => encryptToken("x")).toThrow("IG_TOKEN_KEY");
	});
});
```

- [ ] **Step 3: Run, pastikan FAIL**

```bash
cd /Users/oktaariaditya/ordo/klip-opencut/apps/web
bun --env-file=.env.local test src/klip/__tests__/ig-token.test.ts
```

Expected: FAIL "Cannot find module".

- [ ] **Step 4: Implementasi minimal**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
	const hex = process.env.IG_TOKEN_KEY;
	if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error("IG_TOKEN_KEY belum dipasang (butuh 32 byte hex di env server)");
	}
	return Buffer.from(hex, "hex");
}

export function encryptToken(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return `${iv.toString("hex")}:${enc.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

export function decryptToken(payload: string): string {
	const [ivHex, encHex, tagHex] = payload.split(":");
	if (!ivHex || !encHex || !tagHex) throw new Error("Format token terenkripsi tidak valid");
	const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(tagHex, "hex"));
	return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 5: Run, pastikan PASS**

```bash
bun --env-file=.env.local test src/klip/__tests__/
```

Expected: semua hijau termasuk test baru.

- [ ] **Step 6: Commit**

```bash
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/env/web.ts apps/web/src/klip/ig-token.ts apps/web/src/klip/__tests__/ig-token.test.ts
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): encrypted IG token storage helpers"
```

---

### Task 3: OAuth Instagram Login (connect/disconnect/list)

**Files:**
- Create: `apps/web/src/klip/ig-api.ts` (bagian OAuth saja)
- Create: `apps/web/src/app/api/klip/ig-accounts/route.ts`
- Create: `apps/web/src/app/api/klip/ig-accounts/authorize/route.ts`
- Create: `apps/web/src/app/api/klip/ig-accounts/callback/route.ts`
- Create: `apps/web/src/app/api/klip/ig-accounts/[id]/route.ts`

**Interfaces:**
- Consumes: `encryptToken`/`decryptToken` (Task 2), `db` + `klipIgAccounts` (Task 1), `generateUUID` dari `@/utils/id`.
- Produces: `exchangeCodeForToken`, `fetchIgProfile`, `IG_SCOPES` untuk Task 4; endpoint REST untuk Task 6.

- [ ] **Step 1: Konstanta + OAuth di `ig-api.ts`**

```ts
export const IG_API_BASE = "https://graph.instagram.com";
export const IG_OAUTH_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
export const IG_OAUTH_TOKEN = "https://api.instagram.com/oauth/access_token";
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
export const IG_API_VERSION = "v24.0"; // verifikasi ulang ke docs saat implementasi; cukup ubah di sini

function requireIgEnv() {
	const { IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI } = process.env;
	if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT_URI) {
		throw new Error("IG_APP_ID / IG_APP_SECRET / IG_REDIRECT_URI belum dipasang di env server");
	}
	return { appId: IG_APP_ID, appSecret: IG_APP_SECRET, redirectUri: IG_REDIRECT_URI };
}

export function buildAuthorizeUrl(state: string): string {
	const { appId, redirectUri } = requireIgEnv();
	const q = new URLSearchParams({
		client_id: appId, redirect_uri: redirectUri,
		scope: IG_SCOPES.join(","), response_type: "code", state,
	});
	return `${IG_OAUTH_AUTHORIZE}?${q.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; userId: string }> {
	const { appId, appSecret, redirectUri } = requireIgEnv();
	const body = new URLSearchParams({
		client_id: appId, client_secret: appSecret,
		grant_type: "authorization_code", redirect_uri: redirectUri, code,
	});
	const res = await fetch(IG_OAUTH_TOKEN, { method: "POST", body });
	if (!res.ok) throw new Error(`Instagram token exchange gagal: ${res.status}`);
	const json = (await res.json()) as { access_token: string; user_id: number };
	return { accessToken: json.access_token, userId: String(json.user_id) };
}

export async function exchangeForLongLivedToken(shortLived: string): Promise<{ accessToken: string; expiresIn: number }> {
	const { appSecret } = requireIgEnv();
	const q = new URLSearchParams({
		grant_type: "ig_exchange_token", client_secret: appSecret, access_token: shortLived,
	});
	const res = await fetch(`${IG_API_BASE}/access_token?${q.toString()}`);
	if (!res.ok) throw new Error(`Instagram long-lived exchange gagal: ${res.status}`);
	const json = (await res.json()) as { access_token: string; expires_in: number };
	return { accessToken: json.access_token, expiresIn: json.expires_in };
}

export async function fetchIgProfile(accessToken: string): Promise<{ id: string; username: string; profilePicUrl: string | null }> {
	const q = new URLSearchParams({
		fields: "user_id,username,profile_picture_url", access_token: accessToken,
	});
	const res = await fetch(`${IG_API_BASE}/${IG_API_VERSION}/me?${q.toString()}`);
	if (!res.ok) throw new Error(`Instagram profile gagal: ${res.status}`);
	const json = (await res.json()) as { user_id?: string; id?: string; username: string; profile_picture_url?: string };
	return { id: String(json.user_id ?? json.id), username: json.username, profilePicUrl: json.profile_picture_url ?? null };
}
```

CATATAN VERIFIKASI (wajib sebelum tutup task): cocokkan `fields` profile (`user_id` vs `id`) dan versi API ke docs terbaru + pengalaman integrasi user sebelumnya. Semua perubahan endpoint HANYA di konstanta/fungsi file ini.

- [ ] **Step 2: Route authorize (GET)** — validasi env, buat `state` acak (`generateUUID`), redirect 302 ke `buildAuthorizeUrl(state)`. Simpan state di cookie httpOnly 10 menit (`ig_oauth_state`).

- [ ] **Step 3: Route callback (GET)** — baca `code`+`state`, cocokkan cookie lalu hapus; `exchangeCodeForToken` -> `exchangeForLongLivedToken` -> `fetchIgProfile`; upsert ke `klipIgAccounts` by `igUserId` (`accessTokenEnc: encryptToken(...)`, `tokenExpiresAt: new Date(Date.now()+expiresIn*1000)`, `status: "active"`); redirect ke `/projects?ig=connected` (atau halaman pengaturan; pilih satu, konsisten).

- [ ] **Step 4: Route list (GET)** — return semua akun KECUALI token: `{ id, igUserId, username, profilePicUrl, status, tokenExpiresAt }`. Tidak pernah kirim token ke browser.

- [ ] **Step 5: Route disconnect (DELETE)** — set `status: "disconnected"` (soft, agar riwayat publish utuh). Return 404 jika id tidak ada.

- [ ] **Step 6: Test route dengan fetch dimock + commit**

```bash
bun --env-file=.env.local test src/klip/__tests__/
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/klip/ig-api.ts apps/web/src/app/api/klip/ig-accounts
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): instagram login connect/disconnect/list"
```

---

### Task 4: Client publish Reels ke Meta

**Files:**
- Modify: `apps/web/src/klip/ig-api.ts` (tambah bagian publish)
- Test: `apps/web/src/klip/__tests__/ig-api.test.ts`

**Interfaces:**
- Consumes: `IG_API_BASE`, `IG_API_VERSION` (Task 3).
- Produces: `publishReel(opts): Promise<{ containerId: string; permalink: string }>` untuk Task 5. `opts = { igUserId, accessToken, caption, videoBytes: Uint8Array, onStage?: (s: string) => void }`.

- [ ] **Step 1: Tulis test dengan fetch mock**

```ts
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { __setFetchMock } from "@/klip/ig-api"; // lihat Step 2

// pola: antrian respons fetch per panggilan, verifikasi permalink akhir + urutan stage.
```

Skenario: (a) sukses penuh -> permalink benar, stage berurutan `upload -> processing -> published`; (b) container status ERROR -> throw berisi pesan Meta; (c) HTTP 401 -> throw dengan marker `IG_TOKEN_INVALID` (dipakai Task 5 untuk menandai akun expired).

- [ ] **Step 2: Implementasi (satu titikisolasi HTTP agar mudah dimock)**

```ts
let fetchImpl: typeof fetch = fetch;
export function __setFetchMock(fn: typeof fetch) { fetchImpl = fn; }
```

Fungsi internal: `startResumableUpload`, `uploadBytes`, `createReelContainer`, `pollContainerUntilFinished` (interval 5 dtk, maks 60x, timeout jelas), `publishContainer`. `publishReel` merangkai semuanya dan memanggil `onStage`.

CATATAN VERIFIKASI (wajib): bentuk exact resumable-upload untuk produk Instagram Login (apakah `POST /{ig-id}/video?upload_type=resumable` seperti API klasik atau varian baru) dicocokkan ke docs + pengalaman user. Kalau ternyata butuh URL publik, fallback: simpan MP4 di storage publik sementara (keputusan eksplisit bersama user, bukan diam-diam).

- [ ] **Step 3: Run + commit**

```bash
bun --env-file=.env.local test src/klip/__tests__/ig-api.test.ts
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/klip/ig-api.ts apps/web/src/klip/__tests__/ig-api.test.ts
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): meta reels publish client"
```

---

### Task 5: API publishes (job + progres + retry + caption)

**Files:**
- Create: `apps/web/src/app/api/klip/publishes/route.ts`
- Create: `apps/web/src/app/api/klip/publishes/[id]/route.ts`
- Modify: PATCH caption project (cek `projects/[id]/brand/route.ts` dulu; tambah handler PATCH di file yang sama atau route baru).
- Test: `apps/web/src/klip/__tests__/ig-publish-api.test.ts`

**Interfaces:**
- Consumes: `publishReel`, `decryptToken` (Task 2/4), tabel Task 1, `dataRoot/toPortablePath` + pola ID `upload.ts`.
- Produces: `POST /api/klip/publishes`, `GET /api/klip/publishes/[id]`, retry, PATCH caption untuk Task 6.

- [ ] **Step 1: POST /api/klip/publishes (multipart)**

Field: `projectId` (string), `caption` (string, boleh kosong), `accountIds` (JSON array string, 1-10), `file` (mp4, maks 500MB, tolak ext selain `.mp4`). Validasi: project ada, semua accountIds ada + `status === "active"`. Simpan file ke `publishes/{publishId}.mp4` (ID pola `p_` + 12 hex). Insert publish (`processing`) + items (`queued`). Update `klipProjects.caption` dengan caption yang dikirim (sumber tunggal). Jalankan `void processPublish(publishId)` TANPA await, langsung return `{ id }` 201.

- [ ] **Step 2: `processPublish`** — untuk tiap item berurutan: set `uploading` -> baca file -> `decryptToken` -> `publishReel` dengan `onStage` update status (`uploading`/`processing`) -> sukses: `published` + permalink; gagal: `failed` + `error` (pesan Meta mentah, potong 2000 char). Jika error bermarker `IG_TOKEN_INVALID`: set akun `token_expired`. Akhir: agregat status publish (`done`/`partial`/`failed`). Baca ulang path file dari DB (jangan dari closure) agar tahan restart parsial; catat di komentar bahwa restart server menghentikan job in-flight (batasan MVP yang disengaja).

- [ ] **Step 3: GET + retry** — GET return publish + items (tanpa token) + info akun (username). Retry: `POST /api/klip/publishes/[id]` body `{ itemId }` -> hanya jika item `failed` dan akun masih `active`; set `queued`, `attempts+1`, `void processPublish` lagi.

- [ ] **Step 4: Test + commit**

```bash
bun --env-file=.env.local test src/klip/__tests__/
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/app/api/klip/publishes apps/web/src/klip/__tests__/ig-publish-api.test.ts
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): publish jobs api with per-account status"
```

---

### Task 6: UI Publish di editor

**Files:**
- Create: `apps/web/src/components/editor/publish-button.tsx`
- Modify: `apps/web/src/components/editor/editor-header.tsx`

**Interfaces:**
- Consumes: endpoint Task 3/5; `editor.project.export({ options: { format: "mp4", quality, includeAudio: true } })` -> `ExportResult.buffer`; `useEditor` seperti `ExportButton`.

- [ ] **Step 1: Komponen `PublishButton`** — tombol di samping Export (buka dialog). Dialog berisi: daftar akun (fetch GET ig-accounts; hanya `active` bisa dicentang; tombol "Hubungkan" redirect ke authorize; akun expired tampil badge + link reconnect), textarea caption (prefill dari project, editable), tombol Kirim (disabled jika 0 akun / caption melebihi 2200 char -> tampilkan hitungan). Saat kirim: export mp4 di browser (tampilkan progres memakai `exportState`), upload via `fetch POST multipart`, lalu polling GET tiap 3 dtk, tampilkan status per akun (antri/mengunggah/diproses/terbit/gagal + link permalink / pesan error + tombol retry per item gagal).

- [ ] **Step 2: Pasang di header + verifikasi manual + commit**

```bash
bun --env-file=.env.local test src/klip/__tests__/
git -C /Users/oktaariaditya/ordo/klip-opencut add apps/web/src/components/editor/publish-button.tsx apps/web/src/components/editor/editor-header.tsx
git -C /Users/oktaariaditya/ordo/klip-opencut commit -m "feat(klip): publish to instagram button in editor"
```

Verifikasi manual wajib: connect 1 akun real -> publish 1 video pendek -> permalink valid; lalu 2 akun sekaligus; lalu cabut token (disconnect) dan pastikan pesan "perlu reconnect" muncul.

---

## Self-Review

- Spec coverage: OAuth in-app (Task 3), multi-akun sekaligus (Task 5 items), caption per project (Task 5 PATCH + Task 6), browser render (Task 6 export buffer), Reels saja (Task 4 `media_type=REELS`), status per akun + retry + token expired (Task 5-6). Fase 2 (bulk) eksplisit di luar scope.
- Placeholder scan: dua CATATAN VERIFIKASI endpoint Meta disengaja dan dibatasi ke `ig-api.ts` (bukan "TBD" terbuka) karena bentuk exact API produk baru wajib dicocokkan ke docs + pengalaman user.
- Type consistency: `encryptToken/decryptToken`, `publishReel`, `IG_TOKEN_INVALID`, status enum sama di skema, Task 5, dan Task 6.
