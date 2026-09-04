# Brand Pack Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Template brand pack Level 1: susun overlay brand sekali (logo PNG full, video ads slot fix, BGM, video penutup ber-anchor akhir), simpan sebagai template, lalu apply ke video baru mana pun sehingga semua brand otomatis terpasang di posisinya.

**Architecture:** Dua tabel baru sejajar model brand yang ada. Semantik waktu (anchor) di-resolve murni di `rust/crates/klip` (sumber kebenaran logika, sesuai AGENTS.md) dengan mirror TypeScript 1:1 mengikuti pola tech-debt `brand-map`. API Next.js hanya copy/insert baris. UI web hanya render + panggil API.

**Tech Stack:** Rust (crate `klip`), TypeScript, Next.js route handlers, Drizzle ORM + MySQL, bun:test, cargo test.

## Global Constraints

- Runtime paket: `bun@1.2.18` (bun test, bukan vitest/jest).
- Test DB butuh MySQL lokal: `docker compose up -d db` dari repo root sebelum menjalankan test API.
- Migrasi DB hanya via `drizzle-kit generate` dari `apps/web`; jangan tulis SQL manual.
- Logika resolve anchor HANYA di `rust/crates/klip/src/template_resolve.rs`; file TS hanya mirror (alasan sama seperti header `apps/web/src/klip/brand-map.ts`).
- Keputusan diskusi yang dikunci: iklan selalu dipasang apa adanya (tidak pernah skip/clamp); durasi total project = max(durasi video utama, ujung layer terjauh); asset template referensi bersama ke `klip_media` kind=brand; apply = copy + replace (bukan link); tidak ada versioning v1.
- Belum ada endpoint hapus brand asset, jadi guard hapus-asset ditunda (follow-up, bukan Task plan ini).
- Bahasa UI mengikuti BrandPanel yang ada (Inggris).

---

## Locked semantics (acuan semua task)

```text
Template layer: { anchor: 'start' | 'main_end', full: bool, start: detik, dur: detik }

Resolve terhadap mainDuration D (durasi video utama dari ffprobe):
- full=true             -> { start: 0, dur: D }          (logo PNG, BGM; anchor diabaikan)
- anchor='start'        -> { start, dur } apa adanya     (ads slot fix, misal start=120 dur=30)
- anchor='main_end'     -> { start: D + start, dur }     (video penutup: start=0.1 artinya
                                                           0.1 dtk setelah video utama selesai;
                                                           start=-5 artinya 5 dtk sebelum ujung)

Total durasi project = max(D, semua (start + dur) hasil resolve).
```

Contoh diskusi: video 50 dtk + ads anchor main_end start=0.1 dur=20 -> ads di 50.1-70.1, total 70.1 dtk.

Save-as-template (project -> template) butuh D = project.duration ?? durasi source media; jika keduanya null, semua layer disimpan anchor='start' apa adanya:
- full                   -> full, anchor='start'
- start < D              -> anchor='start', start/dur apa adanya
- start >= D             -> anchor='main_end', start := start - D, dur apa adanya

Keterbatasan v1 yang disengaja: outro negatif (start di dalam video, misal D-5) yang di-apply lalu di-save-as lagi akan tersimpan sebagai anchor='start' absolut. Save-as sebaiknya dari project sumber template yang kanonis.

---

## File structure

```text
Buat:
  rust/crates/klip/src/template_resolve.rs          # resolve murni + unit test inline
  apps/web/src/klip/template-resolve.ts             # mirror TS 1:1 + bun test terpisah
  apps/web/src/klip/__tests__/template-resolve.test.ts
  apps/web/src/klip/templates.ts                    # helper DB server-side (list/get/create/apply/save-as)
  apps/web/src/klip/__tests__/template-api.test.ts  # test route handler template
  apps/web/src/app/api/klip/brand-templates/route.ts          # GET list, POST create
  apps/web/src/app/api/klip/brand-templates/[id]/route.ts     # GET (dgn layers), PATCH rename, DELETE
  apps/web/src/app/api/klip/projects/[id]/save-as-template/route.ts  # POST {name}
  apps/web/src/app/api/klip/projects/[id]/apply-template/route.ts    # POST {templateId, mainDuration?}

Ubah:
  rust/crates/klip/src/klip.rs                       # tambah mod + pub use (2 baris, pola brand_map)
  apps/web/src/db/schema.ts                          # tambah 2 tabel
  apps/web/migrations/                               # hasil drizzle-kit generate (jangan tulis manual)
  apps/web/src/klip/brand-panel.tsx                  # seksi Template: dropdown + Apply + Save as
```

