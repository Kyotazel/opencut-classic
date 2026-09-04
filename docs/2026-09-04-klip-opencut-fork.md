# Klip × OpenCut — Goal Akhir + Plan Fork (untuk sesi baru)

> Dibuat: 2026-09-04. Keputusan user: (1) timeline + canvas preview opencut dipakai
> keduanya, (2) publish IG mengikuti cara Klip Studio sekarang (dimodifikasi di
> opencut), (3) repo public = fork opencut + fitur Klip.
> Referensi lokal saat menulis: `/tmp/opencut-classic` (clone depth-1).
> Lisensi opencut-classic = MIT — wajib sertakan copyright + teks lisensi OpenCut
> di repo fork (boleh tambah notice Klip di bawahnya).

---

## GOAL AKHIR

**Satu repo public (fork opencut-classic + fitur Klip) yang menjadi main app:**

1. **Editor opencut utuh** — timeline (split/ripple/drag antar-track/snap), canvas
   preview (GPU compositor), transform handle penuh, text layer, efek/mask dasar.
   Dipakai apa adanya, bukan ditulis ulang.
2. **Upload video + ZIP batch ala Klip** — upload single → 1 proyek; upload ZIP →
   N proyek (satu video = satu proyek), dengan template opsional. File tersimpan
   server-side dan terdaftar di media bin.
3. **Brand overlay model Klip di atas track opencut** — layer brand
   (`x/y/scale/rotate/opacity/full/start/dur/volume/duck`) dipetakan ke
   graphic/image/video/audio element + track opencut; transform, z-order, dan
   timing dikendalikan lewat UI opencut; ikut terbakar saat export.
4. **Publish Instagram cara Klip** — alur + kredensial + posting mengikuti Klip
   Studio sekarang (`server/` lama sebagai rujukan perilaku, BUKAN dipakai
   langsung): simpan token di `db/` (Drizzle/Postgres), endpoint publish,
   status per item. Bukan cara opencut (mereka tidak punya fitur ini).
5. **Main page = proyek + upload** — landing repo adalah grid proyek + upload
   (single/ZIP), bukan marketing site opencut.

**Definisi selesai:** fresh clone → `bun install` + `docker compose up` + build wasm
→ upload 1 video → tambah 2 brand layer (drag/rotate/z-order) → export MP4
brand menempel → upload ZIP 2 video → 2 proyek → publish 1 ke IG (atau dry-run
tercatat bila tanpa kredensial). Semua hijau.

**Yang SENGAJA tidak masuk goal:** pipeline AI caption Klip (transkripsi/LLM),
B-roll generate, TikTok publish, animasi keyframe lanjutan. Masuk backlog v2.

---

## PLAN (11 task, urut eksekusi)

### Task 0 — Siapkan mesin + fork + bukti jalan (prasyarat semua)

**Files:** — (kerja shell + GitHub)
**Isi:**
- Install: `bun -v` ≥ 1.x, `docker -v`, `cargo -v` + `wasm-pack`.
- `git clone --depth 1 https://github.com/opencut-app/opencut-classic klip-opencut`
- Pertahankan `LICENSE` asli (MIT OpenCut 2025–2026) + tambah notice Klip.
  Ganti nama/brand UI (bukan hapus atribusi).
- `bun install`, `docker compose up -d` (Postgres 17 + Redis), build wasm
  (`wasm-pack build rust/wasm --target bundler --out-dir pkg`), `bun run dev:web`.
- Verifikasi: buka editor bawaan, import 1 video lokal, tambah 1 text layer,
  export MP4/WEBM (`export/` → `downloadBuffer`) berhasil.
- Push ke repo public kamu sebagai commit awal (`main`).
**Verifikasi:** `bun run dev:web` jalan, export 1 MP4 dari editor bawaan.

### Task 1 — Upload video server-side + media bin

**Files:**
- Create: `apps/web/src/app/api/uploads/route.ts` (POST multipart → simpan disk/BLOB + record DB)
- Modify: `apps/web/src/media/use-file-upload.ts` (kirim ke route, progress,ेश),
  media bin/store pendaftaran aset (`media/` + `project/`)
- Test: upload 1 MP4 via UI → muncul di media bin → bisa di-drop ke timeline
**Interfaces:**
- Consumes: `useFileUpload({accept, multiple, onFilesSelected})`, `editor.timeline.dragSource`
- Produces: `POST /api/uploads → {mediaId, url, width, height, duration, thumbnailUrl}`
**Verifikasi:** refresh tidak menghilangkan aset (persist server, bukan state browser).

### Task 2 — Model proyek Klip: ZIP → N proyek + template

**Files:**
- Create: tabel `klip_projects` + `klip_brand_layers` (Drizzle `src/db/schema.ts` + migrasi),
  `POST /api/klip/batch-zip` (AdmZip extract, guard traversal, max 50),
  `GET /api/klip/projects`, `GET /api/klip/projects/:id`
- Modify: halaman `app/projects/page.tsx` (grid + link editor per proyek)
- Test: upload ZIP 2 MP4 → 2 proyek → buka masing-masing di editor
**Interfaces:**
- Consumes: `POST /api/uploads` (Task 1)
- Produces: `TBatchZipResult {batchId, count, children: {id, name}[]}`,
  `TKlipProject {id, name, source{…}, brand: TKlipBrandLayer[]}`
- Model brand (pertahankan SEMUA field Klip):
  `{id, asset_id|file, name, kind: image|video|audio, enabled, x/y 0–1,
  scale, rotate derajat, opacity 10–100, full/start/dur waktu-hasil,
  volume 0–2, duck}`
**Verifikasi:** proyek batch content-nya sama dengan `data/projects/prj_*.json` Klip
(field `source.file`, `brand.layers[]`) — migrasi data lama opsional via script.

