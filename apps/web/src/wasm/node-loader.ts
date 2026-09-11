/**
 * Loader opencut-wasm untuk Node/Bun (script, tes, alat bantu).
 *
 * KENAPA INI ADA
 * Paket `opencut-wasm` dibangun untuk target "bundler". Pembungkusnya
 * mengimpor "./opencut_wasm_bg.wasm" lalu memanggil `wasm.__wbindgen_start()`.
 * Di bundler impor .wasm = objek WebAssembly; di Bun/Node = STRING PATH,
 * sehingga fungsi itu tidak ada.
 *
 * CARA KERJA
 * Modul glue `opencut-wasm/opencut_wasm_bg.js` MURNI JavaScript dan bisa
 * diimpor di Node. Yang kurang hanya instance wasm-nya: kompilasi .wasm
 * sendiri, lalu suntikkan lewat `__wbg_set_wasm`. Glue asli, bukan tiruan.
 *
 * CATATAN PENTING
 * Ini TIDAK membuat @/wasm bisa dipakai di Node. `media-time.ts` mengimpor
 * pembungkus "opencut-wasm" secara statis, dan itu tetap gagal. Loader ini
 * berguna untuk memakai glue langsung (mis. membandingkan nilai), bukan untuk
 * menjalankan kode editor di Node. Worker memakai Chromium headless.
 *
 * TICKS_PER_SECOND = 120000, BUKAN 1000.
 */

type WasmBindings = Record<string, unknown> & {
	__wbg_set_wasm: (instance: WebAssembly.Exports) => void;
};

let loaded = false;
let loading: Promise<void> | null = null;

async function loadWasmNode(): Promise<void> {
	const bg = (await import(
		"opencut-wasm/opencut_wasm_bg.js"
	)) as unknown as WasmBindings;
	const wasmPath = (await import("opencut-wasm/opencut_wasm_bg.wasm"))
		.default as unknown;
	if (typeof wasmPath !== "string") {
		// Bundler sudah menangani .wasm; tidak ada yang perlu dilakukan.
		return;
	}
	const { readFile } = await import("node:fs/promises");
	const bytes = await readFile(wasmPath);
	const imports = {
		"./opencut_wasm_bg.js": bg,
	} as unknown as WebAssembly.Imports;
	const { instance } = await WebAssembly.instantiate(bytes, imports);
	// Instance harus dipasang SEBELUM __wbindgen_start dipanggil.
	bg.__wbg_set_wasm(instance.exports);
	const start = (instance.exports as Record<string, unknown>)["__wbindgen_start"];
	if (typeof start === "function") {
		(start as () => void)();
	}
}

/**
 * Muat glue opencut-wasm di Node/Bun. Idempoten.
 */
export async function ensureWasmLoaded(): Promise<void> {
	if (loaded) return;
	if (!loading) loading = loadWasmNode();
	await loading;
	loaded = true;
}
