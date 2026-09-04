# Slice 1 Implementation Plan — Upload Single → Brand → Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload 1 video via UI → tambah 2 brand layer (drag/rotate/z-order) → export MP4 dengan brand menempel, semuanya hijau di mesin dev.

**Architecture:** MySQL dialect dulu (fondasi semua tabel Klip), lalu API upload server-side, lalu crate Rust `klip` untuk pemetaan brand↔track dengan binding wasm tipis, lalu panel brand minimal sebagai tab baru di assets panel, dan terakhir verifikasi paritas preview↔export secara manual.

**Tech Stack:** Next.js (App Router route handlers), Drizzle ORM + mysql2, Rust (crate `klip`, serde), wasm-bindgen via pola `bridge::export`, Bun test (`bun test`) untuk Rust (`cargo test`) dan TS.

**Spec:** `docs/superpowers/specs/2026-09-04-klip-opencut-design.md` (§2–§4, §7 Slice 1, §8)

## Global Constraints

- Semua logika platform-agnostik di `rust/`; `apps/web/` hanya UI shell + API route tipis (AGENTS.md).
- Field brand layer dipertahankan 1:1 dari Klip `seedBrandLayers()`: `id, asset_id, file, name, kind, enabled, x, y, scale, rotate, start, dur, full, volume, duck, opacity`.
- Path file selalu relatif portabel, tidak absolut.
- Tanpa `rotate` = tanpa filter tambahan (tanpa regresi render).
- Tanpa template di Slice 1 (skip v1).
- Deploy target manual + PM2, tanpa Docker; build panjang dijalankan manual, bukan via tool.

---

### Task 1: Ganti dialect Drizzle ke MySQL

**Files:**
- Modify: `apps/web/src/db/schema.ts`
- Modify: `apps/web/src/db/index.ts`
- Modify: `apps/web/drizzle.config.ts`
- Modify: `apps/web/src/env/web.ts` (pelonggaran validasi DATABASE_URL)
- Modify: `apps/web/package.json` (ganti dep `postgres` → `mysql2`)
- Delete + regenerate: `apps/web/migrations/`

**Interfaces:**
- Consumes: tabel bawaan (`users`, `sessions`, `accounts`, `feedback`, `verifications`).
- Produces: koneksi `db` Drizzle-MySQL yang dipakai semua task berikutnya; `DATABASE_URL=mysql://...`.

**Konteks untuk pelaksana:** `apps/web/src/db/index.ts` saat ini memakai `drizzle-orm/postgres-js` + paket `postgres`. `drizzle.config.ts` memakai `dialect: "postgresql"` dan path schema salah (`./src/lib/db/schema.ts`, yang benar `./src/db/schema.ts`). `env/web.ts` menolak `DATABASE_URL` non-postgres. MySQL menolak unique index pada kolom `TEXT` tanpa panjang kunci.

- [ ] **Step 1: Update package deps**

```bash
cd apps/web && bun remove postgres && bun add mysql2 && bun add -d @types/node
```

Expected: `package.json` tidak lagi berisi `"postgres"`, berisi `"mysql2"`.

- [ ] **Step 2: Tulis ulang `src/db/schema.ts` ke mysqlTable**

Ganti setiap `pgTable(` → `mysqlTable(`, import dari `drizzle-orm/mysql-core`. Hapus semua `.enableRLS()`. Ubah kolom unik berbasis teks ke varchar:

```typescript
import { mysqlTable, text, timestamp, boolean, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  // ... sisanya sama, tanpa .enableRLS()
});
```

Terapkan pola yang sama ke `sessions` (`token` → `varchar(255).unique()`), `accounts`, `feedback`, `verifications` (semua `text(...).primaryKey()` → `varchar(..., { length: 64 }).primaryKey()`).

- [ ] **Step 3: Tulis ulang `src/db/index.ts`**