### Task 3 — Brand layer ↔ track opencut (pemetaan inti)

**Files:**
- Create: `apps/web/src/klip/brand-map.ts`
  (`klipLayerToElement(layer) → CreateImageElement|CreateVideoElement|CreateAudioElement`,
  `elementToKlipLayer(el) → patch`) + test unit
- Modify: insert path (upload/insert → tambah element ke graphic/video/audio track),
  panel brand (daftar, eye, hapus, z-order), `params/` bila perlu field `rotate`
**Interfaces:**
- Consumes: `TKlipBrandLayer`, `SceneTracks {overlay, main, audio}`,
  `Create*Element` (`timeline/types.ts`), `ElementUpdatePatch`
- Produces: `klipLayerToElement`, `elementToKlipLayer`, `BRAND_TRACK = "graphic"`
- Aturan: visual → graphic track (image) / overlay video track (video) / audio
  track (audio); `x/y/scale/rotate/opacity` → `params`; `startTime/duration`
  dari `full/start/dur`; `hidden` dari `enabled`; urutan array = z-order
  (bawah→atas); `trimStart/trimEnd` default 0
**Verifikasi:** test unit bulat-balik (layer→element→layer identik kecuali `id`).

### Task 4 — Panel brand Klip di UI opencut

**Files:**
- Create: `apps/web/src/klip/brand-panel.tsx` (daftar + upload + library + template + inspector Transform)
- Modify: registrasi panel/sidebar editor (`panels/`, `editor/` store)
- Isi: Transform (Scale slider, Position X/Y, Rotate ±45/±180, Opacity),
  Full/timed (start/dur), Volume+Duck (audio), eye, ▲▼ z-order, Hapus (+undo),
  Sisipkan dari library, Tempel template (ganti seluruh layers + caption/bgm bila ada)
**Verifikasi:** semua aksi panel mengubah element timeline yang benar + undo sekali.

### Task 5 — Paritas preview ↔ export untuk brand

**Files:**
- Modify: renderer/preview bounds (`preview/element-bounds.ts`, `graphics/`,
  `rendering/`) bila rotate/opacity belum setara
- Test: render 1 proyek (image rotate 15° + video timed) → overlay ≈ preview
- Aturan: tanpa rotate = tanpa filter tambahan (tanpa regresi); `rotate≠0`
  canvas membesar (ow/oh) — catat toleransi ±beberapa px sudut besar
**Verifikasi:** bandingkan frame export vs screenshot preview (visual check).

### Task 6 — Publish Instagram cara Klip

**Files:**
- Create: `apps/web/src/klip/instagram/` (OAuth/token store di `db/schema.ts`,
  `POST /api/klip/ig/publish`, status per item), UI status di panel/publish
- Rujukan perilaku: Klip `server/instagram.js`, `publishReel.js`, `igBatch.js`,
  `igAccounts.js` (alur + pesan error), TAPI implementasi baru di stack opencut
- Test: dry-run publish 1 item tercatat (tanpa kredensial asli bila belum diset)
**Verifikasi:** token tersimpan di DB (bukan file JSON), publish tercatat per item.

### Task 7 — Main page = proyek + upload

**Files:**
- Modify: `apps/web/src/app/page.tsx` (grid proyek Klip + dropzone single/ZIP +
  pilih template), `app/projects/page.tsx` (tetap sebagai arsip/legacy bila perlu)
- Isi: tiru UX `public/index.html` Klip (dropzone, progress XHR, status),
  link kartu → `/editor/[project_id]`
**Verifikasi:** dari `/` bisa upload single + ZIP + buka editor tanpa lewat URL manual.

### Task 8 — Migrasi data Klip lama (opsional tapi disarankan)

**Files:**
- Create: `scripts/migrate-klip.mjs` (baca `Klip-Studio/data/{projects,brand.json,templates.json}`
  → tulis DB baru; path absolut → relatif/portabel)
- Verifikasi: 2 proyek batch lama (`batch_7cdf1fden7zs`) terbuka + video + WM tampil

### Task 9 — Rebrand + legal + docs

**Files:** `LICENSE` (notice OpenCut dipertahankan), README (credit fork + beda fitur),
  nama/logo/nav, `docs/klip-*.md` (arsitektur, pemetaan brand, alur publish)
**Verifikasi:** `grep -ri opencut` hanya di LICENSE/credit, bukan brand UI.

### Task 10 — Verifikasi E2E penuh (definisi selesai di Goal)

Tanpa perubahan kode. Ikuti 5 langkah Goal; catat gagal sebagai bug baru
(maks 3 fix per bug lalu diskusi arsitektur). Target: semua hijau.

---

## File yang kemungkinan berubah (ringkas)

- `apps/web/src/app/api/uploads/route.ts` (baru), `app/api/klip/*` (baru)
- `apps/web/src/db/schema.ts` + `migrations/` (tabel klip)
- `apps/web/src/klip/brand-map.ts`, `brand-panel.tsx`, `instagram/` (baru)
- `apps/web/src/media/use-file-upload.ts`, `app/page.tsx`, `app/projects/*`
- `apps/web/src/preview/*`, `rendering/*` (hanya bila paritas kurang)
- `scripts/migrate-klip.mjs` (baru)

## Risiko

- WASM/Rust build gagal di mesin baru → fallback: pakai prebuild `pkg/` bila ada,
  atau `cargo update` + toolchain stable.
- Export browser ≠ FFmpeg Klip untuk rotate/opacity → toleransi visual + catat.
- Publish IG butuh kredensial + review app Meta → sediakan dry-run tercatat.
- DB Postgres wajib jalan (compose) — tanpa itu upload/proyek tidak persist.
