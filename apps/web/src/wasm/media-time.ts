import { bindingsSync, type TimeBindings } from "./time-bindings";

/**
 * Integer-tick time. Mirrors `rust/crates/time/src/media_time.rs`.
 *
 * `opencut-wasm` exposes `MediaTime` as a bare `number` alias because tsify
 * collapses tuple structs. The brand here is the TS-side discipline that
 * recovers the invariant: a `MediaTime` is an integer count of ticks, and the
 * only legal way to construct one from a fractional `number` is `roundMediaTime`
 * (or `mediaTimeFromSeconds`, which rounds inside the wasm boundary).
 *
 * Reading is free — `MediaTime` is assignable to `number`. Writing is gated —
 * a bare `number` is not assignable to `MediaTime`.
 *
 * PENTING — kenapa tidak ada `import ... from "opencut-wasm"` di sini:
 * paket itu dibangun untuk bundler, dan di Node impor statisnya langsung
 * gagal saat modul dibaca. Glue-nya karena itu disuntikkan lewat
 * time-bindings (loader di Node, preload di browser). Nilainya berasal dari
 * wasm yang SAMA — bukan reimplementasi — jadi tidak ada risiko menyimpang.
 *
 * TICKS_PER_SECOND = 120000, BUKAN 1000.
 */
export type MediaTime = number & { readonly __mediaTime: unique symbol };

function bindings(): TimeBindings {
	return bindingsSync();
}

export const TICKS_PER_SECOND = bindings().TICKS_PER_SECOND();

function isMediaTime(value: number): value is MediaTime {
	return Number.isInteger(value);
}

function requireMediaTime({
	value,
	context,
}: {
	value: number;
	context: string;
}): MediaTime {
	if (!isMediaTime(value)) {
		throw new Error(`${context}: expected an integer tick count, got ${value}`);
	}
	return value;
}

export const ZERO_MEDIA_TIME = requireMediaTime({
	value: 0,
	context: "ZERO_MEDIA_TIME",
});

/**
 * Construct a `MediaTime` from a known-integer tick count. Use `roundMediaTime`
 * when the input may be fractional.
 */
export function mediaTime({ ticks }: { ticks: number }): MediaTime {
	return requireMediaTime({
		value: ticks,
		context: "mediaTime()",
	});
}

/**
 * Project a fractional value onto the integer-tick lattice.
 *
 * Rounds half away from zero (`-1.5 → -2`, `1.5 → 2`) and normalises `-0` to
 * `0`. The away-from-zero rule matches Rust's `.round()`.
 */
export function roundMediaTime({ time }: { time: number }): MediaTime {
	const roundedMagnitude = Math.round(Math.abs(time));
	if (roundedMagnitude === 0) {
		return ZERO_MEDIA_TIME;
	}
	return requireMediaTime({
		value: time < 0 ? -roundedMagnitude : roundedMagnitude,
		context: "roundMediaTime()",
	});
}

export function mediaTimeFromSeconds({
	seconds,
}: {
	seconds: number;
}): MediaTime {
	const result = bindings().mediaTimeFromSeconds({ seconds });
	if (result === undefined) {
		throw new Error(
			`mediaTimeFromSeconds: rust returned undefined for seconds=${seconds}`
		);
	}
	return requireMediaTime({
		value: result,
		context: "mediaTimeFromSeconds()",
	});
}

export function mediaTimeToSeconds({ time }: { time: MediaTime }): number {
	return bindings().mediaTimeToSeconds({ time });
}

/**
 * Sum `MediaTime` values. Inputs are integer ticks, so the sum is integer too.
 */
export function addMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return requireMediaTime({
		value: a + b,
		context: "addMediaTime()",
	});
}

export function subMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return requireMediaTime({
		value: a - b,
		context: "subMediaTime()",
	});
}

export function maxMediaTime({ a, b }: { a: MediaTime; b: MediaTime }): MediaTime {
	return a > b ? a : b;
}

export function minMediaTime({ a, b }: { a: MediaTime; b: MediaTime }): MediaTime {
	return a < b ? a : b;
}

export function clampMediaTime({
	time,
	min,
	max,
}: {
	time: MediaTime;
	min: MediaTime;
	max: MediaTime;
}): MediaTime {
	if (time < min) return min;
	if (time > max) return max;
	return time;
}

export function roundFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: unknown;
}): MediaTime {
	return requireMediaTime({
		value: bindings().roundToFrame({ time, rate: fps }) ?? time,
		context: "roundFrameTime()",
	});
}

export function roundFrameTicks({ ticks, fps }: { ticks: number; fps: unknown }): number {
	return bindings().roundToFrame({ time: ticks, rate: fps }) ?? ticks;
}

export function snapSeekMediaTime({
	time,
	duration,
	fps,
}: {
	time: MediaTime;
	duration: MediaTime;
	fps: unknown;
}): MediaTime {
	return requireMediaTime({
		value: bindings().snappedSeekTime({ time, duration, rate: fps }) ?? time,
		context: "snapSeekMediaTime()",
	});
}

export function lastFrameMediaTime({
	duration,
	fps,
}: {
	duration: MediaTime;
	fps: unknown;
}): MediaTime {
	return requireMediaTime({
		value: bindings().lastFrameTime({ duration, rate: fps }) ?? duration,
		context: "lastFrameMediaTime()",
	});
}

export function parseMediaTimecode({
	timeCode,
	format,
	fps,
}: {
	timeCode: string;
	format: unknown;
	fps: unknown;
}): MediaTime | null {
	const parsedTime = bindings().parseTimecode({ timeCode, format, rate: fps });
	if (parsedTime == null) {
		return null;
	}
	return requireMediaTime({
		value: parsedTime,
		context: "parseMediaTimecode()",
	});
}

export type { FrameRate, TimeCodeFormat } from "opencut-wasm";
