/**
 * Loader opencut-wasm untuk Node/Bun (worker batch, script, tes).
 *
 * KENAPA INI ADA
 * Paket `opencut-wasm` dibangun untuk target "bundler". Pembungkusnya
 * (opencut_wasm.js) melakukan `import * as wasm from "./opencut_wasm_bg.wasm"`
 * lalu langsung memanggil `wasm.__wbindgen_start()`.
 *
 * Di bundler (Next.js/webpack) impor .wasm menghasilkan objek WebAssembly,
 * jadi jalan. Di Bun/Node impor .wasm menghasilkan STRING PATH, sehingga
 * `__wbindgen_start is not a function`. Itu sebabnya seluruh suite tes yang
 * menyentuh @/wasm gagal selama ini — bukan karena wasm-nya rusak.
 *
 * Solusinya: impor modul glue-nya (bg.js, yang MURNI JS), kompilasi .wasm
 * sendiri, lalu suntikkan hasilnya lewat __wbg_set_wasm. Setelah itu semua
 * fungsi wasm berperilaku sama persis seperti di browser.
 *
 * PENTING: TICKS_PER_SECOND = 120000, BUKAN 1000. Jangan pernah
 * mengimplementasi ulang konversi waktu dengan asumsi milidetik.
 */

import { setWasmBindings, type WasmGlue } from "./wasm-bindings";

type WasmBindings = Record<string, unknown> & {
	__wbg_set_wasm: (instance: WebAssembly.Exports) => void;
};

/** Bungkus glue mentah supaya media-time bisa memakainya tanpa menyentuh wasm. */
function asGlue({ bg }: { bg: WasmBindings }): WasmGlue {
	return bg as unknown as WasmGlue;
}

let cached: WasmBindings | null = null;
let loading: Promise<WasmBindings> | null = null;

async function loadWasmNode(): Promise<WasmBindings> {
	const bg = (await import("opencut-wasm/opencut_wasm_bg.js")) as unknown as WasmBindings;
	const wasmPath = (await import("opencut-wasm/opencut_wasm_bg.wasm")).default as unknown;
	if (typeof wasmPath !== "string") {
		// Bundler sudah menangani .wasm; tidak perlu apa-apa lagi.
		setWasmBindings({ glue: asGlue({ bg }) });
		return bg;
	}
	const bytes = await (await import("node:fs/promises")).readFile(wasmPath);
	// Glue berisi banyak fungsi; WebAssembly.instantiate hanya butuh tabel impor,
	// jadi tipenya dilonggarkan di sini.
	const imports = { "./opencut_wasm_bg.js": bg } as unknown as WebAssembly.Imports;
	const { instance } = await WebAssembly.instantiate(bytes, imports);
	// Glue harus menerima instance SEBELUM __wbindgen_start dipanggil.
	bg.__wbg_set_wasm(instance.exports);
	const start = (instance.exports as Record<string, unknown>)["__wbindgen_start"];
	if (typeof start === "function") {
		(start as () => void)();
	}
	setWasmBindings({ glue: asGlue({ bg }) });
	return bg;
}

/**
 * Muat opencut-wasm di Node/Bun. Idempoten: panggilan berikutnya memakai
 * hasil yang sudah dimuat. WAJIB dipanggil (dan ditunggu) sebelum memakai
 * fungsi apa pun dari @/wasm.
 */
export async function ensureWasmLoaded(): Promise<void> {
	if (cached) return;
	if (!loading) loading = loadWasmNode();
	cached = await loading;
}

/** Hanya untuk tes: lupakan hasil muat supaya jalur pemuatan bisa diuji ulang. */
export function resetWasmLoaderForTests(): void {
	cached = null;
	loading = null;
}
