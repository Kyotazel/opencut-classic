import { describe, expect, test } from "bun:test";
import { RATE_LIMIT_RETRY_DELAY_MS, rencanaSetelahGagal } from "@/klip/worker/loop";

/**
 * Jatah percobaan publish, terutama saat kena batas laju Instagram.
 *
 * Aturan lamanya: batas laju TIDAK menghabiskan jatah percobaan, dengan alasan
 * "batas laju bukan kegagalan job". Akibatnya job dicoba terus menerus tanpa
 * batas - berhari-hari kalau kuota Instagram sedang habis, diam-diam.
 *
 * Pemiliknya memutuskan sebaliknya: berhenti setelah 5x, biarkan error, dan
 * jalankan ulang manual kalau kuotanya sudah pulih. Tes ini mengunci itu.
 *
 * Murni - tidak ada Chromium, tidak ada Instagram, tidak ada database.
 */

const SEKARANG = new Date("2026-09-16T08:00:00Z");
const JEDA_LAJU = RATE_LIMIT_RETRY_DELAY_MS;

function rencana(attempts: number, kenaBatasLaju = false, jeda = JEDA_LAJU) {
	return rencanaSetelahGagal({
		attempts,
		maxAttempts: 5,
		kenaBatasLaju,
		jedaBatasLajuMs: jeda,
		now: SEKARANG,
	});
}

describe("jatah percobaan publish", () => {
	test("batas laju MENGHABISKAN jatah - ini yang berubah", () => {
		const hasil = rencana(0, true);
		expect(hasil.attempts).toBe(1);
		expect(hasil.retryAt).not.toBeNull();
	});

	test("batas laju berhenti di percobaan kelima", () => {
		const hasil = rencana(4, true);
		expect(hasil.attempts).toBe(5);
		expect(hasil.retryAt).toBeNull();
	});

	test("kegagalan biasa juga berhenti di percobaan kelima", () => {
		expect(rencana(4, false).retryAt).toBeNull();
		expect(rencana(3, false).retryAt).not.toBeNull();
	});

	test("jeda batas laju tetap lebih panjang daripada kegagalan biasa", () => {
		const laju = rencana(0, true, 60 * 60_000);
		const biasa = rencana(0, false);
		expect(laju.retryAt!.getTime() - SEKARANG.getTime()).toBe(60 * 60_000);
		expect(biasa.retryAt!.getTime()).toBeLessThan(laju.retryAt!.getTime());
	});

	test("perkiraan Meta dipakai apa adanya, bukan ditimpa satu jam", () => {
		const hasil = rencana(0, true, 30 * 60_000);
		expect(hasil.retryAt!.getTime() - SEKARANG.getTime()).toBe(30 * 60_000);
	});

	test("jatah tidak pernah mundur", () => {
		for (let n = 0; n < 5; n += 1) {
			expect(rencana(n, true).attempts).toBe(n + 1);
		}
	});
});