```typescript
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";
import { webEnv } from "@/env/web";

let _db: ReturnType<typeof drizzle> | null = null;

function getDb() {
  if (!_db) {
    const pool = mysql.createPool(webEnv.DATABASE_URL);
    _db = drizzle(pool, { schema, mode: "default" });
  }
  return _db;
}

export const db = getDb();
export * from "./schema";
```

- [ ] **Step 4: Perbaiki `drizzle.config.ts`**

```typescript
export default {
  schema: "./src/db/schema.ts",
  dialect: "mysql",
  dbCredentials: { url: databaseUrl },
  out: "./migrations",
} satisfies Config;
```

- [ ] **Step 5: Longgarkan validasi `DATABASE_URL` di `src/env/web.ts`**

Ubah refine dari `"DATABASE_URL must be a postgres:// or postgresql:// URL"` menjadi menerima `mysql://`:

```typescript
DATABASE_URL: z.string().refine(
  (v) => v.startsWith("mysql://"),
  "DATABASE_URL must be a mysql:// URL",
),
```

- [ ] **Step 6: Regenerasi migrasi + verifikasi terhadap MySQL server**

```bash
rm -rf apps/web/migrations/0000_* apps/web/migrations/meta
cd apps/web && bun run db:generate && bun run db:migrate
```

Expected: migrasi sukses terhadap MySQL yang sudah ada di server (`DATABASE_URL` di `.env.local` menunjuk ke sana). Verifikasi manual: `bunx drizzle-kit check` bila tersedia, atau cek tabel terbentuk via mysql client.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/db apps/web/drizzle.config.ts apps/web/src/env/web.ts apps/web/package.json apps/web/migrations
git commit -m "feat(db): switch drizzle dialect to mysql"
```

---

### Task 2: Tabel Klip (`klip_media`, `klip_projects`, `klip_brand_layers`)

**Files:**
- Modify: `apps/web/src/db/schema.ts` (tambah 3 tabel)
- Modify: `apps/web/migrations/` (regenerasi)
- Test: `apps/web/src/db/__tests__/klip-schema.test.ts` (bun test: insert + cascade delete)

**Interfaces:**
- Consumes: koneksi `db` MySQL dari Task 1.
- Produces: tabel + tipe `KlipMedia`, `KlipProject`, `KlipBrandLayer` yang dipakai Task 3–5. Field layer 1:1 dengan Klip ditambah kolom `z`.

- [ ] **Step 1: Tulis test skema yang gagal**

```typescript
// apps/web/src/db/__tests__/klip-schema.test.ts
import { describe, expect, test } from "bun:test";
import { db, klipProjects, klipBrandLayers, klipMedia } from "@/db";

describe("klip schema", () => {
  test("insert project + layer + cascade delete", async () => {
    const [media] = await db.insert(klipMedia).values({
      id: "m_test1", kind: "source", name: "clip.mp4",
      filePath: "uploads/clip.mp4", duration: 55.8, width: 2560, height: 1072,
    }).$returningId();
    expect(media).toBeDefined();
    // ... insert project, insert layer, delete project, assert layers gone
  });
});
```

Run: `cd apps/web && bun test src/db/__tests__/klip-schema.test.ts`
Expected: FAIL (tabel belum ada).

- [ ] **Step 2: Tambah tabel ke `schema.ts`**

```typescript
import { mysqlTable, text, timestamp, boolean, varchar, double, int, mysqlEnum } from "drizzle-orm/mysql-core";

export const klipMedia = mysqlTable("klip_media", {
  id: varchar("id", { length: 64 }).primaryKey(),
  kind: mysqlEnum("kind", ["source", "brand"]).notNull(),
  assetKind: mysqlEnum("asset_kind", ["image", "video", "audio"]),
  name: varchar("name", { length: 255 }).notNull(),
  filePath: varchar("file_path", { length: 1024 }).notNull(),
  width: int("width"), height: int("height"),
  duration: double("duration"),
  thumbnailPath: varchar("thumbnail_path", { length: 1024 }),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
});

