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

## 13. Tahap 3 - Render MP4 (SUDAH DIUJI KELAYAKANNYA)

Pertanyaan T3-1 di bagian 7 ("belum bisa dijanjikan") **sudah terjawab** dengan
uji nyata. Berikut hasilnya.

### Jawaban T3-1

| Pertanyaan | Jawaban |
|---|---|
| Render jalan tanpa GPU? | **Ya** |
| Berapa lama 1 video? | **~3,3x durasi video** (24,9 dtk -> 81 detik) |
| Hasilnya sama dengan di browser? | **Ya** - memakai exporter yang sama |

### Temuan teknis

**1. WebCodecs ADA di Chromium headless** - tapi hanya di *secure context*.
Penting: pengujian di halaman kosong (`about:blank`) memberi hasil "tidak ada",
padahal di `localhost`/HTTPS tersedia. Jangan tertipu saat menguji.

**2. Codec yang didukung** (1080x1920):

| Codec | Status |
|---|---|
| `avc1.640028` (H.264 High) | DIDUKUNG |
| `avc1.4d002a` (H.264 Main) | DIDUKUNG |
| `vp8`, `vp09`, `av01` | DIDUKUNG |
| `avc1.42001f` (H.264 **Baseline**) | **TIDAK** |
| Audio `opus`, `mp4a.40.2` | DIDUKUNG |

OpenCut memakai `mp4` + codec `avc`, jadi jalur default sudah aman.

**3. Hasil render sungguhan** (project hasil worker, template "hope well"):

```
durasi  : 32,02 dtk   (24,9 utama + 7,04 post-roll)
video   : h264 1080x1920 30fps
audio   : aac
ukuran  : 21,2 MB
waktu   : 81 detik
```

Frame detik ke-5: video utama + watermark. Frame detik ke-28: post-roll
tampil lebar penuh. **Template ikut ter-render dengan benar.**

### Status: SELESAI (kecuali deploy)

| # | Item | Status |
|---|---|---|
| 1 | Halaman internal menerima perintah render | OK |
| 2 | Endpoint penyimpanan MP4 | OK |
| 3 | Status job (`rendered` = MP4 ada) | OK |
| 4 | **Window waktu + tuas "jalankan sekarang"** (T3-5) | OK |
| 5 | Batasi 1 render bersamaan (T3-4) | OK (loop serial) |
| 6 | Tombol unduh MP4 | OK (di `/batches` dan `/projects`) |

### Cara pakai window waktu

Default: **window mati** - worker mengerjakan setiap job yang masuk. Ini yang
membuat upload langsung diproses tanpa setelan apa pun.

```bash
cd apps/web
bun run klip:setting                      # lihat setelan
bun run klip:setting window 11:00 15:00   # aktifkan window
bun run klip:setting window off           # matikan lagi
bun run klip:setting allow-manual on|off  # izinkan --now
```

Di luar window, worker **menunggu** - job tidak hilang, hanya ditunda:

```
[worker] di luar window render, menunggu 1010 menit lagi (jam 3:00-3:05)
```

Tuas "jalankan sekarang" menembus window: `bun run worker:now`. Ditolak dengan
pesan jelas kalau `allow_manual_run` mati - bukan diam-diam diabaikan.

**Catatan penting:** kolom `klip_settings.updated_at` TIDAK punya nilai default
di database (drizzle mengisinya dari aplikasi). INSERT lewat SQL mentah gagal
dengan `Field 'updated_at' doesn't have a default value` - pakai `klip:setting`.

### Perkiraan kapasitas

Dengan 3,3x durasi:

- 30 dtk video -> ~100 detik render
- 6 video -> ~10 menit
- 50 video -> ~83 menit (belum termasuk ekstrak)

Inilah alasan window waktu penting: render 50 video akan memakai CPU server
selama lebih dari satu jam.

### Catatan risiko yang masih berlaku

- **T3-2** Chromium ~400 MB di server; disk `third` sudah ~85%. Cek dulu.
- **T3-4** Batasi 1 render bersamaan untuk melindungi 13 vhost lain.
- Belum diuji di server. Angka di atas dari mesin lokal (MacBook).

