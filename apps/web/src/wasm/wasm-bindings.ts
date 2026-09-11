/**
 * Jembatan antara node-loader dan media-time.
 *
 * KENAPA ADA: `media-time.ts` mengimpor fungsi dari "opencut-wasm" secara
 * statis untuk dipakai di browser. Di Node/Bun impor itu gagal. Ketika loader
 * berhasil mengompilasi wasm, ia mendaftarkan glue-nya di sini, dan
 * media-time memakai versi itu. Nilainya dari wasm yang SAMA, jadi tidak ada
 * kemungkinan menyimpang.
 *
 * Di browser tidak ada yang mendaftar, `wasmBindings()` mengembalikan null,
 * dan media-time memakai impor statis seperti biasa. Jalur browser TIDAK
 * berubah sama sekali.
 */

export type WasmGlue = {
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

let injected: WasmGlue | null = null;

export function setWasmBindings({ glue }: { glue: WasmGlue }): void {
	injected = glue;
}

/** null di browser (pakai impor statis); terisi setelah loader jalan di Node. */
export function wasmBindings(): WasmGlue | null {
	return injected;
}

export function clearWasmBindings(): void {
	injected = null;
}