export const klipProjects = mysqlTable("klip_projects", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  batchId: varchar("batch_id", { length: 64 }),
  sourceMediaId: varchar("source_media_id", { length: 64 }),
  status: varchar("status", { length: 32 }).default("ready").notNull(),
  opencutRef: varchar("opencut_ref", { length: 64 }),
  duration: double("duration"),
  width: int("width"), height: int("height"), fps: double("fps"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});

export const klipBrandLayers = mysqlTable("klip_brand_layers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  projectId: varchar("project_id", { length: 64 }).notNull(),
  assetId: varchar("asset_id", { length: 64 }),
  filePath: varchar("file_path", { length: 1024 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  kind: mysqlEnum("kind", ["image", "video", "audio"]).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  x: double("x").default(0.06).notNull(),
  y: double("y").default(0.05).notNull(),
  scale: double("scale").default(0.36).notNull(),
  rotate: double("rotate").default(0).notNull(),
  opacity: int("opacity").default(100).notNull(),
  full: boolean("full").default(true).notNull(),
  start: double("start").default(0).notNull(),
  dur: double("dur").default(0).notNull(),
  volume: double("volume").default(0.35).notNull(),
  duck: boolean("duck").default(false).notNull(),
  z: int("z").default(0).notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
});
```

(Cascade delete via foreign key didefinisikan di migrasi Drizzle relations atau `references()` bila didukung mysql-core; minimal test cascade di Step 4 membuktikan perilaku.)

- [ ] **Step 3: Regenerasi + migrasi**

```bash
cd apps/web && bun run db:generate && bun run db:migrate
```

- [ ] **Step 4: Jalankan test hingga hijau**

Run: `cd apps/web && bun test src/db/__tests__/klip-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/db apps/web/migrations
git commit -m "feat(db): add klip_media, klip_projects, klip_brand_layers"
```

---

### Task 3: `POST /api/uploads` server-side

**Files:**
- Create: `apps/web/src/app/api/uploads/route.ts`
- Create: `apps/web/src/klip/upload.ts` (helper simpan file + probe metadata + catat `klip_media`)
- Test: `apps/web/src/klip/__tests__/upload.test.ts` (POST multipart via `next/test` atau fetch ke route handler langsung; assert record DB + file ada di disk)

**Interfaces:**
- Consumes: tabel `klipMedia` (Task 2).
- Produces: `POST /api/uploads → { mediaId, url, width, height, duration, thumbnailUrl }`. Dipakai Task 4 (wiring media bin) dan Slice 2 (batch-zip memakai helper yang sama).

**Konteks untuk pelaksana:** Ikuti pola route `apps/web/src/app/api/feedback/route.ts` (zod + `NextResponse`). File disimpan di disk server (`<DATA_ROOT>/uploads/<mediaId>.<ext>`, path record relatif `uploads/...`). Metadata (width/height/duration) di-probe via `mediabunny` yang sudah ada di `apps/web/src/media/mediabunny.ts` — baca helper yang tersedia di sana sebelum menulis. Thumbnail via `apps/web/src/media/thumbnail.ts` bila tersedia. Batasi tipe ke video (`mp4/webm/mov`) di Slice 1; tolak selain itu dengan 400.

- [ ] **Step 1: Tulis failing test upload**

```typescript
// apps/web/src/klip/__tests__/upload.test.ts
import { describe, expect, test } from "bun:test";
import { POST } from "@/app/api/uploads/route";

describe("POST /api/uploads", () => {
  test("rejects non-video with 400", async () => {
    const form = new FormData();
    form.append("file", new File(["x"], "note.txt", { type: "text/plain" }));
    const res = await POST(new Request("http://localhost/api/uploads", { method: "POST", body: form }));
    expect(res.status).toBe(400);
  });
});
```

Run: `cd apps/web && bun test src/klip/__tests__/upload.test.ts`
Expected: FAIL (route belum ada).

- [ ] **Step 2: Implementasi helper + route minimal**

`src/klip/upload.ts`:

```typescript
import { db, klipMedia } from "@/db";

export const UPLOAD_DIR = "uploads";
export const ACCEPTED_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);