---

## 14. Langkah berikutnya

Urutan yang disarankan:

1. **Tes worker** - `worker/__tests__/` masih kosong. Tiga bug sesi ini lolos dari
   tes dan hanya ketahuan saat user mencoba sendiri.
2. **Tahap 3** - render MP4 (bagian 13 di atas).
3. **Deploy ke server** - termasuk Chromium + pm2, setelah semuanya beres.
4. **Tahap 4** - publish IG + retry + circuit breaker.

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

---

## 15. Tahap 4 - publish otomatis ke Instagram

Tujuan tahap ini: setelah video selesai dirender, worker mengirimnya sendiri ke
Instagram. Tidak ada manusia yang mengunggah.

### 15.1 Alur

```
job diklaim
  |
  +-- rendered_path sudah ada? --ya--> LANGSUNG publish (tidak render ulang)
  |                                     render ~3,3x durasi video, jadi
  |                                     mengulanginya murni pemborosan
  +-- tidak --> ekstrak zip -> Chromium render -> rendered_path tersimpan
                                                        |
                                                        v
                                            ambil akun IG tujuan
                                                        |
                     +----------------------------------+------------------+
                     |                                  |                  |
              tidak ada akun                     akun tidak aktif     akun aktif
                     |                                  |                  |
             stage no_ig_account              stage publish_skipped   kirim ke IG
             status rendered                  status rendered              |
             (bukan kegagalan)                (bukan kegagalan)     +------+------+
                                                                    |             |
                                                                berhasil       gagal
                                                                    |             |
                                                            status published   stage publish_failed
                                                            + permalink        atau
                                                                               publish_rate_limited
```

Publish memakai jalur yang sudah ada (`src/klip/ig-publish.ts`, `processItems`):
IG menerima bytes langsung, jadi berkas render di server cukup. `video_path`
diarahkan ke berkas render, BUKAN disalin ke `publishes/` - supaya tidak ada
duplikasi berkas 20-50 MB per video.

### 15.2 Keputusan

| # | Pertanyaan | Keputusan | Alasan |
|---|---|---|---|
| P1 | Caption per batch atau per video? | **Per batch** | Caption adalah maksud user, bukan sesuatu yang bisa ditebak sistem. Satu ZIP biasanya satu topik. |
| P2 | Window render berlaku untuk publish? | **Ya** | Window adalah "jam kerja robot"; publish juga tindakan keluar. |
| P3 | Berapa kegagalan sebelum batch dihentikan? | **2 berturut-turut** (bisa diatur) | Satu kegagalan bisa kebetulan; dua biasanya berarti template atau video memang salah. |
| P4 | Kegagalan batas laju dihitung? | **Tidak** | Batas laju bukan tanda konten salah - itu hanya perlu ditunggu. Kalau dihitung, batch sehat berhenti sia-sia. |
| P5 | Percobaan ulang publish? | **Pakai `max_attempts` job (5)** | Sudah ada `next_attempt_at`; publish yang gagal TIDAK merender ulang. |

### 15.3 Yang berubah

**Skema** - migrasi `0009_yellow_human_fly.sql`:

```sql
ALTER TABLE `klip_batch_jobs` ADD `permalink` text;
ALTER TABLE `klip_batches` ADD `ig_account_id` varchar(64);
```

`klip_batches.caption` sudah ditambahkan di migrasi `0008_rainy_gauntlet.sql`.

Catatan ledger: `drizzle_migrations.id` MELOMPAT (9 -> 16) setelah migrasi
dijalankan drizzle-kit. Itu wajar - pencocokan migrasi memakai `created_at`,
bukan `id`. Jangan "perbaiki" id-nya.

**Kode:**

| Berkas | Isi |
|---|---|
| `src/klip/worker/publish.ts` | `publishRenderedVideo()`, `isRateLimitError()` |
| `src/klip/worker/process.ts` | `publishStage()`, `maybeHaltBatch()`, `renderStateForJob()` |
| `src/klip/worker/loop.ts` | menangani hasil `published` |
| `src/klip/settings.ts` | `default_ig_account_id`, `publish_failure_threshold` |
| `scripts/klip-settings.ts` | perintah `ig-account`, `publish-threshold` |
| `src/app/batches/page.tsx` | tautan "Lihat di IG", caption batch, catatan tahap |

