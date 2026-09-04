# Klip × OpenCut — Desain Sistem v1 (Opsi A: Vertikal)

> Tanggal: 2026-09-04. Status: DRAFT untuk review.
> Induk: `docs/2026-09-04-klip-opencut-fork.md` (goal + plan 11 task).
> Keputusan terkunci saat brainstorming:
> 1. DB = MySQL (ganti dialect di Task 0, sebelum tabel Klip ada).
> 2. Deploy = manual + PM2, tanpa Docker; pakai MySQL + Redis yang sudah ada di server.
> 3. Brand-map = Rust core + binding tipis (sesuai AGENTS.md).
> 4. Task 0 = verifikasi + sinkron upstream, tanpa clone ulang.
> 5. Template = SKIP di v1, didiskusikan lagi nanti.
> 6. Urutan eksekusi = Opsi A (vertikal, demo per slice), bukan urutan 11 task dokumen.
> 7. Redis = tersedia di server → rate-limit auth tanpa perubahan kode (jembatan serverless-redis-http diarahkan ke Redis server).

---

## 1. Ringkasan

Satu repo public (fork `opencut-classic` + fitur Klip) menjadi main app dengan tiga kemampuan v1:

1. **Upload video server-side** (single + ZIP batch ala Klip) → N proyek.
2. **Brand overlay model Klip** yang hidup sebagai element/track opencut (transform, z-order, timing dikendalikan lewat UI opencut, ikut terbakar saat export).
3. **Publish Instagram cara Klip** (token di DB, endpoint publish, status per item).

Yang SENGAJA tidak masuk v1: pipeline AI caption (transkripsi/LLM), B-roll generate, TikTok publish, animasi keyframe lanjutan, **template** (skip, diskusi ulang nanti).

**Definisi selesai v1 (disesuaikan tanpa Docker):** fresh clone → `bun install` + migrasi MySQL + build wasm → upload 1 video → tambah 2 brand layer (drag/rotate/z-order) → export MP4 brand menempel → upload ZIP 2 video → 2 proyek → publish 1 ke IG (atau dry-run tercatat bila tanpa kredensial). Semua hijau.

---

## 2. Arsitektur

```
                 ┌─────────────────────────────────────────┐
                 │ apps/web (Next.js — UI shell saja)      │
                 │  / (grid proyek + upload)               │
                 │  /editor/[id] (editor opencut apa adanya)│
                 │  /api/uploads, /api/klip/*              │
                 └───────┬──────────────────┬──────────────┘
                         │                  │
            ┌────────────▼──────┐  ┌──────────▼──────────┐
            │ rust/ (core logic)│  │ MySQL server        │
            │  crates/klip      │  │  klip_projects      │
            │   brand-map       │  │  klip_brand_layers  │
            │   (pure mapping,  │  │  klip_media         │
            │    tanpa UI)      │  │  ig_accounts        │
            └─────────┬─────────┘  │  ig_publish_jobs    │
                      │ wasm-pack  │  (auth bawaan opencut│
            ┌─────────▼─────────┐  │   tetap, lihat §6)  │
            │ opencut-wasm (ada)│  └─────────────────────┘
            │ GPU compositor,   │
            │ export MP4/WEBM   │  ┌─────────────────────┐
            └───────────────────┘  │ Disk server         │
                                   │  uploads/, brand/, │
                 ┌─────────────────┤  renders/ + record  │
                 │                 │  di klip_media      │
        ┌────────▼────────┐ ┌──────▼──────┐
        │ Browser storage │ │ Instagram   │
        │ OPFS/IndexedDB  │ │ Graph API   │
        │ (TProject +     │ │ (container→ │
        │  timeline JSON, │ │  poll→      │
        │  milik opencut) │ │  publish)   │
        └─────────────────┘ └─────────────┘
```

### 2.1 Aturan kepemilikan (sesuai AGENTS.md)

- `rust/` = satu-satunya tempat logika platform-agnostik. Pemetaan brand↔track ditulis sebagai crate baru `rust/crates/klip` (fungsi murni, tanpa import framework/UI), diekspos ke web lewat binding wasm tipis. TypeScript di `apps/web/src/klip/` hanya adapter (fetch API, registrasi panel, wiring store) — bukan logika.
- `apps/web/` = shell UI: rendering, interaksi, API route Next.js (thin: validasi → panggil core/DB → respons).
- Logika tidak diduplikasi antar app (`web` vs `desktop/GPUI` nanti) — desktop kelak memakai crate `klip` yang sama.