Skema tabel baru (nama kolom mengikuti `klip_brand_layers` agar copy trivial):

```ts
klip_brand_templates: id varchar(64) PK, name varchar(255), createdAt, updatedAt
klip_brand_template_layers: id PK, templateId FK -> klip_brand_templates.id ON DELETE CASCADE,
  assetId varchar(64) null, filePath varchar(1024), name varchar(255),
  kind mysqlEnum(image|video|audio), enabled bool default true,
  anchor mysqlEnum(start|main_end) default start,
  x,y double, scale double, rotate double, opacity int, full bool, start double, dur double,
  volume double, duck bool, z int, createdAt
```

---

### Task 1: Resolve anchor di Rust

**Files:**
- Create: `rust/crates/klip/src/template_resolve.rs`
- Modify: `rust/crates/klip/src/klip.rs:1-3` (tambah `mod template_resolve;` + `pub use template_resolve::*;`)

**Interfaces:**
- Consumes: tidak ada (pure, tanpa dependensi crate lain selain std).
- Produces: `TemplateAnchor { Start, MainEnd }`, `TemplateLayerInput { anchor, full, start, dur }`, `ResolvedLayer { start, dur }`, `resolve_template_layer(layer: &TemplateLayerInput, main_duration: f64) -> ResolvedLayer`, `resolve_total_duration(main_duration: f64, layers: &[ResolvedLayer]) -> f64`. Dipakai Task 3 (mirror TS) dan Task 5 (dokumentasi perilaku server).
- [ ] **Step 1: Write the failing test**