### 15.4 Tiga lubang yang ketahuan saat menulis tes

Ketiganya TIDAK ketahuan dari typecheck - hanya ketahuan karena tes menyusun
riwayat job secara langsung lalu memeriksa kolomnya.

1. **`refreshBatchCounters` menimpa status `halted`.** Worker memanggilnya
   setelah setiap job, jadi batch yang baru saja dihentikan circuit breaker
   langsung kembali berstatus `running` - breaker-nya praktis tidak berefek.
   Sekarang status `halted` dibekukan; hitungannya tetap diperbarui.
2. **`claimNextJob` tetap mengambil job dari batch `halted`.** Tanpa
   `NOT IN (batch halted)`, sisa video salah terus terkirim ke akun publik.
3. **Baris `publish_rate_limited` ikut terhitung sebagai kegagalan.** Filter
   lama memakai `stage.startsWith("publish")`, yang juga cocok untuk
   `publish_rate_limited` dan `publish_skipped`. Sekarang hanya
   `publish_failed` yang dihitung, dan tahap itu ditulis SEBELUM breaker
   memeriksa - kalau ditulis setelahnya, kegagalan terbaru tidak ikut dinilai.

### 15.5 Tes

`apps/web/src/klip/worker/__tests__/publish-stage.test.ts` - 10 tes, semuanya
lulus. Tes ini sengaja **tidak memanggil Instagram** dan **tidak menjalankan
Chromium**:

- runner palsu yang meledak kalau `renderProject` dipanggil, jadi "tidak render
  ulang" benar-benar dibuktikan, bukan diasumsikan;
- kegagalan publish dipaksa lewat berkas render yang sengaja tidak dibuat,
  sehingga tidak ada permintaan jaringan sama sekali;
- setelan `default_ig_account_id` dan `publish_failure_threshold` disimpan
  lalu dipulihkan di `afterAll`.

Cara menjalankan (butuh `--env-file`, kalau tidak validasi env gagal):

```bash
cd apps/web
bun run test                                  # semua
bun run test src/klip/worker/__tests__/        # hanya worker
```

Empat kegagalan lain di suite ini **sudah ada sebelumnya** dan tidak berkaitan:
`wasm.__wbindgen_start is not a function` dari glue `opencut-wasm`, muncul di
`src/masks`, `src/services`, dan `src/timeline`.

### 15.6 Cara mengaktifkan publish

Secara bawaan publish **DIMATIKAN**: `default_ig_account_id` kosong, jadi setiap
job berhenti di `stage = no_ig_account` dan hanya menghasilkan berkas MP4 yang
bisa diunduh. Ini disengaja - mengirim ke akun publik itu tindakan yang tidak
bisa dibatalkan.

```bash
cd apps/web
bun run klip:setting                                   # lihat setelan sekarang
bun run klip:setting ig-account <id_akun>              # aktifkan publish
bun run klip:setting ig-account none                   # matikan lagi
bun run klip:setting publish-threshold 2               # ambang circuit breaker
```

Atau per batch: kolom `klip_batches.ig_account_id` menang atas setelan default.

### 15.7 Hasil uji publish sungguhan

Sudah diuji dengan satu video (24,9 detik) ke @motivasikaya26:

| Tahap | Hasil |
|---|---|
| Render di Chromium | berhasil, MP4 h264 1080x1920 |
| Percobaan resumable upload | DITOLAK Meta: `The parameter video_url is required` |
| Fallback lewat `video_url` | **berhasil** |
| Posting terbit | `https://www.instagram.com/reel/DdQMlT-AeWF/` (HTTP 200) |
| Percobaan ulang tanpa render ulang | 8,3 detik (vs ~80 detik kalau render lagi) |

**Kesimpulan penting: jalur resumable TIDAK dipakai Meta.** Setiap publish
selalu jatuh ke `video_url`, jadi `KLIP_PUBLIC_BASE_URL` bukan opsional -
tanpa itu publish selalu gagal. Nilainya harus domain publik yang melayani
aplikasi INI, karena server Meta yang mengunduh MP4-nya.