### 2.2 Dua dunia penyimpanan: registry MySQL + browser storage

Fakta grounding: proyek opencut (`TProject`: metadata + scenes + settings) disimpan di browser via `StorageService` (OPFS/IndexedDB adapter di `apps/web/src/services/storage/`). Plan menaruh proyek Klip di Postgres. Keputusan: **pola registry + tautan**:

- **MySQL** menyimpan identitas server-side: proyek Klip (id, nama, source file, durasi, status), media (upload/brand asset), brand layers (sumber kebenaran timing + transform), akun IG + job publish.
- **Browser storage opencut tetap** menyimpan `TProject` + timeline JSON (scenes/tracks/elements). Tidak diubah di v1.
- **Tautan:** `klip_projects.opencut_ref` (atau konvensi id bersama) mengikat satu baris MySQL ↔ satu `TProject` di browser. Alur buka editor: `GET /api/klip/projects/:id` → respons berisi metadata + brand layers + `opencutRef` → client memastikan `TProject` ada di storage browser (buat dari source bila belum ada) → materialisasikan brand layers menjadi elements via `klipLayerToElement` → editor dibuka seperti biasa.
- Konsekuensi jujur: di mesin/browser berbeda, timeline JSON harus direhidrasi dari registry (rekonstruksi otomatis saat buka editor, bukan sync dua arah penuh — sync penuh di luar scope v1).

---

## 3. Model data (MySQL, Drizzle)

Semua tabel baru berprefix `klip_` / `ig_`. Tabel bawaan opencut (`users`, `sessions`, `accounts`, `feedback`, `verifications`) tidak diubah strukturnya — hanya dialect-nya yang ikut pindah ke MySQL (lihat §7).

```sql
klip_media (
  id            VARCHAR(64) PK,          -- m_xxx
  kind          ENUM('source','brand'),  -- video sumber vs asset brand
  asset_kind    ENUM('image','video','audio') NULL,  -- untuk kind='brand'
  name          VARCHAR(255),
  file_path     VARCHAR(1024),           -- path relatif portabel (brand/x.png), bukan absolut
  width         INT NULL,  height INT NULL,
  duration      DOUBLE NULL,             -- detik
  thumbnail_path VARCHAR(1024) NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

klip_projects (
  id            VARCHAR(64) PK,          -- prj_xxx (kompatibel id Klip lama)
  name          VARCHAR(255),
  batch_id      VARCHAR(64) NULL,        -- pengelompokan hasil ZIP
  source_media_id VARCHAR(64) NULL → klip_media(id),
  status        VARCHAR(32) DEFAULT 'ready',
  opencut_ref   VARCHAR(64) NULL,        -- tautan ke TProject.metadata.id di browser
  duration      DOUBLE NULL,  width INT NULL,  height INT NULL,  fps DOUBLE NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)

klip_brand_layers (
  id            VARCHAR(64) PK,          -- lyr_xxx
  project_id    VARCHAR(64) → klip_projects(id) ON DELETE CASCADE,
  asset_id      VARCHAR(64) NULL → klip_media(id),  -- NULL bila file langsung (kompat Klip)
  file_path     VARCHAR(1024),           -- duplikat fisik ala Klip (preview/render tanpa join)
  name          VARCHAR(255),
  kind          ENUM('image','video','audio'),
  enabled       BOOLEAN DEFAULT TRUE,
  x             DOUBLE DEFAULT 0.06,     -- 0–1, relatif lebar canvas
  y             DOUBLE DEFAULT 0.05,     -- 0–1, relatif tinggi canvas
  scale         DOUBLE DEFAULT 0.36,     -- faktor terhadap lebar canvas (definisi Klip)
  rotate        DOUBLE DEFAULT 0,        -- derajat
  opacity       INT DEFAULT 100,         -- 10–100
  full          BOOLEAN DEFAULT TRUE,    -- tampil sepanjang hasil
  start         DOUBLE DEFAULT 0,        -- detik waktu-HASIL (bila full=false)
  dur           DOUBLE DEFAULT 0,        -- detik waktu-HASIL (bila full=false)
  volume        DOUBLE DEFAULT 0.35,     -- 0–2, khusus audio (+video ber-audio)
  duck          BOOLEAN DEFAULT FALSE,
  z             INT DEFAULT 0,           -- urutan bawah→atas (kolom baru; Klip memakai urutan array)
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

ig_accounts (
  id            VARCHAR(64) PK,
  label         VARCHAR(255),            -- nama tampilan
  ig_user_id    VARCHAR(64),
  page_id       VARCHAR(64) NULL,
  access_token  TEXT,                    -- token long-lived
  graph_host    VARCHAR(255) DEFAULT 'https://graph.facebook.com',
  expires_at    TIMESTAMP NULL,
  is_default    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)

ig_publish_jobs (
  id            VARCHAR(64) PK,
  project_id    VARCHAR(64) → klip_projects(id),
  account_id    VARCHAR(64) → ig_accounts(id),
  clip_path     VARCHAR(1024),           -- file render yang dipublish
  caption       TEXT NULL,
  status        ENUM('queued','uploading','processing','published','failed','dry_run') DEFAULT 'queued',
  ig_creation_id VARCHAR(128) NULL,
  ig_media_id   VARCHAR(128) NULL,
  error         TEXT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
```