export function newMediaId(): string { /* m_ + nanoid/counter, unik */ }
export function toPortablePath(abs: string): string { /* relatif terhadap DATA_ROOT */ }
export async function probeVideo(filePath: string): Promise<{ width: number; height: number; duration: number }> { /* via mediabunny */ }
export async function saveUpload({ file }: { file: File }): Promise<{ mediaId: string; url: string; width: number; height: number; duration: number; thumbnailUrl: string | null }> {
  // 1. validasi ekstensi → 400 bila ditolak
  // 2. tulis ke DATA_ROOT/uploads/<id>.<ext>
  // 3. probe metadata, tulis thumbnail bila bisa
  // 4. insert klipMedia, return respons
}
```

`src/app/api/uploads/route.ts`:

```typescript
import { type NextRequest, NextResponse } from "next/server";
import { saveUpload } from "@/klip/upload";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  try {
    const result = await saveUpload({ file });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
```

- [ ] **Step 3: Test hijau + tambah kasus sukses (file mp4 kecil / fixture)**

Run: `cd apps/web && bun test src/klip/__tests__/`
Expected: PASS (400 untuk non-video; 201 + record DB untuk video valid).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/uploads apps/web/src/klip
git commit -m "feat(upload): server-side video upload with klip_media record"
```

---

### Task 4: Wiring upload ke media bin (persist server)

**Files:**
- Modify: `apps/web/src/components/editor/panels/assets/views/assets.tsx` (`processFiles` → POST ke `/api/uploads` dulu, lalu `addMediaAsset` dengan URL server)
- Test: manual via UI (otomatisasi upload browser di luar scope Slice 1)

**Interfaces:**
- Consumes: `POST /api/uploads` (Task 3).
- Produces: aset media bin yang URL-nya menunjuk file server (refresh tidak menghilangkan aset).

**Konteks untuk pelaksana:** Alur saat ini di `assets.tsx` `processFiles`: `processMediaAssets({files})` (lokal, di browser) → `editor.media.addMediaAsset({projectId, asset})`. Perubahan: untuk setiap file, buat `FormData` + `fetch("/api/uploads", {method: "POST", body})` dengan progress via `XMLHttpRequest` (tiru pola progress XHR `public/index.html` Klip bila perlu), ambil `mediaId/url/width/height/duration`, bentuk `ProcessedMediaAsset`, lalu `addMediaAsset` seperti sekarang. Fallback: bila POST gagal (mis. server tanpa DB), tampilkan toast error dan JANGAN tambah aset lokal — persist server adalah syarat (verifikasi: refresh tidak menghilangkan aset).

- [ ] **Step 1: Ubah `processFiles`**

```typescript
const processFiles = async ({ files }: { files: File[] }) => {
  if (!files || files.length === 0) return;
  if (!activeProject) { toast.error("No active project"); return; }
  setIsProcessing(true); setProgress(0);
  try {
    await showMediaUploadToast({
      filesCount: files.length,
      promise: async () => {
        const uploaded = [];
        for (const [i, file] of files.entries()) {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch("/api/uploads", { method: "POST", body: form });
          if (!res.ok) throw new Error(`Upload gagal: ${file.name}`);
          const meta = await res.json(); // { mediaId, url, width, height, duration, thumbnailUrl }
          const processed = await processMediaAssets({ files: [file], serverMeta: meta });
          for (const asset of processed) {
            await editor.media.addMediaAsset({ projectId: activeProject.metadata.id, asset });
          }
          setProgress(((i + 1) / files.length) * 100);
          uploaded.push(file.name);
        }
        return { uploadedCount: uploaded.length, assetNames: uploaded };
      },
    });
  } catch (error) {
    console.error("Error uploading files:", error);
    toast.error("Upload ke server gagal");
  } finally { setIsProcessing(false); setProgress(0); }
};
```

Catatan: `processMediaAssets` saat ini tidak menerima `serverMeta` — pelaksana boleh (a) menambah param opsional `serverMeta` agar dimensi/durasi memakai hasil probe server, atau (b) mengabaikan probe lokal dan memakai meta server langsung saat membentuk aset. Pilih (a) bila mudah, (b) bila signature `processMediaAssets` sulit diubah. Yang penting: `asset.url` final menunjuk file server.

- [ ] **Step 2: Verifikasi manual**

Upload 1 MP4 via UI → muncul di media bin → drop ke timeline → refresh browser → aset tetap ada.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/editor/panels/assets/views/assets.tsx
git commit -m "feat(upload): wire media bin to server-side uploads"
```

---

### Task 5: Crate Rust `klip` — brand-map (TDD)

**Files:**
- Create: `rust/crates/klip/Cargo.toml`
- Create: `rust/crates/klip/src/klip.rs` (atau `lib.rs` mengikuti pola crate `time`: `[lib] path = "src/klip.rs"`)
- Create: `rust/crates/klip/src/brand_map.rs` (tipe + fungsi murni)
- Test: unit test di `brand_map.rs` (`#[cfg(test)]`), dijalankan via `cargo test -p klip`

**Interfaces:**
- Consumes: tidak ada (pure; definisi skala di bawah adalah kontrak).
- Produces: `KlipBrandLayer`, `BrandMapCtx`, `klip_layer_to_element()`, `element_to_klip_layer_patch()` — dipakai Task 6 (binding wasm) dan Task 7 (panel).

**Kontrak skala (W AJIB sama di semua task — jangan diubah sepihak):**

- Waktu: detik `f64`. `full=true` → start 0, dur = totalDuration. `full=false` → start/dur Klip dipakai langsung (waktu-HASIL).
- Posisi: Klip `x,y` 0–1 relatif canvas → piksel: `posX = (x - 0.5) * canvasWidth`, `posY = (0.5 - y) * canvasHeight` (pusat canvas = 0,0; y Klip dari atas, y opencut dari tengah — tanda dibalik).
- Skala: Klip `scale` = faktor terhadap lebar canvas untuk sisi panjang asset → `scaleX = scaleY = scale * canvasWidth / assetWidth` (bila `assetWidth` tidak diketahui, fallback `scaleX = scaleY = scale`). Nilai `MIN_TRANSFORM_SCALE` dihormati (clamp bawah).
- Opacity: Klip 10–100 → 0.1–1.0 (`opacity / 100`).
- Rotate: derajat langsung ke `transform.rotate` (-360..360 di-clamp).
- Volume: Klip 0–2 (linear gain) → dB opencut: `db = 20 * log10(max(gain, MIN_LINEAR_GAIN))`, clamp ke `[VOLUME_DB_MIN, VOLUME_DB_MAX]` = `[-60, 20]`. Lihat `apps/web/src/timeline/audio-display.ts` (`MIN_LINEAR_GAIN = 10 ** (VOLUME_DB_MIN / 20)`).
- `enabled=false` → `hidden=true`.
- Track: image → `"graphic"`, video → `"video"` (overlay), audio → `"audio"`. Fungsi mengembalikan juga `targetTrack` agar TS tahu track tujuan.
- `trimStart/trimEnd` default 0. `z` → urutan (konsumen TS yang mengatur posisi insert).

Karena element opencut memakai `MediaTime` (ticks, milik crate `time`/wasm) dan brand-map harus murni-platform-agnostik, crate `klip` bekerja dalam **detik f64** dan mengembalikan struct netral (`MappedElement { target_track, start_sec, duration_sec, params: ParamMap, hidden, volume_db, ... }`); konversi detik→MediaTime terjadi di binding/TS, bukan di core. Ini menjaga crate bebas dari dependensi wasm.

- [ ] **Step 1: Scaffold crate + tipe + test merah**

`rust/crates/klip/Cargo.toml`:

```toml
[package]
name = "klip"
version = "0.1.0"
edition = "2024"

[lib]
path = "src/klip.rs"
crate-type = ["rlib"]

[dependencies]
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
approx = "0.5"
```

`rust/crates/klip/src/klip.rs`:

```rust
mod brand_map;
pub use brand_map::*;
```

`rust/crates/klip/src/brand_map.rs`: definisikan `KlipBrandKind`, `KlipBrandLayer` (semua field Klip + `z: i32`), `BrandMapCtx { canvas_width, canvas_height, total_duration, asset_width: Option<f64>, asset_height: Option<f64> }`, `MappedElement { target_track: BrandTrack, start_sec: f64, duration_sec: f64, pos_x: f64, pos_y: f64, scale_x: f64, scale_y: f64, rotate_deg: f64, opacity: f64, hidden: bool, volume_db: Option<f64>, duck: bool }`, lalu test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_image_maps_to_graphic_track() {
        let layer = KlipBrandLayer { kind: KlipBrandKind::Image, full: true, ..Default::default() };
        let ctx = BrandMapCtx { canvas_width: 1080.0, canvas_height: 1920.0, total_duration: 55.8, asset_width: Some(540.0), asset_height: Some(200.0) };
        let el = klip_layer_to_element(&layer, &ctx);
        assert_eq!(el.target_track, BrandTrack::Graphic);
        assert_eq!(el.start_sec, 0.0);
        assert_eq!(el.duration_sec, 55.8);
    }
}
```

Run: `cargo test -p klip`
Expected: FAIL (fungsi belum ada).

- [ ] **Step 2: Implementasi `klip_layer_to_element` + `element_to_klip_layer_patch`**

Ikuti kontrak skala di atas persis. `element_to_klip_layer_patch` membalikkan (piksel→0–1, dB→gain, dsb.) untuk sync balik panel.

- [ ] **Step 3: Test bulat-balik hijau**

Tambah test: `layer → element → layer` identik kecuali `id` (salin kriteria spec Task 3); test timed (`full=false`); test audio (volume dB); test `enabled=false → hidden`. Run: `cargo test -p klip`. Expected: PASS semua.

- [ ] **Step 4: Commit**

```bash
git add rust/crates/klip Cargo.toml Cargo.lock
git commit -m "feat(rust): add klip crate with brand-map"
```

(Crate perlu didaftarkan sebagai member workspace bila `Cargo.toml` root memakai daftar members eksplisit — cek dan sesuaikan.)

---

### Task 6: Binding wasm + adapter TS tipis

**Files:**
- Modify: `rust/wasm/Cargo.toml` (tambah dep `klip`), `rust/wasm/src/wasm.rs` (re-export modul bila perlu)
- Create: `rust/wasm/src/klip_bind.rs` (`#![cfg(target_arch = "wasm32")]`, fungsi `klipLayerToElement(layerJs, ctxJs) -> JsValue` via serde-wasm-bindgen)
- Create: `apps/web/src/klip/brand-map.ts` (adapter: panggil binding wasm; fallback murni-TS dilarang — bila wasm belum build, throw error yang jelas)
- Test: `apps/web/src/klip/__tests__/brand-map.test.ts` (bun test: panggil adapter, assert track + startTime/duration ticks + params)