Gejala kalau salah: job berhenti di `stage = publish_failed` dengan pesan
`Instagram gagal memproses video` dan container berstatus ERROR. Meta tidak
memberi keterangan lain, jadi pesan itu sekarang menyebut container id dan URL
yang dipakai - periksa URL-nya dengan `curl -I` sebelum menuduh videonya salah.

### 15.8 Yang belum dikerjakan

- **Batas harian publish IG.** Belum ada. Risiko nyata: 100 video dalam satu
  batch akan ditembakkan berturut-turut sampai IG sendiri yang menolak.
  Rencana: hitung `klip_ig_publish_items` berstatus `published` dalam 24 jam
  terakhir; kalau lewat batas, tunda dengan `next_attempt_at` - jangan
  tandai gagal.
- **Rotasi token Instagram** belum pernah dilakukan. Token akun dienkripsi
  dengan `IG_TOKEN_KEY` di env server; menggantinya membuat token tersimpan
  tidak bisa didekripsi, jadi semua akun harus dihubungkan ulang.

---

## 16. Deploy ke produksi (server `third`)

Diperiksa langsung 14 Sep 2026, **read-only**. Semua angka di bawah hasil
pengukuran, bukan asumsi.

### 16.1 Keadaan server saat diperiksa

| Hal | Nilai |
|---|---|
| Host | `third.worker`, Ubuntu 24.04.4, kernel 6.8.0-124 |
| Disk | 296 GB, **42 GB tersisa (86% terpakai)** |
| Memori | 15 GB total, 9,4 GB tersedia |
| Repo | `/var/www/html/klip-opencut`, branch **`main`** @ `576c6104` |
| `clip-opencut` | pm2 id 14, **online**, up 2 hari, port `127.0.0.1:6050` |
| `klip-worker` | **BELUM ADA** |
| pm2 lain | 13 aplikasi lain (n8n, xm-worker, third-worker, openshorts, ...) |
| `bun` | `/root/.bun/bin/bun` - TIDAK ada di PATH shell non-interaktif |
| `node` | nvm v22.22.3 / v24.16.0 / v26.3.0 |
| `pm2` | `/root/.nvm/versions/node/v22.22.3/bin/pm2` (7.0.4) |
| ffmpeg / ffprobe | ADA (6.1.1) |
| Chromium Playwright | **BELUM ADA** (`~/.cache/ms-playwright` kosong) |
| nginx vhost | `/etc/nginx/sites-enabled/opencut.ordoagentic.ai` - **sudah benar** |
| Data root | `/var/lib/klip/data` (328 MB) |

**nginx tidak perlu diubah.** Vhost-nya sudah punya `client_max_body_size 500m`,
`proxy_request_buffering off`, timeout 600s, dan HTTPS Certbot. 13 vhost lain
di direktori yang sama **jangan disentuh**.

**`KLIP_PUBLIC_BASE_URL` sudah terpasang** di `apps/web/.env.production` dengan
nilai `https://opencut.ordoagentic.ai` - sudah benar, jangan diubah.

### 16.2 Data yang sudah ada di server

Tidak perlu memindahkan data dari lokal. Server sudah punya sendiri:

| Tabel | Jumlah |
|---|---|
| `klip_projects` | 3 |
| `klip_brand_templates` | 1 (`btpl_7d6a2bbe26d3` "template 1") |
| `klip_media` | 13 |
| `klip_ig_accounts` | 1 (`ig_4374b01df0ec` motivasikaya26, **active**) |
| `klip_ig_publishes` | 2 |

Akun IG di server punya id BERBEDA dari lokal (`ig_4374b01df0ec` vs
`ig_b1b8d008b879`) - itu wajar, keduanya koneksi terpisah dengan
`IG_TOKEN_KEY` masing-masing. **Jangan menyalin database lokal ke server**;
tidak ada yang perlu dipindah.

Yang BELUM ada: `klip_batches`, `klip_batch_jobs`, `klip_settings`.
Ledger `drizzle_migrations` baru sampai migrasi **0004**.