Catatan porting Klip→MySQL:

- Field layer dipertahankan 1:1 dari `seedBrandLayers()` Klip (`id, asset_id, file, name, kind, enabled, x, y, scale, rotate, start, dur, full, volume, duck, opacity`) + kolom `z` eksplisit (Klip memakai urutan array JSON; di DB urutan harus kolom).
- Path file selalu relatif terhadap root data (pola `toBrandPath` Klip) agar portabel antar mesin.
- `volume` Klip 0–2 dipertahankan; konversi ke skala opencut (0–100) terjadi di brand-map, bukan di DB.

---

## 4. Brand-map: inti pemetaan (Rust core)

Lokasi: crate baru `rust/crates/klip` (mis. `brand_map.rs` + test). Diekspos ke web via `rust/wasm` binding; TS hanya memanggil.

### 4.1 Kontrak fungsi

```
klipLayerToElement(layer: TKlipBrandLayer, ctx: Ctx) -> CreateImageElement | CreateVideoElement | CreateAudioElement
elementToKlipLayerPatch(el) -> TKlipBrandLayer patch (untuk sync balik panel/inspector)
```

`Ctx` = `{ canvasWidth, canvasHeight, totalDuration }` (waktu-HASIL, bukan waktu-source).

### 4.2 Aturan pemetaan (dari grounding kode)

| Dimensi Klip | Target opencut | Catatan |
|---|---|---|
| `kind=image` (visual) | graphic track (`TrackType::graphic` ada di `tracks.ts`) | element image |
| `kind=video` (visual) | overlay video track | element video |
| `kind=audio` | audio track | element audio |
| `x/y/scale/rotate/opacity` | `params.transform` (`transform.rotate` SUDAH ada di `params/registry.ts`) | `x,y` 0–1 → piksel via ctx canvas; `scale` faktor-lebar Klip → skala opencut; `opacity` 10–100 → 0–1 |
| `full=true` | `startTime=0, duration=totalDuration` | |
| `full=false` | `startTime=start, duration=dur` (waktu-HASIL langsung) | Klip menyimpan waktu-hasil, jadi tanpa konversi scene/cut |
| `enabled` | `hidden = !enabled` | |
| urutan array / kolom `z` | z-order dalam track (bawah→atas) | |
| `volume/duck` | param audio element | konversi skala 0–2 → 0–100 di sini |
| `trimStart/trimEnd` | default 0 | |

### 4.3 Verifikasi

- Test unit bulat-balik di Rust: `layer → element → layer` identik kecuali `id` (salin dari kriteria plan Task 3).
- Tanpa `rotate` = tanpa filter tambahan (tanpa regresi render); `rotate≠0` canvas membesar (ow/oh) dengan toleransi visual ±beberapa px di sudut besar (catatan plan Task 5).
- Paritas preview↔export: render 1 proyek (image rotate 15° + video timed) → overlay ≈ preview (visual check, Task 5).

---

## 5. API (Next.js routes, thin)