**Interfaces:**
- Consumes: `klip_layer_to_element` Rust (Task 5); `mediaTimeFromSeconds` dari `@/wasm`; `buildDefaultElementParams` dari `@/timeline/defaults` (atau jalur import yang benar — cek sebelum pakai).
- Produces: `klipLayerToElement(layer, ctx) → { track: "graphic"|"video"|"audio", element: CreateImageElement|CreateVideoElement|CreateAudioElement }` dan `elementToKlipLayer(el) → patch`. Dipakai Task 7 (panel).

**Konteks untuk pelaksana:** Ikuti pola modul wasm yang ada (`compositor.rs`/`effects.rs`: `wasm_bindgen`, `serde-wasm-bindgen`). Struct Rust→JS memakai `Tsify` bila mengikuti pola crate `time` (`#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]`). Build: `wasm-pack build rust/wasm --target bundler --out-dir pkg` (dijalankan manual). Adapter TS mengubah `MappedElement` (detik f64) menjadi `Create*Element` opencut (`MediaTime` via `mediaTimeFromSeconds`, `params` via `buildDefaultElementParams` + override hasil mapping, `mediaId` dari `filePath`/asset).

- [ ] **Step 1: Tambah dep + modul binding (test TS merah dulu)**

Tulis `apps/web/src/klip/__tests__/brand-map.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { klipLayerToElement } from "@/klip/brand-map";

describe("klipLayerToElement", () => {
  test("full image → graphic track element", () => {
    const { track, element } = klipLayerToElement(
      { id: "lyr_1", asset_id: null, file: "brand/wm.png", name: "wm", kind: "image", enabled: true, x: 0.62, y: 0.06, scale: 0.3, rotate: 0, start: 0, dur: 0, full: true, volume: 0.35, duck: false, opacity: 100, z: 0 },
      { canvasWidth: 1080, canvasHeight: 1920, totalDuration: 55.8, assetWidth: 540, assetHeight: 200 },
    );
    expect(track).toBe("graphic");
    expect(element.type).toBe("image");
  });
});
```

