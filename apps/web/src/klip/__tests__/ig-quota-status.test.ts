import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db, klipSettings } from "@/db";
import {
	bacaStatusKuota,
	bersihkanStatusKuota,
	deskripsiPulih,
	simpanStatusKuota,
} from "@/klip/ig-quota-status";
import { SETTING_KEYS } from "@/klip/settings";

/**
 * Catatan kuota Instagram.
 *
 * Angka ini ditulis worker saat kena batas laju lalu ditampilkan di /batches,
 * supaya "kenapa belum terbit" bisa dijawab tanpa menggali log server.
 */
describe("deskripsi pulih", () => {
	const sekarang = Date.now();

	test("menit", () => {
		const status = {
			pemakaian: 95,
			pulihPada: new Date(sekarang + 45 * 60_000).toISOString(),
			pesan: "rate limit",
		};
		expect(deskripsiPulih({ status })).toBe("sekitar 45 menit lagi");
	});

	test("jam dan menit", () => {
		const status = {
			pemakaian: 95,
			pulihPada: new Date(sekarang + 125 * 60_000).toISOString(),
			pesan: null,
		};
		expect(deskripsiPulih({ status })).toBe("sekitar 2 jam 5 menit lagi");
	});

	test("tepat satu jam tidak menampilkan sisa menit", () => {
		const status = {
			pemakaian: null,
			pulihPada: new Date(sekarang + 60 * 60_000).toISOString(),
			pesan: null,
		};
		expect(deskripsiPulih({ status })).toBe("sekitar 1 jam lagi");
	});

	test("waktu yang sudah lewat tidak ditampilkan", () => {
		// Peringatan basi lebih menyesatkan daripada tidak ada peringatan.
		const status = {
			pemakaian: null,
			pulihPada: new Date(sekarang - 60_000).toISOString(),
			pesan: null,
		};
		expect(deskripsiPulih({ status })).toBeNull();
	});

	test("tanpa waktu pulih tidak menampilkan apa pun", () => {
		expect(deskripsiPulih({ status: { pemakaian: 50, pulihPada: null, pesan: null } })).toBeNull();
	});
});

describe("catatan kuota tersimpan", () => {
	afterAll(async () => {
		await db
			.delete(klipSettings)
			.where(inArray(klipSettings.key, [SETTING_KEYS.igQuotaStatus]))
			.catch(() => {});
	});

	test("disimpan lalu dibaca kembali", async () => {
		await simpanStatusKuota({
			status: {
				pemakaian: 93,
				pulihPada: "2026-09-16T00:00:00.000Z",
				pesan: "Application request limit reached",
			},
		});

		const dibaca = await bacaStatusKuota();
		expect(dibaca?.pemakaian).toBe(93);
		expect(dibaca?.pulihPada).toBe("2026-09-16T00:00:00.000Z");
		// Perhatikan: pesan asli Meta TIDAK memuat "rate limit" sama sekali -
		// itulah yang dulu membuatnya lolos dari pemeriksaan batas laju.
		expect(dibaca?.pesan).toContain("request limit reached");
	});

	test("dibersihkan berarti tidak ada catatan", async () => {
		await simpanStatusKuota({
			status: { pemakaian: 93, pulihPada: null, pesan: null },
		});
		await bersihkanStatusKuota();
		expect(await bacaStatusKuota()).toBeNull();
	});
});
