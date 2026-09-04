# Instagram Publish (Multi-Account) — Design

Tanggal: 2026-09-04. Status: disetujui user (pendekatan A).

## 1. Latar & keputusan diskusi

- MVP: tombol Publish di editor, per project. Fase 2: bulk dari halaman projects.
- API resmi Meta; semua akun user sudah Business dan user pernah integrasi sampai publish.
- Video: browser render/export MP4 saat klik Publish, upload ke server, server teruskan ke Meta.
- Caption disimpan per project, bisa diedit terakhir di dialog Publish.
- Sekali publish bisa ke N akun sekaligus. Login + manajemen akun full in-app.
- Jenis konten: Reels saja (tanpa Feed).

## 2. Arsitektur (pendekatan A: server sebagai relay + job per akun)

Browser (render MP4, sudah ada) -> `POST /api/klip/publishes` (multipart: mp4 + projectId + caption + accountIds[])
-> server simpan file + buat job -> per akun: resumable upload ke Meta, polling container sampai FINISHED, publish
-> client polling `GET /api/klip/publishes/[id]` untuk progres per akun.

Tanpa infra baru (tanpa Redis/worker). Token Meta tidak pernah ke browser.

## 3. Data model (MySQL, Drizzle)

- `klip_projects` += `caption TEXT NULL`.
- `klip_ig_accounts`: `id`, `igUserId` (unique), `username`, `profilePicUrl?`, `fbPageId?`,
  `accessTokenEnc` (AES-256-GCM, key dari env `IG_TOKEN_KEY`), `tokenExpiresAt?`,
  `status` (`active` | `token_expired` | `disconnected`), timestamps.
- `klip_ig_publishes`: `id`, `projectId` (FK cascade), `caption` (snapshot saat kirim),
  `videoPath`, `status` (`processing` | `done` | `partial` | `failed`), timestamps.
- `klip_ig_publish_items`: `id`, `publishId` (FK cascade), `igAccountId` (FK),
  `containerId?`, `status` (`queued` | `uploading` | `processing` | `published` | `failed`),
  `permalink?`, `error?`, `attempts` default 0.

## 4. Alur OAuth (in-app)

1. Klik "Hubungkan Instagram" -> popup FB Login (`instagram_content_publish`, `pages_show_list`,
   `pages_read_engagement` — finalisasi scope saat implementasi).
2. Callback ke server: tukar code -> user token -> long-lived token (~60 hari).
3. Server query `/me/accounts` + `connected_instagram_account` -> daftar IG business tersedia.
4. User centang akun mana yang dihubungkan (boleh banyak) -> simpan terenkripsi.
5. Manajemen: daftar akun (username, foto, status), disconnect per akun, penanda `token_expired`
   + tombol reconnect saat Meta menolak token.

## 5. Alur publish (editor)

1. Dialog Publish: checkbox akun (hanya `active`), textarea caption (prefill dari project, edit di sini
   sekaligus simpan kembali ke project).
2. Klik kirim: browser export MP4 (pipeline export existing) -> upload ke server.
3. Server: buat publish + 1 item per akun, lalu proses per akun berurutan:
   resumable upload -> buat container reels (caption + `share_to_feed` default true) ->
   poll status sampai FINISHED (timeout + batas percobaan) -> publish -> simpan permalink.
4. Client polling progres; hasil akhir per akun: published + link, atau failed + pesan error Meta.
5. Retry per item gagal (tanpa mengulang yang sukses).

## 6. Error handling

- Gagal di satu akun tidak menggagalkan akun lain (status `partial` di level publish).
- Pesan error Meta disimpan mentah di `items.error` dan ditampilkan.
- Token ditolak Meta -> akun ditandai `token_expired`, item gagal dengan pesan "perlu reconnect".
- Upload/polling punya timeout dan batas retry; file video dipertahankan sampai job selesai.

## 7. Testing

- Unit: enkripsi/dekripsi token, transisi status publish/item, resolusi caption.
- HTTP Meta dimock pada test; satu verifikasi manual end-to-end dengan akun real.
- `bun --env-file=.env.local test src/klip/__tests__/` wajib hijau.

## 8. Bukan scope MVP (fase 2)

Bulk dari halaman projects (pilih N project -> antrian -> kirim ke akun), scheduling,
refresh token otomatis, analytics (views/likes).