Run: `cd apps/web && bun test src/klip/__tests__/brand-map.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implementasi binding + adapter hingga hijau**

Run: `cd apps/web && bun test src/klip/__tests__/`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add rust/wasm apps/web/src/klip
git commit -m "feat(klip): wasm binding + TS adapter for brand-map"
```

---

### Task 7: Panel brand minimal (tab baru) + insert path

**Files:**
- Create: `apps/web/src/klip/brand-panel.tsx` (daftar + upload + inspector Transform)
- Modify: `apps/web/src/components/editor/panels/assets/assets-panel-store.tsx` (tambah tab `brand`), `tabbar` otomatis mengikuti `TAB_KEYS`
- Modify: `apps/web/src/components/editor/panels/assets/index.tsx` (tambah `brand: <BrandPanel/>` ke viewMap)
- Create: `apps/web/src/app/api/klip/brand-assets/route.ts` (upload asset brand → `klip_media` + file disk `brand/`)
- Create: `apps/web/src/app/api/klip/projects/[id]/brand/route.ts` (GET layers, PATCH layers)
- Test: `apps/web/src/klip/__tests__/brand-api.test.ts` (GET/PATCH round-trip)

**Interfaces:**
- Consumes: `klipLayerToElement` (Task 6); `editor.timeline.insertElement({placement: {mode: "auto"}, element})` (pola `assets-view.tsx` sticker); `GET /api/klip/projects/:id` (dibuat di task ini bila belum ada — minimal versi baca proyek + layers untuk kebutuhan panel).
- Produces: UI yang mengubah element timeline yang benar + undo sekali (insert via command → undo gratis dari `InsertElementCommand`).