Tambahkan file `rust/crates/klip/src/template_resolve.rs` berisi hanya test yang mereferensi fungsi yang belum ada:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_layer_spans_main_duration() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::Start, full: true, start: 99.0, dur: 99.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert_eq!(r.start, 0.0);
        assert_eq!(r.dur, 50.0);
    }

    #[test]
    fn fixed_slot_passes_through_untouched() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::Start, full: false, start: 120.0, dur: 30.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert_eq!(r.start, 120.0);
        assert_eq!(r.dur, 30.0);
    }

    #[test]
    fn main_end_anchor_offsets_from_main_duration() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::MainEnd, full: false, start: 0.1, dur: 20.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert!((r.start - 50.1).abs() < 1e-9);
        assert_eq!(r.dur, 20.0);
    }

    #[test]
    fn total_duration_extends_for_appended_ads() {
        let layers = vec![
            ResolvedLayer { start: 0.0, dur: 50.0 },
            ResolvedLayer { start: 50.1, dur: 20.0 },
        ];
        assert!((resolve_total_duration(50.0, &layers) - 70.1).abs() < 1e-9);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p klip template_resolve` dari repo root.
Expected: FAIL, error kompilasi `cannot find type TemplateLayerInput` (fungsi belum ada).

- [ ] **Step 3: Write minimal implementation**

Prepend ke file yang sama (di atas blok test):

```rust
/// Anchor waktu layer template terhadap video utama. Cermin TS:
/// apps/web/src/klip/template-resolve.ts (dibuat Task 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateAnchor {
    Start,
    MainEnd,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateLayerInput {
    pub anchor: TemplateAnchor,
    pub full: bool,
    pub start: f64,
    pub dur: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedLayer {
    pub start: f64,
    pub dur: f64,
}

/// full -> 0..main; Start -> apa adanya (tidak pernah skip/clamp);
/// MainEnd -> main_duration + start (start boleh negatif untuk outro di dalam video).
pub fn resolve_template_layer(layer: &TemplateLayerInput, main_duration: f64) -> ResolvedLayer {
    if layer.full {
        return ResolvedLayer { start: 0.0, dur: main_duration };
    }
    match layer.anchor {
        TemplateAnchor::Start => ResolvedLayer { start: layer.start, dur: layer.dur },
        TemplateAnchor::MainEnd => ResolvedLayer { start: main_duration + layer.start, dur: layer.dur },
    }
}

/// Durasi total project = max(durasi utama, ujung layer terjauh).
pub fn resolve_total_duration(main_duration: f64, layers: &[ResolvedLayer]) -> f64 {
    layers.iter().fold(main_duration, |acc, l| acc.max(l.start + l.dur))
}
```

Lalu daftarkan modul di `rust/crates/klip/src/klip.rs`:

```rust
mod brand_map;
mod template_resolve;

pub use brand_map::*;
pub use template_resolve::*;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p klip template_resolve` dari repo root.
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add rust/crates/klip/src/template_resolve.rs rust/crates/klip/src/klip.rs
git commit -m "feat(klip): resolve brand template anchor timing"
```

---

### Task 2: Skema DB + migrasi

**Files:**
- Modify: `apps/web/src/db/schema.ts` (append 2 tabel + 2 tipe)
- Create: `apps/web/migrations/00XX_*.sql` via drizzle-kit (jangan tulis manual)

**Interfaces:**
- Consumes: pola `klipBrandLayers` yang ada di schema.ts.
- Produces: `klipBrandTemplates`, `klipBrandTemplateLayers`, tipe `KlipBrandTemplate`, `KlipBrandTemplateLayer`. Dipakai Task 4-6.

- [ ] **Step 1: Tambahkan tabel ke schema.ts**

Append di bawah definisi `klipBrandLayers`:

```ts
export const klipBrandTemplates = mysqlTable("klip_brand_templates", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});

export type KlipBrandTemplate = typeof klipBrandTemplates.$inferSelect;

export const klipBrandTemplateLayers = mysqlTable("klip_brand_template_layers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  // Inline FK agar DDL memuat ON DELETE CASCADE (pola klipBrandLayers.projectId).
  templateId: varchar("template_id", { length: 64 })
    .notNull()
    .references(() => klipBrandTemplates.id, { onDelete: "cascade" }),
  assetId: varchar("asset_id", { length: 64 }),
  filePath: varchar("file_path", { length: 1024 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  kind: mysqlEnum("kind", ["image", "video", "audio"]).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  anchor: mysqlEnum("anchor", ["start", "main_end"]).default("start").notNull(),
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

export type KlipBrandTemplateLayer = typeof klipBrandTemplateLayers.$inferSelect;
```

- [ ] **Step 2: Generate migrasi**

Run dari `apps/web`: `bun run db:generate`
Expected: satu file SQL baru di `apps/web/migrations/` berisi `CREATE TABLE klip_brand_templates` dan `klip_brand_template_layers`. Verifikasi dengan `git status` bahwa hanya 1 file SQL baru + `meta/_journal.json` yang berubah.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/db/schema.ts apps/web/migrations/
git commit -m "feat(klip): brand template tables"
```
---

### Task 3: Mirror TS resolve + test

**Files:**
- Create: `apps/web/src/klip/template-resolve.ts`
- Create: `apps/web/src/klip/__tests__/template-resolve.test.ts`

**Interfaces:**
- Consumes: semantik Task 1 (nama dan perilaku identik).
- Produces: `TemplateAnchor ('start' | 'main_end')`, `TemplateLayerInput`, `ResolvedLayer`, `resolveTemplateLayer(layer, mainDuration)`, `resolveTotalDuration(mainDuration, layers)`. Dipakai Task 5 (apply/save-as).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/klip/__tests__/template-resolve.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTemplateLayer, resolveTotalDuration } from "@/klip/template-resolve";

describe("template-resolve", () => {
  test("full spans main duration", () => {
    expect(resolveTemplateLayer({ anchor: "start", full: true, start: 99, dur: 99 }, 50)).toEqual({ start: 0, dur: 50 });
  });
  test("fixed slot passes through", () => {
    expect(resolveTemplateLayer({ anchor: "start", full: false, start: 120, dur: 30 }, 50)).toEqual({ start: 120, dur: 30 });
  });
  test("main_end offsets from main duration", () => {
    const r = resolveTemplateLayer({ anchor: "main_end", full: false, start: 0.1, dur: 20 }, 50);
    expect(r.start).toBeCloseTo(50.1, 9);
    expect(r.dur).toBe(20);
  });
  test("total extends for appended ads", () => {
    expect(resolveTotalDuration(50, [{ start: 0, dur: 50 }, { start: 50.1, dur: 20 }])).toBeCloseTo(70.1, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run dari repo root: `bun test apps/web/src/klip/__tests__/template-resolve.test.ts`
Expected: FAIL, `error: Cannot find module "@/klip/template-resolve"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/klip/template-resolve.ts
/**
 * Mirror 1:1 dari rust/crates/klip/src/template_resolve.rs (sumber kebenaran).
 * Alasan sama seperti brand-map.ts: logika milik rust/, TS hanya port.
 * Jangan tambah perilaku di sini; ubah Rust dulu lalu port.
 */
export type TemplateAnchor = "start" | "main_end";

export interface TemplateLayerInput {
  anchor: TemplateAnchor;
  full: boolean;
  start: number;
  dur: number;
}

export interface ResolvedLayer {
  start: number;
  dur: number;
}

export function resolveTemplateLayer(layer: TemplateLayerInput, mainDuration: number): ResolvedLayer {
  if (layer.full) return { start: 0, dur: mainDuration };
  if (layer.anchor === "main_end") return { start: mainDuration + layer.start, dur: layer.dur };
  return { start: layer.start, dur: layer.dur };
}

export function resolveTotalDuration(mainDuration: number, layers: ResolvedLayer[]): number {
  return layers.reduce((acc, l) => Math.max(acc, l.start + l.dur), mainDuration);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/klip/__tests__/template-resolve.test.ts`
Expected: PASS, 4 pass 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/klip/template-resolve.ts apps/web/src/klip/__tests__/template-resolve.test.ts
git commit -m "feat(klip): template anchor resolve TS mirror"
```

---

### Task 4: Helper DB + API CRUD template

**Files:**
- Create: `apps/web/src/klip/templates.ts`
- Create: `apps/web/src/app/api/klip/brand-templates/route.ts` (GET list, POST create)
- Create: `apps/web/src/app/api/klip/brand-templates/[id]/route.ts` (GET dgn layers, PATCH rename, DELETE)
- Create: `apps/web/src/klip/__tests__/template-api.test.ts`

**Interfaces:**
- Consumes: tabel Task 2, `newBrandId` dari `@/klip/brand`, pola handler dari `@/app/api/klip/projects/[id]/brand/route.ts`.
- Produces: route CRUD. `DELETE` template mengandalkan ON DELETE CASCADE untuk layers. Dipakai Task 5-6.

Kontrak API:
- `GET /api/klip/brand-templates` -> `{ templates: [{id,name,layerCount,updatedAt}] }`
- `POST /api/klip/brand-templates {name}` -> 201 `{ template }`; 400 jika nama kosong.
- `GET /api/klip/brand-templates/[id]` -> `{ template, layers }` (layers urut `z`); 404 jika tidak ada.
- `PATCH .../[id] {name}` -> `{ template }`; 400 jika nama kosong.
- `DELETE .../[id]` -> `{ ok: true }` (layers ikut terhapus via CASCADE); 404 jika tidak ada.

- [ ] **Step 1: Write the failing test**

Ikuti pola `apps/web/src/klip/__tests__/brand-api.test.ts`: helper `req({url,init})` yang cast `Request` ke `NextRequest`, `beforeAll` set `process.env.KLIP_DATA_ROOT` ke tmpdir, lacak id di array dan bersihkan di `afterAll` (hapus `klipBrandTemplateLayers` by templateId lalu `klipBrandTemplates`).

```ts
import { describe, expect, test } from "bun:test";
import { GET as listTemplates, POST as createTemplate } from "@/app/api/klip/brand-templates/route";
import { DELETE as deleteTemplate, GET as getTemplate } from "@/app/api/klip/brand-templates/[id]/route";

// ...helper req + cleanup + track() seperti brand-api.test.ts...

test("create then get template", async () => {
  const created = await createTemplate(req({ url: "http://localhost/api/klip/brand-templates", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Paket Lebaran" }) } }));
  expect(created.status).toBe(201);
  const { template } = (await created.json()) as { template: { id: string } };
  track(template.id);
  const got = await getTemplate(req({ url: `http://localhost/api/klip/brand-templates/${template.id}` }), { params: Promise.resolve({ id: template.id }) });
  expect(got.status).toBe(200);
  const body = (await got.json()) as { layers: unknown[] };
  expect(body.layers).toEqual([]);
});

test("create rejects empty name", async () => {
  const res = await createTemplate(req({ url: "http://localhost/api/klip/brand-templates", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "  " }) } }));
  expect(res.status).toBe(400);
});

