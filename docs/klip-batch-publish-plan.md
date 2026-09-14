# Klip x OpenCut - Batch ZIP -> Template -> Auto-Publish Instagram

**Status:** Tahap 1 & 2 SELESAI (lokal, belum di-deploy)  
**Repo:** Klip x OpenCut (fork), produksi `https://opencut.ordoagentic.ai`

---

## 1. Tujuan

Dari satu upload ZIP berisi banyak video, sistem secara otomatis:

1. Mengekstrak dan membuat satu project per video
2. Menempelkan template brand (logo, teks, post-roll) ke setiap project
3. Merender video jadi (MP4)
4. Mempublikasikan ke Instagram
5. Mengulang (retry) yang gagal - maksimal **5x**, boleh sampai besok

**Goal akhir (jangka panjang):** tidak ada upload ZIP dari UI lagi - sistem lain memanggil **API** kita. Manusia hanya menyentuh dua hal: **setting template** dan **setting Instagram**. Semua langkah lain otomatis.

---

## 2. Keputusan yang sudah final

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Render di mana? | **Server (A1)** - headless browser di `third` |
| 2 | Kapan render jalan? | **Window waktu yang bisa diatur.** Contoh: API terima jam 8, window 11-15 -> job jalan jam 11-15. Di luar window job **menunggu**, tidak hilang. Ada tuas **"jalankan sekarang"** (user memaksa) - boleh dibatasi/tidak via setting |
| 3 | Template mana? | **Template default global** + **pilihan eksplisit per-request** (eksplisit menang) |
| 4 | Dry run? | **Tidak.** Langsung publish |
| 5 | Bentuk input ZIP | **Multipart (UI)** *dan* **`zip_url` (API)** - didukung sejak Tahap 1 |
| 6 | Pemilik project batch | **User ID pertama di database** (pragmatis untuk sekarang; lihat Notes T1-3) |
| 7 | Skala volume | Puluhan video, bukan ratusan - tidak perlu mesin terpisah untuk sekarang |

---

## 3. Kondisi saat ini: yang sudah ada vs belum

Sudah ditelusuri langsung di kode, bukan asumsi.

### Sudah ada

| Bagian | Lokasi |
|---|---|
| Upload ZIP -> extract (guarded zip-slip) | `apps/web/src/klip/batch-upload.ts` (`yauzl`, sudah uji traversal) |
| Endpoint upload ZIP | `apps/web/src/app/api/uploads/batch/route.ts` (batas 2 GB, in-memory) |
| ZIP -> buat project per video | `apps/web/src/klip/batch-projects.ts` |
| Template: simpan / terapkan | `apps/web/src/klip/templates.ts`, `/api/klip/projects/[id]/save-as-template`, `/apply-template` |
| Toggle **"Di akhir video"** (post-roll) | kolom `anchor` enum `start`/`main_end` |
| Toggle **"Lebar penuh"** (full width) | kolom `fit` enum `free`/`full_width` |
| Publish IG (container -> poll -> publish) | `apps/web/src/klip/ig-publish.ts`, `ig-api.ts` |
| Tabel publish + item | `klip_ig_publishes`, `klip_ig_publish_items` |
| Kolom `batch_id` di project | `klip_projects.batchId` (sudah ada) |
| OAuth Instagram | `/api/klip/ig-accounts/*` (sudah live di produksi) |

### Belum ada

| Bagian | Catatan |
|---|---|
| Tabel batch/job | `klip_projects.batchId` **tidak punya tabel induk** - masih string lepas |
| Worker / proses latar | Tidak ada. Semua kerja sekarang terjadi di dalam request HTTP |
| Antrian + retry state | Tidak ada |
| Window waktu (11-15) | Tidak ada |
| Render headless di server | Tidak ada - **lihat bagian 4** |
| Endpoint API untuk sistem lain | Belum ada |
| Dashboard batch | Belum ada |

---

## 4. Temuan kritis: render di server saat ini TIDAK MUNGKIN

Ini fakta keras, sudah diverifikasi:

> `apps/web` memakai paket **`opencut-wasm@0.2.10` dari npm**, **bukan** build lokal `rust/wasm/pkg`.
> Paket npm itu **tidak punya binding klip** - tidak ada `brand_map`, tidak ada `template_resolve`.

Artinya:

- Template yang kita bangun **tidak bisa dijalankan di Node**. Bukan "belum dikonfigurasi" - kodenya memang tidak ada di paket itu.
- Yang ada di server hanyalah **logika TypeScript** (`brand-map.ts`) = perhitungan posisi. **Perhitungan posisi != render video.**
- `ffmpeg` ada di server, tapi ffmpeg tidak tahu apa itu "layer brand di detik 23 dengan skala 0.36 dan anchor main_end". Overlay ffmpeg bisa, tapi **tidak menghormati animasi/keyframe**.

### Pilihan render di server

| Opsi | Artinya | Penilaian |
|---|---|---|
| **A1** Headless browser (Playwright/Chromium) | Jalankan editor kita sendiri di server, suruh render | **Satu-satunya realistis** untuk sekarang |
| **A2** Port render engine ke Node/Rust-native | Pindahkan compositor ke Rust, jalan di Node | Sangat besar - proyek tersendiri |
| **A3** Overlay lewat filter ffmpeg | Tempel PNG/teks via ffmpeg | Terbatas - tidak hormati animasi |

### Konsekuensi A1 yang harus diketahui

`third` menjalankan **13 vhost nginx lain**, MySQL, dan aplikasi kita. Menambah Chromium yang merender video 1080p berarti:

- **CPU** - render 1 video 30 detik kira-kira **1-3 menit CPU penuh**. Beberapa bersamaan -> situs lain ikut melambat.
- **RAM** - Chromium + decode video + canvas 1080p kira-kira **1-2 GB per proses**. Ini yang paling berbahaya (risiko OOM).
- **Disk** - `third` sudah **~85% penuh**. Chromium kira-kira 400 MB + ruang kerja render.