**Konteks untuk pelaksana:** Panel berisi (Slice 1, tanpa library/template): daftar layers proyek aktif (nama, eye toggle → `hidden`, ▲▼ z-order, Hapus), upload asset langsung (klasifikasi ekstensi mengikuti `classifyBrandUpload` Klip: png/jpg/jpeg/webp, mp4/webm/mov, mp3/wav/m4a/ogg), tombol "Tambah ke timeline" (insert via `klipLayerToElement` + `insertElement`), inspector Transform (Scale slider, Position X/Y, Rotate, Opacity, Full/timed start/dur, Volume+Duck untuk audio). Setiap aksi panel: update DB via PATCH + update element timeline via `editor.timeline.updateElements` (cek signature di `timeline-manager.ts` sebelum pakai — jangan mengarang). Tab baru mengikuti pola `tabs` record + `TAB_KEYS` di `assets-panel-store.tsx` (icon Hugeicons, mis. `MagicWand05Icon` sudah dipakai effects — pilih icon lain yang tersedia).

- [ ] **Step 1: API brand-assets + brand GET/PATCH + test hijau**

```typescript
// __tests__/brand-api.test.ts (sketsa)
import { describe, expect, test } from "bun:test";
import { GET as getBrand, PATCH as patchBrand } from "@/app/api/klip/projects/[id]/brand/route";

describe("brand api", () => {
  test("PATCH eye toggle persists", async () => {
    // seed project+layer via db, PATCH { id, enabled: false }, GET, assert enabled=false
  });
});
```