| Method + path | Masukan | Keluaran | Catatan |
|---|---|---|---|
| `POST /api/uploads` | multipart (single video) | `{mediaId, url, width, height, duration, thumbnailUrl}` | simpan disk + record `klip_media`; gantikan `use-file-upload.ts` agar mengarah ke sini (progress dipertahankan) |
| `POST /api/klip/batch-zip` | ZIP (max 50 file, guard traversal) | `{batchId, count, children: {id, name}[]}` | extract → 1 proyek per video + `seedBrandLayers` dari defaults library (tanpa template di v1) |
| `GET /api/klip/projects` | — | daftar proyek + status | untuk grid main page |
| `GET /api/klip/projects/:id` | — | `{project, source, brand[], opencutRef}` | dipakai editor untuk rehidrasi |
| `PATCH /api/klip/projects/:id/brand` | patch layers | `brand[]` baru | sync balik dari panel (eye, z-order, hapus, transform) |
| `POST /api/klip/brand-assets` | multipart (png/jpg/webp, mp4/webm/mov, mp3/wav/m4a/ogg) | asset | klasifikasi via `classifyBrandUpload` Klip |
| `POST /api/klip/ig/publish` | `{projectId, accountId, clipPath, caption, dryRun?}` | job | buat `ig_publish_jobs`, jalankan alur IG; dry-run tercatat tanpa kredensial |
| `GET /api/klip/ig/jobs?projectId=` | — | status per item | untuk UI status panel |

Rujukan perilaku IG: `server/instagram.js`, `publishReel.js`, `igBatch.js`, `igAccounts.js` Klip (alur + pesan error), **implementasi baru** di stack opencut. Poin perilaku yang dipertahankan: token long-lived di DB (bukan file JSON), URL publik wajib non-localhost untuk container (`resolvePublicBaseUrl`), alur container→poll→publish.

---

## 6. Auth + Redis: apa yang berubah / tidak

- **Auth (better-auth + drizzleAdapter) TIDAK diubah** — adapter resmi mendukung MySQL, jadi pindah dialect tidak menyentuh logika auth.
- **Redis hanya dipakai rate-limit auth** (`auth/rate-limit.ts` via `UPSTASH_REDIS_REST_URL`). Satu-satunya ketergantungan Redis di `src`. Redis tersedia di server → **tanpa perubahan kode**: jalankan jembatan `serverless-redis-http` kecil mengarah ke Redis server, atau arahkan env ke endpoint setara.

---

## 7. Task 0 amandemen: MySQL + verifikasi + sinkron

Task 0 dokumen ("git clone") sudah lewat — repo ini SUDAH fork (remote `upstream` terpasang, `LICENSE` asli utuh). Task 0 menjadi:

**0a. Sinkron + verifikasi baseline (tanpa clone ulang):** `git fetch upstream` + merge/rebase `upstream/main` yang relevan; `bun install`; build wasm (`wasm-pack build rust/wasm --target bundler`); `bun run dev:web`; buka editor bawaan → import 1 video lokal → tambah 1 text layer → export MP4/WEBM berhasil. Push baseline ke `origin/main`.

**0b. Ganti dialect ke MySQL (SEBELUM tabel Klip ada):**

1. `apps/web/src/db/schema.ts`: `pgTable` → `mysqlTable`; hapus semua `.enableRLS()`; kolom unik berbasis teks (`users.email`, `sessions.token`) jadi `varchar(255)` (MySQL menolak unique index pada `TEXT` tanpa panjang kunci — tanpa ini migrasi gagal total).
2. `apps/web/src/db/index.ts`: driver `postgres` → `mysql2`; `drizzle-orm/mysql2`.
3. `apps/web/drizzle.config.ts`: `dialect: "mysql"` + betulkan path schema (`./src/lib/db/schema.ts` → `./src/db/schema.ts`; temuan grounding: path lama kemungkinan membuat `db:generate` rusak dari sananya).
4. `.env`: `DATABASE_URL=mysql://user:pass@host:3306/klip` menunjuk MySQL server yang sudah ada.
5. Regenerasi `apps/web/migrations/` dari nol; `docker-compose.yml` dibiarkan apa adanya (untuk dev lokal), deploy server tidak memakainya.
6. Validasi env: `apps/web/src/env/web.ts` refine `DATABASE_URL` saat ini menolak non-postgres — harus dilonggarkan ke `mysql://`.

**0c. Legal baseline:** `LICENSE` asli dipertahankan + tambah notice Klip di bawahnya (dokumen sudah mencatat; eksekusi di Task 9, tapi pastikan tidak ada langkah yang menghapus atribusi).