### 16.3 Dua jebakan yang bisa menggagalkan deploy

**1. `ecosystem.config.cjs` di server UNTRACKED.** Git akan menolak checkout:

```
error: The following untracked working tree files would be overwritten by checkout:
        ecosystem.config.cjs
```

Berkas itu HARUS dipindahkan dulu. Versi yang sekarang dilacak git sudah lebih
benar (membaca `apps/web/.env.production` + menjalankan worker), jadi versi
lama cukup di-rename sebagai cadangan.

**2. `.env.production` ada di `apps/web/`, bukan root repo.** Versi lama
`ecosystem.config.cjs` membaca root - karena itu berkas yang dilacak git
diperbaiki dulu (commit `9e366bef`). Kalau memakai versi lama, env akan kosong
dan aplikasi start tanpa `DATABASE_URL`.

### 16.4 Langkah deploy

**Di mesin lokal:**

```bash
git push -u origin automate
```

**Di server - siapkan PATH dulu** (bun dan pm2 tidak ada di PATH default):

```bash
export PATH="/root/.bun/bin:/root/.nvm/versions/node/v22.22.3/bin:$PATH"
bun --version && pm2 -v        # pastikan keduanya kebaca
```

**1. Cadangkan dulu.**

```bash
cd /var/www/html/klip-opencut
mysqldump -u root klip > ~/klip-backup-$(date +%F-%H%M).sql
ls -lh ~/klip-backup-*.sql
mv ecosystem.config.cjs ecosystem.config.cjs.lama-$(date +%F)
```

**2. Ambil kode baru.**

```bash
git fetch origin
git checkout automate
git log --oneline -1        # harus menampilkan commit terbaru dari automate
```

**3. Pasang dependensi.**

```bash
cd apps/web
bun install
```

**4. Jalankan migrasi** (0005-0009; semuanya aditif - tambah kolom/tabel,
tidak ada yang dihapus).

```bash
NODE_ENV=production node ./node_modules/drizzle-kit/bin.cjs migrate
mysql -N -e "SELECT id FROM klip.drizzle_migrations ORDER BY id;"   # harus sampai 10
mysql -N -e "USE klip; SHOW TABLES LIKE 'klip_batch%'; SHOW TABLES LIKE 'klip_settings';"
```

**5. Pasang Chromium untuk worker** (sekitar 400 MB, disk masih 42 GB).

```bash
bunx playwright install --with-deps chromium
```

**6. Build.**

```bash
bun run build
```

**7. GOTCHA standalone: `.next/static` tidak ikut tersalin.** Tanpa langkah ini
halaman tampil tanpa CSS/JS.

```bash
cp -r .next/static .next/standalone/apps/web/.next/static
```

**8. Jalankan.**

```bash
cd /var/www/html/klip-opencut
pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 list | grep -E "clip-opencut|klip-worker"
```

**9. Setelan batch.** Tanpa ini publish akan dilewati (`no_ig_account`) dan
template default kosong.

```bash
cd apps/web
NODE_ENV=production bun run klip:setting template btpl_7d6a2bbe26d3
NODE_ENV=production bun run klip:setting ig-account ig_4374b01df0ec
NODE_ENV=production bun run klip:setting
```

### 16.5 Verifikasi

```bash
curl -sI https://opencut.ordoagentic.ai | head -3
pm2 logs klip-worker --lines 40
```

Lalu antrikan **SATU video** dari UI produksi dan pastikan sampai
`status = published` di `/batches`.

### 16.6 Yang perlu dijaga

- **Disk 86%.** Build 2,9 GB. `df -h /` sebelum dan sesudah.
- **`xm-worker` sudah 100% CPU** dan `third-worker` memakai 2,5 GB. Render
  Chromium 1080p menambah beban; jangan mengerjakan banyak video bersamaan
  sampai terlihat dampaknya ke aplikasi lain.
- **13 vhost nginx lain** - jangan sentuh direktori `sites-enabled`.
- **13 aplikasi pm2 lain** - jangan pakai `pm2 delete all` atau `pm2 restart all`.

