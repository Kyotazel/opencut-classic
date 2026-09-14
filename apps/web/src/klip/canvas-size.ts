import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import type { TCanvasSize } from "@/project/types";

/**
 * Pilih ukuran kanvas yang sesuai orientasi video.
 *
 * Sebelumnya selalu dipakai DEFAULT_CANVAS_SIZE (1920x1080, landscape).
 * Untuk video potrait - yang lazim untuk konten vertikal - hasilnya kanvas
 * landscape dengan video potrait di tengahnya, sehingga ada bilah hitam di
 * kiri dan kanan.
 *
 * Rasio TIDAK dipaksa sama dengan video: yang dipilih adalah preset terdekat
 * berdasarkan orientasi. Ukuran video bisa ganjil (mis. 1216x2160) dan
 * menyimpannya apa adanya akan membuat template yang dirancang untuk
 * 1080x1920 meleset.
 *
 * Modul ini sengaja tidak mengimpor apa pun dari editor, supaya bisa diuji
 * di Node tanpa menyeret opencut-wasm.
 */
export function canvasSizeForVideo({
	width,
	height,
}: {
	width?: number | null;
	height?: number | null;
}): TCanvasSize {
	if (!width || !height || width <= 0 || height <= 0) {
		return DEFAULT_CANVAS_SIZE;
	}
	const ratio = width / height;
	// Toleransi 5% supaya 1216x2160 tetap dianggap potrait 9:16.
	if (ratio < 0.95) return { width: 1080, height: 1920 };
	if (ratio > 1.05) return { width: 1920, height: 1080 };
	return { width: 1080, height: 1080 };
}
