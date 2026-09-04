# Server Sync + Shared Login — Design

Tanggal: 2026-09-04. Status: disetujui user (pendekatan A: sync di batas open/save).

## 1. Latar & keputusan

- Project + media saat ini di IndexedDB/OPFS per origin per browser: orang lain yang buka URL sama
  dapat halaman kosong. Target: project bisa dibuka dari browser mana pun.
- Akses: 1 kredensial shared (user `ordo`, password plaintext dari env). Tanpa multi-user.
- Arsitektur: IndexedDB/OPFS tetap dipakai editor; server jadi source of truth via sync di
  titik open (pull) dan save (push). Tanpa bedah `StorageService`/inti editor.
- Migrasi data lokal existing: tombol manual di halaman projects.

## 2. Auth

- `GET /` = halaman login (ganti landing existing). Field username + password.
- Env: `APP_USER=ordo`, `APP_PASSWORD=secret123` (plaintext, dari env, jangan dicommit),
  `APP_SESSION_KEY` (random 32 byte hex untuk HMAC).
- `POST /api/auth/login`: cek kredensial -> cookie httpOnly `klip_session = expiry.hmac`
  (HMAC-SHA256 atas `ordo:expiry`, expiry 30 hari). Rate-limit percobaan login (max 10/menit/IP).
- `POST /api/auth/logout`: hapus cookie. `GET /api/auth/me`: `{ user }` atau 401.
- `middleware.ts`: semua route + `/api/*` butuh session valid, kecuali `/`,
  `/api/auth/login`, `/_next/*`, file statis. API yang dilindungi tetap cek session di
  middleware (satu titik), bukan per-route.

## 3. Data model (MySQL, Drizzle)

- `klip_sync_projects`: `id` varchar(64) PK (= opencut project id, 1:1 dengan lokal),
  `name` varchar(255), `data` LONGTEXT (SerializedProject JSON), `updated_at`, `created_at`.
- `klip_sync_media`: `id` varchar(128) PK (= asset id sisi klien), `project_id` FK cascade,
  `file_path` varchar(1024) (di bawah `dataRoot()/sync-media/`), `mime` varchar(128),
  `size` int, `updated_at`.

## 4. API sync (semua di belakang session)

- `GET /api/sync/projects` -> metadata `{ id, name, updatedAt }` (tanpa blob JSON).
- `GET /api/sync/projects/[id]` -> `{ id, name, data, updatedAt }`.
- `PUT /api/sync/projects/[id]` body `{ name, data, baseUpdatedAt }` ->
  200 `{ updatedAt }`, atau 409 `{ serverUpdatedAt }` jika `baseUpdatedAt < updatedAt` di server.
- `GET /api/sync/projects/[id]/media` -> daftar `{ id, mime, size, updatedAt }`.
- `POST /api/sync/projects/[id]/media` multipart (`file`, asset id dari nama file/query) ->
  simpan, upsert row. Batas 500MB/file.
- `GET /api/sync/media/[assetId]` -> stream file (content-type + cache immutable).

## 5. Client `src/klip/sync.ts`

- `pullProject({ id })`: GET JSON + daftar media server -> tulis JSON via storageService
  (impor sebagai project lokal, overwrite id sama) -> download blob media yang belum ada
  lokal (bandingkan id) -> tulis ke OPFS -> return siap dibuka editor.
- `pushProject({ id, baseUpdatedAt })`: serialize project lokal via storageService ->
  PUT JSON (kirim baseUpdatedAt terakhir dari server) -> bandingkan daftar media lokal vs
  server -> upload yang kurang -> return `{ updatedAt }`. 409 diteruskan ke UI.
- Titik pasang: (a) open project dari halaman projects: pull dulu (jika project ada di
  server dan lebih baru / belum ada lokal) baru `openProject`; (b) save debounce editor:
  push best-effort (gagal sync tidak menggagalkan save lokal; tampilkan badge "belum sync").
- `baseUpdatedAt` disimpan per project di localStorage (`klip_sync_base:<id>`).

## 6. Migrasi manual

- Tombol "Upload ke server" di header halaman projects: untuk tiap project lokal,
  serialize + push penuh (tanpa base check, server terima sebagai baru/lama) + upload
  semua media. Progres per project, error per project tidak menghentikan sisanya,
  bisa diklik ulang (idempoten via upsert).
- Setelah migrasi, buka via tunnel/domain lain: pull otomatis saat open.

## 7. Konflik & batasan

- Last-write-wins dengan pengaman 409: dialog "Server lebih baru (waktu X). [Timpa] [Muat dari server]".
- Tanpa auto-merge, tanpa kolaborasi real-time, tanpa version history (di luar scope).
- Restart server tidak menghilangkan apa pun (semua di MySQL + disk). Job sync best-effort,
  tidak ada worker/background.

## 8. Testing

- Unit: HMAC session (buat/validasi/expired/tamper), baseUpdatedAt 409 logic, parse helpers.
- Route test pola existing (DB real + cleanup): login sukses/gagal, proteksi 401 tanpa cookie,
  PUT baru, PUT 409, upload media, migrasi idempoten.
- Manual: login via tunnel, migrasi 1 project, buka dari browser lain, edit 2 tempat -> 409 muncul.
- `bun --env-file=.env.local test src/klip/__tests__/` hijau; eslint bersih file baru.

## 9. Bukan scope

Multi-user/roles, share link publik, real-time collab, version history, object storage (S3),
render server-side, hapus IndexedDB/OPFS.