---

## 8. Eksekusi Opsi A: irisan vertikal (4 slice demo-able)

Setiap slice berakhir dengan sesuatu yang bisa didemo. Template dikeluarkan dari semua slice (skip v1).

### Slice 1 — Upload single → brand → export (risiko terbesar dibuktikan dulu)

- 0b (MySQL) + tabel `klip_media`, `klip_projects`, `klip_brand_layers`.
- `POST /api/uploads` + wiring `use-file-upload.ts` + pendaftaran media bin.
- Crate `rust/crates/klip` (brand-map) + binding wasm + test bulat-balik.
- Panel brand minimal: daftar + upload + eye + hapus + inspector Transform (scale, X/Y, rotate, opacity) + full/timed + volume/duck (audio). Tanpa library/template di slice ini (upload langsung saja).
- **Demo 1:** upload 1 video → tambah 2 brand layer (drag/rotate/z-order) → export MP4 brand menempel.

### Slice 2 — ZIP batch → N proyek

- `POST /api/klip/batch-zip` (AdmZip, guard traversal, max 50) + `GET` proyek + grid main page (campuran dengan proyek single).
- Seed brand defaults library saat proyek dibuat (bukan template — kit default WM/BGM ala `seedBrandLayers`).
- Migrasi data lama opsional (`scripts/migrate-klip.mjs`, path absolut→relatif).
- **Demo 2:** upload ZIP 2 video → 2 proyek → buka masing-masing di editor.

### Slice 3 — Publish Instagram

- Tabel `ig_accounts`, `ig_publish_jobs` + `POST /api/klip/ig/publish` + UI status + dry-run tercatat.
- Verifikasi: token di DB (bukan file JSON), publish tercatat per item.
- **Demo 3:** publish 1 render ke IG (atau dry-run tercatat).

### Slice 4 — Main page + legal + E2E

- `/` = grid proyek Klip + dropzone single/ZIP (tiru UX `public/index.html` Klip: dropzone, progress, status), kartu → `/editor/[project_id]`.
- Rebrand UI + `LICENSE` notice + README credit + `docs/klip-*.md`.
- Verifikasi E2E penuh (definisi selesai §1); bug baru dicatat (maks 3 fix per bug lalu diskusi arsitektur).

---

## 9. File yang berubah (ringkas, per slice)

- **Slice 1:** `rust/crates/klip/*` (baru), `rust/wasm/*` (binding), `apps/web/src/db/schema.ts` + `migrations/` (MySQL + tabel klip), `apps/web/src/db/index.ts`, `drizzle.config.ts`, `src/env/web.ts`, `app/api/uploads/route.ts` (baru), `media/use-file-upload.ts`, `klip/brand-panel.tsx` (baru, minimal), registrasi panel editor, `preview/*` bila paritas kurang.
- **Slice 2:** `app/api/klip/batch-zip/route.ts`, `app/api/klip/projects/*`, `app/page.tsx` (grid), `scripts/migrate-klip.mjs` (baru, opsional).
- **Slice 3:** `klip/instagram/*` (baru), tabel `ig_*`.
- **Slice 4:** `app/page.tsx` final, README, LICENSE notice, `docs/klip-*.md`.

---

## 10. Risiko + mitigasi

| Risiko | Mitigasi |
|---|---|
| Build WASM/Rust gagal di mesin baru | pakai prebuild `pkg/` bila ada, atau `cargo update` + toolchain stable |
| Export browser ≠ FFmpeg Klip untuk rotate/opacity | toleransi visual + catat (bukan blokir) |
| Publish IG butuh kredensial + review Meta | dry-run tercatat selalu tersedia |
| Unique index `TEXT` gagal di MySQL | `varchar(255)` untuk kolom unik (wajib, §7) |
| Timeout bash tool untuk build panjang | build dijalankan manual di server/terminal, bukan via tool |
| Menjauh dari upstream di area DB | sadar + didokumentasikan; merge upstream area DB perlu perhatian |
| Timeline JSON browser vs registry MySQL divergen | rehidrasi otomatis saat buka editor (§2.2); sync penuh di luar v1 |

---

## 11. Pertanyaan terbuka

Tidak ada — semua keputusan infrastruktur terkunci (MySQL + Redis tersedia di server, deploy manual + PM2).
