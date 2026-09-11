/**
 * Deklarasi tipe untuk subpath opencut-wasm yang dipakai loader Node.
 *
 * Paket opencut-wasm hanya mengekspor tipe untuk entry utamanya. Loader
 * mengimpor glue (bg.js) dan .wasm mentah untuk mengompilasinya sendiri,
 * jadi bentuknya perlu dinyatakan di sini.
 */
declare module "opencut-wasm/opencut_wasm_bg.js" {
	const bindings: Record<string, unknown> & {
		__wbg_set_wasm: (instance: WebAssembly.Exports) => void;
	};
	export = bindings;
}

declare module "opencut-wasm/opencut_wasm_bg.wasm" {
	/** Bundler: objek wasm. Node/Bun: path string ke file .wasm. */
	const wasmModule: unknown;
	export default wasmModule;
}
