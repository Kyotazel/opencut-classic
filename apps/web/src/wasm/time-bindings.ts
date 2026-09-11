/**
 * Sumber pengikatan wasm untuk lapisan waktu.
 *
 * MASALAH: paket `opencut-wasm` dibangun untuk bundler. Di Bun/Node, impor
 * statis apa pun ke paket itu langsung gagal ("__wbindgen_start is not a
 * function") saat modul dibaca — sebelum kode kita sempat berjalan. Karena ESM
 * mengeksekusi impor statis lebih dulu, impor itu TIDAK BOLEH ada di jalur
 * yang dibaca worker.
 *
 * SOLUSI: di Node, loader mendaftarkan glue hasil kompilasi manual lebih dulu
 * (lihat node-loader.ts). Di browser, glue diambil lewat impor DINAMIS saat
 * pertama dipakai. Karena `resolveBindings()` async, media-time memakai
 * `bindingsSync()` yang hanya valid setelah pemuatan selesai — dan pemuatan
 * itu dipicu eksplisit lewat `loadBindings()` (worker) atau otomatis saat
 * pertama kali halaman membutuhkannya.
 */
import { wasmBindings } from "./wasm-bindings";

export type TimeBindings = {
	TICKS_PER_SECOND: () => number;
	mediaTimeFromSeconds: (args: { seconds: number }) => number;
	mediaTimeToSeconds: (args: { time: number }) => number;
	roundToFrame: (args: { time: number; rate: unknown }) => number | undefined;
	snappedSeekTime: (args: {
		time: number;
		duration: number;
		rate: unknown;
	}) => number | undefined;
	lastFrameTime: (args: { duration: number; rate: unknown }) => number | undefined;
	parseTimecode: (args: {
		timeCode: string;
		format: unknown;
		rate: unknown;
	}) => number | null | undefined;
};

let browser: TimeBindings | null = null;
let loading: Promise<void> | null = null;

/**
 * Muat glue browser lewat impor dinamis. Tidak dipanggil di Node; loader
 * Node sudah mendaftarkan glue-nya lebih dulu.
 */
export async function loadBrowserBindings(): Promise<void> {
	if (wasmBindings()) return;
	if (!loading) {
		loading = import("./browser-bindings").then((m) => {
			browser = m.browserBindings as unknown as TimeBindings;
		});
	}
	await loading;
}

/**
 * Glue yang aktif: dari loader (Node) atau hasil impor dinamis (browser).
 * Melempar kalau belum ada — itu berarti pemuatan belum dipicu, dan memakai
 * nilai tebakan lebih berbahaya daripada gagal terang-terangan.
 */
export function bindingsSync(): TimeBindings {
	const injected = wasmBindings();
	if (injected) return injected as unknown as TimeBindings;
	if (browser) return browser;
	throw new Error(
		"wasm belum dimuat: panggil ensureWasmLoaded() (Node) atau loadBrowserBindings() (browser) lebih dulu",
	);
}

/** True kalau glue sudah siap dipakai. */
export function bindingsReady(): boolean {
	return wasmBindings() !== null || browser !== null;
}
