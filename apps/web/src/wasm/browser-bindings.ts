/**
 * Impor statis opencut-wasm untuk BROWSER saja.
 *
 * Dipisah dari media-time.ts supaya media-time tidak mengeksekusi impor itu
 * di Node (yang membuat modul gagal dimuat sebelum loader sempat bekerja).
 * Nilainya diambil lewat getter, jadi modul ini hanya tersentuh saat benar-
 * benar dipakai — dan di Node yang dipakai adalah glue dari loader.
 */
import {
	lastFrameTime as _lastFrameTime,
	parseTimecode as _parseTimecode,
	roundToFrame as _roundToFrame,
	snappedSeekTime as _snappedSeekTime,
	TICKS_PER_SECOND as _TICKS_PER_SECOND,
	mediaTimeFromSeconds as _mediaTimeFromSeconds,
	mediaTimeToSeconds as _mediaTimeToSeconds,
} from "opencut-wasm";

export const browserBindings = {
	TICKS_PER_SECOND: _TICKS_PER_SECOND,
	mediaTimeFromSeconds: _mediaTimeFromSeconds,
	mediaTimeToSeconds: _mediaTimeToSeconds,
	roundToFrame: _roundToFrame,
	snappedSeekTime: _snappedSeekTime,
	lastFrameTime: _lastFrameTime,
	parseTimecode: _parseTimecode,
};
