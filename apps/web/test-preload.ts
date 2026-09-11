/**
 * Preload tes Bun: siapkan opencut-wasm sebelum modul lain membacanya.
 *
 * `media-time.ts` mengevaluasi TICKS_PER_SECOND saat impor, jadi glue harus
 * sudah terdaftar sebelum modul apa pun menyentuh @/wasm. Preload dieksekusi
 * paling awal oleh Bun, jadi ini titik yang benar.
 *
 * Lihat src/wasm/node-loader.ts untuk penjelasan lengkapnya.
 */
import { ensureWasmLoaded } from "./src/wasm/node-loader";

await ensureWasmLoaded();
