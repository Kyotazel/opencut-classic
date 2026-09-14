import { describe, expect, test } from "bun:test";
import { isWithinWindow, minutesUntilWindow } from "@/klip/worker/window";

/**
 * Window waktu render (T3-5).
 *
 * Ini tuas tunggal yang membatasi beban CPU server, RAM Chromium, dan laju
 * publish ke Instagram sekaligus. Kesalahan di sini berbahaya: window yang
 * salah bisa membekukan worker selamanya tanpa pesan error.
 *
 * Default harus "selalu terbuka" supaya upload langsung dikerjakan tanpa
 * setelan apa pun.
 */

const T = ({ hour, minute }: { hour: number; minute: number }) => ({ hour, minute });

describe("isWithinWindow", () => {
	test("tanpa batas berarti selalu terbuka", () => {
		// Ini yang membuat upload langsung dikerjakan secara default.
		expect(isWithinWindow({ now: T({ hour: 3, minute: 0 }), start: null, end: null })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 23, minute: 59 }), start: null, end: null })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 12, minute: 0 }), start: null, end: null })).toBe(true);
	});

	test("window normal 11:00-15:00", () => {
		const args = { start: T({ hour: 11, minute: 0 }), end: T({ hour: 15, minute: 0 }) };
		expect(isWithinWindow({ now: T({ hour: 10, minute: 59 }), ...args })).toBe(false);
		expect(isWithinWindow({ now: T({ hour: 11, minute: 0 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 13, minute: 30 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 14, minute: 59 }), ...args })).toBe(true);
		// Batas akhir eksklusif: 15:00 sudah di luar.
		expect(isWithinWindow({ now: T({ hour: 15, minute: 0 }), ...args })).toBe(false);
		expect(isWithinWindow({ now: T({ hour: 20, minute: 0 }), ...args })).toBe(false);
	});

	test("window melewati tengah malam 22:00-02:00", () => {
		const args = { start: T({ hour: 22, minute: 0 }), end: T({ hour: 2, minute: 0 }) };
		expect(isWithinWindow({ now: T({ hour: 21, minute: 59 }), ...args })).toBe(false);
		expect(isWithinWindow({ now: T({ hour: 22, minute: 0 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 23, minute: 30 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 0, minute: 30 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 1, minute: 59 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 2, minute: 0 }), ...args })).toBe(false);
		expect(isWithinWindow({ now: T({ hour: 12, minute: 0 }), ...args })).toBe(false);
	});

	test("start sama dengan end berarti 24 jam, bukan nol menit", () => {
		// Kalau dianggap nol menit, worker membeku selamanya tanpa error.
		const args = { start: T({ hour: 11, minute: 0 }), end: T({ hour: 11, minute: 0 }) };
		expect(isWithinWindow({ now: T({ hour: 11, minute: 0 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 3, minute: 0 }), ...args })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 22, minute: 0 }), ...args })).toBe(true);
	});

	test("batas yang hanya sebagian diisi dianggap terbuka", () => {
		expect(isWithinWindow({ now: T({ hour: 5, minute: 0 }), start: T({ hour: 11, minute: 0 }), end: null })).toBe(true);
		expect(isWithinWindow({ now: T({ hour: 5, minute: 0 }), start: null, end: T({ hour: 11, minute: 0 }) })).toBe(true);
	});
});

describe("minutesUntilWindow", () => {
	test("nol kalau sedang di dalam window", () => {
		expect(
			minutesUntilWindow({
				now: T({ hour: 12, minute: 0 }),
				start: T({ hour: 11, minute: 0 }),
				end: T({ hour: 15, minute: 0 }),
			}),
		).toBe(0);
	});

	test("menghitung sisa waktu di hari yang sama", () => {
		// 08:00 menuju 11:00 = 180 menit.
		expect(
			minutesUntilWindow({
				now: T({ hour: 8, minute: 0 }),
				start: T({ hour: 11, minute: 0 }),
				end: T({ hour: 15, minute: 0 }),
			}),
		).toBe(180);
		expect(
			minutesUntilWindow({
				now: T({ hour: 10, minute: 30 }),
				start: T({ hour: 11, minute: 0 }),
				end: T({ hour: 15, minute: 0 }),
			}),
		).toBe(30);
	});

	test("melewati tengah malam kalau window sudah lewat", () => {
		// 16:00 menuju 11:00 besok = 19 jam = 1140 menit.
		expect(
			minutesUntilWindow({
				now: T({ hour: 16, minute: 0 }),
				start: T({ hour: 11, minute: 0 }),
				end: T({ hour: 15, minute: 0 }),
			}),
		).toBe(1140);
	});
});