**Mitigasi yang sudah diputuskan:** window waktu (keputusan #2) membatasi beban ke jam tertentu, sehingga di luar window server kembali normal. Ini juga otomatis menahan laju publish agar tidak kena rate limit IG.

---

## 5. Arsitektur target

```
+- API (sekarang di third) -------------------+
| POST /api/klip/batches                      |  <- dipakai UI DAN sistem lain
|   { zip_url | multipart, template_id? }     |
|   -> simpan ZIP ke disk                     |
|   -> buat baris batch (status: queued)      |
|   -> balas 202 + batch_id                   |
+---------------------------------------------+
                    |
                    v  antrian di MySQL (BUKAN Redis)
+- Worker (proses terpisah, systemd/pm2) -----+
| ambil job -> extract zip -> buat project    |
| -> tempel template -> render -> simpan      |
| -> publish IG -> update status              |
| hormati window waktu + tuas "jalan sekarang"|
+---------------------------------------------+
                    |
                    v
        dashboard: lihat batch, status per video, retry, log
```

**Kenapa MySQL, bukan Redis?**
Redis di produksi **belum jalan** (masih `placeholder` di port 8079 - utang dari sesi sebelumnya). Untuk skala puluhan video, MySQL cukup, dan isi antrian bisa diperiksa pakai SQL biasa saat ada masalah. Kalau nanti jadi ratusan ribu, baru pindah.

**Kenapa retry dijadwalkan (`next_attempt_at`), bukan langsung?**
Karena rate limit IG. Worker mencoba -> gagal karena limit -> **kembalikan ke antrian dengan jadwal besok** -> lanjut ke job berikutnya. Ini persis keputusan #2 di bagian 2.

---

## 6. Model data (rancangan)

### Tabel baru

**`klip_batches`** - satu baris per upload ZIP

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | varchar(64) PK | prefix `b_` |
| `owner_user_id` | varchar(64) | **dari env** `KLIP_OWNER_ID` atau `APP_USER` (keputusan #6 revisi) |
| `template_id` | varchar(64) nullable | null = pakai default global |
| `source` | enum(`upload`,`api`) | dari UI atau dari sistem lain |
| `zip_path` | varchar(1024) | lokasi ZIP tersimpan |
| `status` | enum(`queued`,`running`,`done`,`partial`,`failed`) | status batch |
| `total` / `succeeded` / `failed` | int | hitungan |
| `created_at` / `updated_at` | timestamp | |

**`klip_batch_jobs`** - satu baris per video, **ini antriannya**

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | varchar(64) PK | prefix `j_` |
| `batch_id` | FK -> `klip_batches` cascade | |
| `project_id` | FK -> `klip_projects` nullable | terisi setelah project dibuat |
| `status` | enum(`queued`,`extracting`,`rendering`,`rendered`,`publishing`,`published`,`failed`,`cancelled`) | |
| `stage` | varchar(32) | tahap terakhir yang berhasil (untuk resume) |
| `attempts` | int default 0 | |
| `max_attempts` | int default 5 | **retry 5x** |
| `next_attempt_at` | timestamp | **jadwal retry** (bisa besok) |
| `rendered_path` | varchar(1024) | hasil render MP4 |
| `publish_id` | FK -> `klip_ig_publishes` nullable | |
| `error` | text | pesan gagal terakhir |
| `locked_at` / `locked_by` | | klaim job agar tidak dobel |
| `created_at` / `updated_at` | | |

### Tabel `klip_settings` - DISETUJUI: key-value

**Keputusan:** pakai tabel **key-value**, bukan kolom tetap.

```
klip_settings
  key         varchar(64)  PK
  value       text         NOT NULL
  updated_at  timestamp
```

**Kunci yang dipakai:**

| Key | Nilai contoh | Keterangan |
|---|---|---|
| `render_window_enabled` | `"1"` / `"0"` | on/off window |
| `render_window_start` | `"11:00"` | format `HH:MM` waktu server |
| `render_window_end` | `"15:00"` | format `HH:MM` |
| `allow_manual_run` | `"1"` / `"0"` | boleh "jalankan sekarang" atau tidak |
| `default_template_id` | `"tpl_ab12..."` | template default global |
| `default_ig_account_id` | `"ig_ab12..."` | akun IG tujuan default |
| `publish_failure_threshold` | `"2"` | ambang circuit breaker (N1) |

**Alasan memilih key-value:** setting baru (mis. jam kedua, batas harian, akun kedua) bisa ditambah **tanpa migrasi database**. Ini penting karena proyek ini masih akan banyak berubah menuju goal akhir API-driven.

**Konsekuensi yang harus diingat:** tidak ada validasi tipe dari database. Nilai disimpan sebagai teks, jadi **harus divalidasi di kode saat dibaca**. Setiap key butuh helper pembaca sendiri (mis. `getBoolSetting`, `getTimeSetting`) supaya parsing manual tidak tersebar.

### Reuse yang sudah ada

- `klip_projects.batchId` -> tinggal diarahkan ke `klip_batches.id`
- `klip_ig_publishes` + `klip_ig_publish_items` -> **sudah** punya `status`, `attempts`, `error`, `permalink`. Tahap 4 sebagian besar tinggal memakai.

---

## 7. Rencana bertahap (cicilan)

Setiap tahap **berdiri sendiri** - bisa dipakai dan diuji tanpa menunggu tahap berikutnya.

### Tahap 1 - Antrian + tabel + API masuk
**Bangun:** tabel `klip_batches` + `klip_batch_jobs` + tabel setting. Endpoint `POST /api/klip/batches` (multipart **dan** `zip_url`). Status awal `queued`. **Belum ada yang mengerjakan.**

**Bisa diuji:** kirim ZIP -> baris masuk database -> status `queued`.

**Notes:**
- **T1-1** Dukung **dua** bentuk input sejak awal (`multipart` untuk UI, `zip_url` untuk API). Konsekuensi: worker harus bisa *download* + *verifikasi*, bukan cuma baca buffer.
- **T1-2** `/api/uploads/batch` sekarang punya **dua batas yang bertentangan**: kode izinkan 2 GB, nginx dibatasi `client_max_body_size 500m`. Harus diselaraskan di tahap ini.
- **T1-3** Pemilik = dari **env** (`KLIP_OWNER_ID`, fallback `APP_USER`), nilai disimpan sebagai `app:<nilai>`. **Sengaja pragmatis.**
  - **Revisi penting:** rancangan awal memakai "user pertama di tabel `users`". Itu **salah** dan langsung terlihat saat diuji di browser (HTTP 409): login app ini memakai cookie HMAC dari `APP_USER`/`APP_PASSWORD` (`klip/auth-session.ts`), **bukan Better Auth**, sehingga tabel `users` **kosong** di lokal maupun produksi. 10 project yang ada dibuat oleh `resolveOrCreateProject` yang menyusun barisnya sendiri.
  - Kode sengaja **tidak** membaca tabel `users` sama sekali. Kalau kelak tabel itu terisi (Better Auth dinyalakan), owner batch tidak boleh diam-diam berpindah — sumber harus satu dan eksplisit.
  - Saat API-driven nanti tidak ada user login, jadi ini diganti `owner` per-request (Tahap 5). Perlu migrasi data saat itu - dicatat supaya tidak kaget.
- **T1-4** ZIP disimpan ke disk (`KLIP_DATA_ROOT`), **jangan** in-memory. `yauzl.fromBuffer` sekarang memuat seluruh ZIP ke RAM - tidak aman untuk 500 MB+.

### Tahap 2 - Worker: extract + buat project + tempel template
**Bangun:** proses Node terpisah, polling tabel job. Alur: download/extract ZIP -> buat project per video -> terapkan template (default global atau eksplisit). Berhenti di status `rendered_pending`.

**Bisa diuji:** kirim ZIP -> tunggu -> project muncul di UI dengan template sudah menempel. **Belum ada video keluar.**

**Notes:**
- **T2-1** Project hasil batch **muncul di UI user mana?** Perlu diputuskan cara menampilkan/memfilter, terutama saat nanti tidak ada manusia.
- **T2-2** Worker harus **idempoten**: crash di tengah lalu dijalankan ulang tidak boleh membuat project duplikat. Pakai `stage` untuk resume.
- **T2-3** Klaim job pakai `locked_at`/`locked_by`. Redis belum jalan, jadi pakai `SELECT ... FOR UPDATE` MySQL.

### Tahap 3 - Render headless (A1) <- PALING RAPUH
**Bangun:** Playwright/Chromium memuat project, memicu render, simpan MP4. Plus window 11-15 + tuas "jalankan sekarang".

**Bisa diuji:** job render menghasilkan MP4 yang benar (template terlihat, durasi benar - termasuk post-roll 30s + 7s = 37s).

**Notes:**
- **T3-1** **Belum bisa dijanjikan.** Perlu dijawab dulu: (a) apakah render browser jalan **tanpa GPU**, (b) berapa lama 1 video, (c) apakah hasil dijamin identik dengan yang terlihat di browser. Angka nyata baru ada setelah dicoba.
- **T3-2** Chromium kira-kira 400 MB harus di-install di `third` - **disk sudah 85%**, wajib dicek dulu.
- **T3-3** **Jangan mulai tahap ini sebelum Tahap 1-2 stabil.**
- **T3-4** Batasi **1 render bersamaan** (bukan paralel) untuk melindungi 13 vhost lain. Konsekuensi: batch besar jadi lambat - itu trade-off yang diterima.
- **T3-5** Window adalah tuas tunggal yang menyatukan CPU + RAM + rate limit IG. Pastikan juga menahan tahap publish, bukan hanya render.

### Tahap 4 - Publish IG + retry 5x + rate limit
**Bangun:** container -> poll -> publish lewat worker yang sama. Retry 5x dengan `next_attempt_at`. Rate limit.

**Bisa diuji:** video benar-benar muncul di Instagram; simulasi gagal -> retry terjadwal.

**Notes:**
- **T4-1** Redis akhirnya relevan di sini (rate limit + lock agar 2 worker tidak publish bersamaan). Tapi `SELECT ... FOR UPDATE` cukup untuk sekarang - Redis boleh tetap ditunda.
- **T4-2** **Circuit breaker** dipasang di sini (aturan lengkap di bagian 8 N1). Perlu dipisahkan dengan jelas: kegagalan **konten** (menghitung breaker) vs kegagalan **infrastruktur** (di-retry, tidak menghitung).
- **T4-3** Batas publish IG per 24 jam (umumnya 25-50/hari untuk akun bisnis). Job yang kena limit **dijadwalkan besok**, bukan digagalkan permanen.

### Tahap 5 - Dashboard + otomasi penuh
**Bangun:** UI lihat batch, status per video, tombol retry, log. Lalu API untuk sistem lain (tanpa manusia).

**Notes:**
- **T5-1** Ini titik goal akhir tercapai - sekaligus titik di mana **kesalahan jadi paling mahal**, karena tidak ada manusia di lingkaran. Circuit breaker jadi kritis.
- **T5-2** Perlu autentikasi API untuk sistem lain (API key). Belum dirancang.

---

## 8. Catatan risiko (Notes)

### N1 - Tanpa dry run, kesalahan menyebar cepat
**Diputuskan:** langsung publish, tidak ada dry run.  
**Risiko:** kalau template salah, puluhan video terkirim ke akun IG publik dalam satu window, dan yang salah **harus dihapus manual satu per satu dari HP**. Tidak ada undo.

**Mitigasi - DISETUJUI:** **circuit breaker** - kalau 2 job pertama gagal, seluruh batch berhenti. Tidak mengubah apa pun soal otomatisasi; kalau semua sukses, perilakunya identik dengan langsung tembak.

> Status: **DISETUJUI user.** Dipasang di Tahap 4 (lihat T4-2). Aturan konkret:
> - Hitung kegagalan berturut-turut **per batch** (bukan global).
> - Ambang: **2 kegagalan berturut-turut** pada tahap publish -> batch berhenti, sisa job jadi `cancelled`.
> - Kegagalan yang **bukan salah konten** (rate limit IG, token kedaluwarsa, jaringan) **tidak** dihitung - itu di-retry, bukan tanda template salah.
> - Batch yang berhenti karena breaker harus **berisik**: status `halted` + alasan terlihat di dashboard, bukan diam-diam berhenti.

### N2 - Utang Redis
Redis produksi belum jalan (port 8079, `placeholder`). Akibat saat ini: `/api/feedback` dan `/api/sounds/search` **error 500**. Login tidak terpengaruh (pakai `Map` in-process). Rencana: antrian pakai MySQL sehingga Redis bisa ditunda sampai Tahap 4.

### N3 - `pm2 save` belum dijalankan
**App produksi sekarang tidak akan hidup lagi kalau server reboot.** Ini utang paling mendesak dan **independen** dari proyek ini.

```bash
pm2 save
pm2 startup systemd -u root --hp /root
systemctl is-enabled pm2-root
```

### N4 - Disk `third` ~85%
Render butuh ruang kerja sementara + Chromium 400 MB. **Wajib dicek sebelum Tahap 3.** Hitung 3x lipat: ZIP -> ekstrak -> hasil render.

### N5 - Keamanan
`BETTER_AUTH_SECRET` dan password MySQL pernah terekspos di chat - **belum dirotasi**. `APP_PASSWORD=secret123` juga masih default.

### N6 - Prinsip: sistem tidak menebak
Dua bug sebelumnya (anchor post-roll salah, angka 25.84 di video 30 detik) berakar pada sistem **menebak** maksud user. Penerapan di proyek ini: template wajib **eksplisit** (per-request) atau **default yang diset user** - jangan pernah menyimpulkan dari nama file/konten.

---

## 9. Keputusan yang sudah ditutup

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | **Circuit breaker** untuk publish (bagian 8 N1) | **DITERIMA** user - aturan di N1, dipasang di T4-2 |
| 2 | Bentuk tabel setting | **`klip_settings` key-value** - spec di bagian 6 |
| 3 | Lokasi kode worker | Belum - diputuskan saat Tahap 2 |
| 4 | Cara worker jalan | Belum - diputuskan saat Tahap 2 |
| 5 | Tampilan project batch di UI (T2-1) | Belum - diputuskan saat Tahap 2 |
| 6 | Autentikasi API sistem lain (T5-2) | Belum - diputuskan saat Tahap 5 |

### Revisi keputusan

| Keputusan awal | Revisi | Sebab |
|---|---|---|
| Pemilik batch = **user pertama** di tabel `users` (bagian 2 #6) | Pemilik = **env** `KLIP_OWNER_ID` (fallback `APP_USER`), disimpan `app:<nilai>` | Tabel `users` ternyata **kosong** - login memakai cookie `APP_USER`, bukan Better Auth. Rancangan awal menghasilkan HTTP 409 saat diuji di browser. Detail di T1-3. |

---

## 10. Status Tahap 1 - SELESAI

| # | Kriteria | Status |
|---|---|---|
| 1 | Tiga tabel di `schema.ts` + migrasi `0007_demonic_mysterio` | OK |
| 2 | `POST /api/klip/batches` terima **multipart** dan **`zip_url`** | OK |
| 3 | ZIP disimpan **ke disk** (`KLIP_DATA_ROOT/batches/`), bukan in-memory | OK |
| 4 | Baris `klip_batches` (`queued`) + `klip_batch_jobs` per video | OK |
| 5 | Respons `202` + `batch_id` | OK |
| 6 | Test: multipart, `zip_url`, non-zip, traversal | OK (15 tes) |

**File baru:** `src/klip/settings.ts`, `src/klip/batch-store.ts`, `src/klip/batch-service.ts`,
`src/app/api/klip/batches/route.ts`, `src/klip/__tests__/batch-api.test.ts`,
`migrations/0007_demonic_mysterio.sql`.

> Belum ada worker, render, atau publish - itu Tahap 2 dan seterusnya.

---

## 11. JEBAKAN MIGRASI - baca sebelum deploy ke server!

`drizzle_migrations` di database **lokal** ternyata rusak selama beberapa sesi. Ini bukan
sekadar catatan sejarah - jebakan yang sama bisa terjadi di server saat deploy.

### Apa yang salah

Ledger lokal berisi 7 baris, tetapi hash-nya **tidak cocok dengan nama file**:

| id | hash tercatat seharusnya milik |
|---|---|
| 1-4 | benar |
| 5 | (basi, tidak cocok file mana pun) |
| 6 | file **0005** |
| 7 | file **0006** |

Yang lebih buruk: hash file **`0004_bouncy_nextwave` ada di NOL baris** - migrasi itu tidak
pernah tercatat, padahal tabel `klip_sync_media` / `klip_sync_projects` sudah dibuat manual.

### Kenapa ini berbahaya

`drizzle-kit migrate` mencocokkan hash **berdasarkan urutan**, bukan nama file. Karena hash
baris 7 kebetulan sama dengan isi file **0006**, drizzle menyimpulkan 0006 *dan* 0007 sudah
diterapkan, lalu **mencatat 0007 sebagai "sukses" tanpa menjalankan satu pun DDL-nya**.

Hasilnya: **migrasi melaporkan sukses, tetapi tabelnya tidak ada.** Persis kelas kegagalan
senyap yang sama dengan insiden `drizzle-kit` vs `bun` sebelumnya. Kalau ini terjadi di server,
`/api/klip/batches` akan error 500 sementara semua log tampak normal.

### Fakta penting: `id` bersifat 1-BASED

`drizzle_migrations.id` **bukan** indeks journal. Pemetaannya:

```
id = (indeks journal) + 1      # id 1 <-> 0000_spooky_maelstrom
```

Ledger yang benar untuk repo ini: **id 1..8**, di mana `id 8` = `0007_demonic_mysterio`.
Menulis 0-based akan menggeser semuanya satu langkah dan tampak "berhasil" sampai migrate
berikutnya menambahkan baris ke-9.

### Wajib dicek di server (`third`) sebelum migrate

```bash
cd /var/www/html/klip-opencut/apps/web

# Hash yang tercatat
mysql -u klip -p klip -N -e "SELECT id,hash FROM drizzle_migrations ORDER BY id;"

# Hash file SEBENARNYA (urutan harus sepadan: id N <-> file ke-(N-1))
for f in migrations/0*.sql; do echo "$(sha256sum "$f" | cut -d" " -f1)  $f"; done
```

Kalau tidak sepadan, **bangun ulang ledger dari journal** (bukan menambal satu-satu):

```bash
# Bangun ulang: id = idx+1, hash = sha256 isi file
node -e '
  const fs=require("fs"),crypto=require("crypto");
  const j=JSON.parse(fs.readFileSync("migrations/meta/_journal.json","utf8"));
  const rows=j.entries.map(e=>"("+(e.idx+1)+",\x27"+crypto.createHash("sha256")
    .update(fs.readFileSync("migrations/"+e.tag+".sql","utf8")).digest("hex")+"\x27,"+e.when+")");
  fs.writeFileSync("/tmp/ledger.sql",
    "DELETE FROM drizzle_migrations;\nINSERT INTO drizzle_migrations (id,hash,created_at) VALUES "+rows.join(",")+";");
'

# PERIKSA isinya dulu, baru jalankan
cat /tmp/ledger.sql | head -3
mysql -u klip -p klip < /tmp/ledger.sql
```

Lalu buat tabel yang belum ada. Marker `--> statement-breakpoint` **bukan SQL valid**, dan
muncul DUA bentuk (baris sendiri, dan menempel setelah `;`), jadi jangan pakai anchor `^`/`$`:

```bash
sed "s/--> statement-breakpoint//g" migrations/0007_demonic_mysterio.sql > /tmp/m7.sql
mysql -u klip -p klip --force < /tmp/m7.sql
```

`--force` supaya error "table already exists" dari percobaan parsial tidak menghentikan
perintah berikutnya.

### Verifikasi wajib (jangan percaya kata "migrasi sukses")

```bash
# 1. Struktur benar-benar ada
mysql -u klip -p klip -N -e "SHOW TABLES LIKE 'klip_batch%'; SHOW TABLES LIKE 'klip_settings';"

# 2. Migrate idempoten: jumlah baris TIDAK bertambah
mysql -u klip -p klip -N -e "SELECT COUNT(*) FROM drizzle_migrations;"
node ./node_modules/drizzle-kit/bin.cjs migrate
mysql -u klip -p klip -N -e "SELECT COUNT(*) FROM drizzle_migrations;"   # harus sama
```

Kalau jumlahnya bertambah setelah migrate, ledger masih salah.

---

## 12. Status Tahap 2 - SELESAI (berbasis Chromium)

**Keputusan besar:** worker **TIDAK** meniru logika editor di Node, melainkan
menjalankan **Chromium headless** - lingkungan asli kode editor.

Alur: `ambil job` -> `ekstrak ZIP` (Node) -> `Chromium buka /internal/batch-job`
-> halaman membuat project memakai kode editor yang sama dengan UI -> `worker`
menautkan project + menempelkan template -> `tandai rendered`.

### Kenapa Chromium, bukan Node

Tiga percobaan memaksa `opencut-wasm` jalan di Node semuanya gagal:

| Percobaan | Akibat |
|---|---|
| Lapisan waktu murni | Nilai salah (`1000`, seharusnya `120000`) - durasi jadi 120x salah |
| Jembatan binding runtime | SSR rusak, build gagal |
| Revert | Worker hilang |

Chromium menghapus **seluruh** masalah itu: tidak ada wasm yang perlu diakali,
tidak ada `scenes.ts`/`params` yang perlu ditiru, dan tidak ada dua sumber
kebenaran. `media-time.ts` tidak perlu disentuh sama sekali.

### Hasil uji dengan data nyata

Batch `b_88e7c1394b2d` (6 video, ZIP 118 MB):

| Job | Durasi (ffprobe) |
|---|---|
| clip_01 | 42,5 dtk |
| clip_02 | 46,1 dtk |
| clip_03 | 30,1 dtk |
| clip_04 | 37,7 dtk |
| clip_05 | 26,5 dtk |
| clip_06 | 24,9 dtk |

**6/6 job `rendered`, batch `done`.** Editor membuka project hasil worker:
HTTP 200, 0 error, durasi tampil benar.

### Cara tes manual

```bash
# 1. Pastikan dev server jalan (bun run dev:web)
# 2. Antrikan ZIP dari /projects -> tombol "Antrikan batch"
# 3. Jalankan worker satu kali
cd apps/web && bun run worker:once
# 4. Lihat hasilnya di /batches dan /projects
```

Worker butuh env: `APP_USER`, `APP_PASSWORD`, dan `KLIP_WORKER_BASE_URL`
(default `http://127.0.0.1:6050`). Untuk dev lokal set ke `http://127.0.0.1:3000`.

### Yang belum

- **Template belum teruji dengan template nyata** - kodenya ada, tapi batch uji
  belum punya template aktif.
- **Render MP4** - belum ada (Tahap 3).
- **Publish IG** - belum ada (Tahap 4).
- **Window waktu (jam 11-15)** - belum ada (Tahap 3).
- **pm2 di server** - config sudah ada (`ecosystem.config.cjs`), belum dipasang.

---

## 13. Langkah berikutnya

**Tahap 3: render MP4.** Ini yang paling rapuh (lihat bagian 4) - perlu dijawab:

- Apakah render di Chromium jalan tanpa GPU?
- Berapa lama 1 video?
- Apakah hasilnya identik dengan yang terlihat di browser?

Karena worker sudah memakai Chromium, **infrastruktur Tahap 3 sudah ada**.
Yang kurang hanya memicu render dari halaman internal dan menyimpan MP4-nya.

### Deploy ke server

```bash
cd /var/www/html/klip-opencut
git pull
cd apps/web

# BACA BAGIAN 11 DULU - cek ledger sebelum migrate!
NODE_ENV=production node ./node_modules/drizzle-kit/bin.cjs migrate
mysql -u klip -p klip -N -e "SHOW TABLES LIKE 'klip_batch%'; SHOW TABLES LIKE 'klip_settings';"
```

Server juga perlu Chromium: `bunx playwright install chromium` (+ sekitar 400 MB;
cek disk dulu - bagian 4).