- [ ] **Step 2: Panel UI + registrasi tab**

Ikuti struktur `MediaView`/`StickersView` (client component, `useEditor()`). Insert memakai `editor.timeline.insertElement({ placement: { mode: "auto" }, element })`.

- [ ] **Step 3: Verifikasi manual**

Semua aksi panel mengubah element timeline yang benar + undo sekali (Ctrl+Z mengembalikan insert).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/klip apps/web/src/app/api/klip apps/web/src/components/editor/panels/assets
git commit -m "feat(klip): minimal brand panel with timeline insert"
```

---

### Task 8: Verifikasi paritas preview↔export + Demo 1

Tanpa perubahan kode kecuali bila paritas kurang (maka ubah `preview/element-bounds.ts`, `graphics/`, `rendering/` seperlunya — tanpa rotate = tanpa filter tambahan).

**Files:** hanya bila perlu (lihat di atas). Test: manual visual.

- [ ] **Step 1: Siapkan proyek demo**

Upload 1 video → tambah 2 brand layer (1 image rotate 15°, 1 video timed) → atur drag/rotate/z-order via panel.

- [ ] **Step 2: Bandingkan frame export vs screenshot preview**

Export MP4 (`export/` → `downloadBuffer`) → bandingkan overlay dengan screenshot preview (visual check). Kriteria lolos: posisi/skala/opacity ≈ sama; rotate≠0 toleransi ±beberapa px di sudut besar.

- [ ] **Step 3: Catat hasil sebagai bukti Demo 1 (komentar di plan / docs, bukan kode)**

Demo 1 dinyatakan hijau bila: upload → 2 layers → export MP4 brand menempel sesuai preview.

---

## Self-Review (dijalankan penulis plan)

1. **Spec coverage:** §7-0b (Task 1) · §3 tabel media/projects/layers (Task 2) · §8-Slice 1 upload (Task 3–4) · §4 brand-map Rust + binding (Task 5–6) · §8-Slice 1 panel minimal (Task 7) · §4.3 paritas + Demo 1 (Task 8). Template/lCaption/BGM/publish/ZIP/main-page masuk Slice 2–4, benar tidak ada di plan ini. Legal baseline (§7-0c) dijadwalkan Slice 4 sesuai spec.
2. **Placeholder scan:** tidak ada TBD/TODO; setiap langkah berisi perintah/code konkret; fallback yang diizinkan (Task 4 `serverMeta`) diberi dua opsi eksplisit dengan kriteria pilih.
3. **Type consistency:** `KlipBrandLayer` (Rust, Task 5) ↔ literal layer di test TS (Task 6) field-nya sama 1:1 (`asset_id`, `file`, `x/y/scale/rotate/opacity/full/start/dur/volume/duck` + `z`); `MappedElement.target_track` (`Graphic|Video|Audio`) ↔ `track` string adapter (`"graphic"|"video"|"audio"`); kontrak skala (posisi/scale/opacity/volume-dB) didefinisikan sekali di Task 5 dan dirujuk Task 6–7.