test("list includes created template with layerCount", async () => {
  const res = await listTemplates();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { templates: Array<{ id: string; layerCount: number }> };
  expect(body.templates.length).toBeGreaterThanOrEqual(1);
  for (const t of body.templates) expect(typeof t.layerCount).toBe("number");
});
```

- [ ] **Step 2: Run test to verify it fails**

Pastikan MySQL jalan: `docker compose up -d db` dari repo root. Run: `bun test apps/web/src/klip/__tests__/template-api.test.ts`
Expected: FAIL, `Cannot find module "@/app/api/klip/brand-templates/route"`.

- [ ] **Step 3: Write minimal implementation**

`apps/web/src/klip/templates.ts`: fungsi `listTemplates()` (select templates + count layers per template via query per template, cukup untuk v1), `createTemplate(name)` (trim, throw jika kosong, id via `newBrandId({prefix:"btpl"})`), `getTemplateWithLayers(id)` (template + layers order by `z`, null jika tidak ada), `renameTemplate(id,name)`, `deleteTemplate(id)` (delete template; layers ikut CASCADE; return false jika tidak ada).

`route.ts` (koleksi): GET -> `{ templates }`; POST parse JSON, 400 `name is required` jika kosong, 201 `{ template }`.

`[id]/route.ts`: GET -> 404 `Not found` jika null else `{ template, layers }`; PATCH body `{name}`, sanitize trim, 400 jika kosong; DELETE -> 404 jika tidak ada else `{ ok: true }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/klip/__tests__/template-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/klip/templates.ts apps/web/src/app/api/klip/brand-templates/ apps/web/src/klip/__tests__/template-api.test.ts
git commit -m "feat(klip): brand template CRUD API"
```
---

### Task 5: Save-as-template + Apply-template

**Files:**
- Modify: `apps/web/src/klip/templates.ts` (tambah `saveAsTemplate`, `applyTemplate`, `resolveMainDuration`)
- Create: `apps/web/src/app/api/klip/projects/[id]/save-as-template/route.ts`
- Create: `apps/web/src/app/api/klip/projects/[id]/apply-template/route.ts`
- Modify: `apps/web/src/klip/__tests__/template-api.test.ts` (tambah 3 test)

**Interfaces:**
- Consumes: `resolveTemplateLayer/resolveTotalDuration` (Task 3), tabel Task 2, `listLayers` dari `@/klip/brand`. Project harus sudah ada -> 404 jika tidak (jangan auto-create di sini).
- Produces: `POST save-as-template {name} -> {template, layerCount}`; `POST apply-template {templateId, mainDuration?} -> {layers, totalDuration}`.

Aturan main duration (apply): `body.mainDuration ?? project.duration ?? durasi klipMedia sourceMediaId`; jika semua null -> 400 `main duration unknown`.
Aturan save-as anchor: pakai tabel konversi Locked semantics; jika D null -> semua anchor='start' apa adanya.
Aturan apply: HAPUS semua `klip_brand_layers` project dulu lalu insert hasil resolve (replace, bukan append); layer full tetap full=true; kolom lain di-copy 1:1 dari template (assetId, filePath, name, kind, enabled, x, y, scale, rotate, opacity, volume, duck, z); id baru via `newBrandId` (periksa prefix aktual yang dipakai POST brand route sebelum menulis; saat plan ini ditulis polanya `newBrandId({prefix:...})`).

- [ ] **Step 1: Write the failing tests**

Tambahkan ke `template-api.test.ts`. Setup tiap test: buat project via `byOpencut` (pola brand-api.test.ts), insert layer project / layer template langsung via Drizzle. Nilai konkret: mainDuration=50, layer full logo, layer ads anchor='main_end' start=0.1 dur=20.

```ts
test("save-as-template copies layers with anchor conversion", async () => {
  // project P: layer logo full + layer ads start=50.1 dur=20 (sudah ter-resolve absolut)
  // POST save-as-template {name:"Paket A"} -> 201, layerCount 2
  // GET template -> layer logo {full:true, anchor:"start"}, layer ads {anchor:"main_end", start mendekati 0.1}
});

test("apply-template resolves and replaces layers", async () => {
  // template T: logo full + ads main_end start=0.1 dur=20
  // POST apply-template {templateId:T, mainDuration:50} -> layers ads start mendekati 50.1, totalDuration mendekati 70.1
  // POST apply-template lagi -> jumlah layer tetap 2 (replace, tidak duplikat)
});

test("apply-template rejects unknown main duration", async () => {
  // project fresh tanpa duration + tanpa sourceMediaId -> POST apply-template {templateId} -> 400
});
```

Tulis implementasi test lengkap dengan insert Drizzle langsung (pola cleanup/insert brand-api.test.ts). Tidak ada placeholder.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/klip/__tests__/template-api.test.ts`
Expected: FAIL, `Cannot find module` untuk kedua route baru.

- [ ] **Step 3: Write minimal implementation**

`templates.ts`: `resolveMainDuration(project)` (project.duration ?? query klipMedia by sourceMediaId -> duration ?? null), `saveAsTemplate(projectId, name)` (404 jika project tidak ada; copy layers dengan konversi anchor; return `{template, layerCount}`), `applyTemplate(projectId, templateId, mainDuration?)` (404 project/template; resolve D; delete layers lama; insert hasil resolve; return `{layers, totalDuration}`).

Route save-as-template: POST parse `{name}`, 400 jika kosong, 201 `{template, layerCount}`.
Route apply-template: POST parse `{templateId, mainDuration}`, 400 jika templateId hilang atau D null, 200 `{layers, totalDuration}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/klip/__tests__/template-api.test.ts apps/web/src/klip/__tests__/brand-api.test.ts`
Expected: PASS semua (tidak ada regresi brand lama).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/klip/templates.ts "apps/web/src/app/api/klip/projects/[id]/save-as-template/" "apps/web/src/app/api/klip/projects/[id]/apply-template/" apps/web/src/klip/__tests__/template-api.test.ts
git commit -m "feat(klip): save-as and apply brand template"
```

---

### Task 6: UI Template di BrandPanel (web shell saja)

**Files:**
- Modify: `apps/web/src/klip/brand-panel.tsx` (tambah seksi Template di atas daftar layers)

**Interfaces:**
- Consumes: endpoint Task 4-5, `refresh()` yang ada, logika `handleAddToTimeline` yang ada.
- Produces: user bisa pilih template -> Apply -> semua layer masuk timeline; user bisa Save as template dari project aktif.

Perilaku:
- Dropdown daftar template (fetch `GET /api/klip/brand-templates` saat panel dibuka) + tombol Apply.
- Input nama + tombol Save as template (POST save-as-template dengan klipProjectId aktif).
- Setelah Apply sukses: `await refresh()` lalu untuk SETIAP layer baru jalankan logika yang sama persis dengan `handleAddToTimeline` (fetch /api/media -> processMediaAssets -> addMediaAsset -> klipLayerToElement -> insertElement dengan id-diff). Refactor kecil: ekstrak isi `handleAddToTimeline` menjadi fungsi `insertDraftToTimeline(draft)` agar dipakai berdua; jangan ubah perilakunya.
- totalDuration: response apply membawa `totalDuration`; jika lebih besar dari durasi project aktif, update durasi project via API yang sama dengan yang dipakai saat import media utama. Periksa `editor.project` API saat implementasi; jika tidak ada API update durasi, tampilkan toast info berisi angka totalDuration dan biarkan user trim manual. Jangan menebak API.
- Toast sukses/gagal mengikuti pola yang ada (`toast.success`/`toast.error`).

- [ ] **Step 1: Implementasi seksi Template + refactor insertDraftToTimeline**
- [ ] **Step 2: Verifikasi manual**: `bun dev:web`, buka editor, upload 1 brand PNG + 1 video ads, Save as template, buka project baru, Apply, pastikan posisi/waktu sesuai. Jalankan `bun test apps/web/src/klip/__tests__/` (tidak ada regresi) dan `git diff --check`.
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/klip/brand-panel.tsx
git commit -m "feat(klip): template picker in brand panel"
```

Follow-up yang SENGAJA tidak masuk v1 (jangan kerjakan): guard hapus brand asset yang dipakai template (belum ada endpoint hapus asset), versioning template, apply massal ke batch zip (bagian diskusi upload-mass), caption preset (bagian diskusi publish).

---

## Self-review

1. Spec coverage: logo full (full=true) -> Task 1,3,5; ads slot fix (anchor start) -> Task 1,3,5; ads setelah video 50.1 (anchor main_end) -> Task 1,3,5; BGM full audio (kind audio + volume/duck ikut copy) -> Task 5; save dari project jadi -> Task 5; upload video tinggal pilih template -> Task 6. Semua tercakup.
2. Placeholder scan: tidak ada TBD/TODO/"handle edge cases" generik; aturan unknown-duration, replace-vs-append, dan round-trip save-as ditulis eksplisit.
3. Type consistency: `TemplateAnchor/TemplateLayerInput/ResolvedLayer/resolve_template_layer/resolve_total_duration` (Rust snake_case) <-> `TemplateAnchor/TemplateLayerInput/ResolvedLayer/resolveTemplateLayer/resolveTotalDuration` (TS camelCase), konversi terdokumentasi; nama tabel/kolom sama dengan pola `klipBrand*` yang ada.
