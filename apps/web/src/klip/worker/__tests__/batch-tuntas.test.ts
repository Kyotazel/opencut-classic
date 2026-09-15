import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";
import { batchMasihAdaKerja, daftarHasilBatch } from "@/klip/worker/loop";

/**
 * Uji kapan sebuah batch dianggap TUNTAS, dan apa isi ringkasannya.
 *
 * DUA hal yang dijaga di sini, keduanya pernah salah:
 *
 * 1. Ringkasan HARUS menunggu batch tuntas. Sebelumnya ia dikirim saat worker
 *    berhenti - dan worker produksi berjalan terus, jadi ringkasannya tidak
 *    pernah terkirim sama sekali.
 *
 * 2. Isinya dibaca dari DATABASE, bukan catatan sesi. Batch dua video yang
 *    dikerjakan lewat dua kali `worker:once` harus tetap menghasilkan satu
 *    ringkasan berisi DUA video, bukan dua ringkasan berisi satu.
 */
const BID = "b_ujituntas01";
const JID = ["j_ujituntas1", "j_ujituntas2"];

beforeAll(async () => {
	await bersihkan();
	await db.insert(klipBatches).values({
		id: BID,
		ownerUserId: "app:uji",
		zipPath: "batches/uji.zip",
		source: "api",
		total: 2,
	});
	await db.insert(klipBatchJobs).values([
		{
			id: JID[0]!,
			batchId: BID,
			entryName: "clip_01_a.mp4",
			status: "published",
			permalink: "https://instagram.com/reel/AAA",
		},
		{ id: JID[1]!, batchId: BID, entryName: "clip_02_b.mp4", status: "queued" },
	]);
});

async function bersihkan() {
	await db
		.delete(klipBatchJobs)
		.where(inArray(klipBatchJobs.id, JID))
		.catch(() => {});
	await db.delete(klipBatches).where(eq(klipBatches.id, BID)).catch(() => {});
}

afterAll(bersihkan);

describe("batchMasihAdaKerja", () => {
	test("true selama masih ada job yang belum tuntas", async () => {
		expect(await batchMasihAdaKerja({ batchId: BID })).toBe(true);
	});

	test("false setelah semua job tuntas", async () => {
		// Job kedua dibuat gagal; yang pertama sudah published.
		await db
			.update(klipBatchJobs)
			.set({ status: "failed", error: "video terlalu pendek" })
			.where(eq(klipBatchJobs.id, JID[1]!));
		expect(await batchMasihAdaKerja({ batchId: BID })).toBe(false);
	});
});

describe("daftarHasilBatch", () => {
	test("memuat SELURUH job batch, bukan hanya yang baru dikerjakan", async () => {
		// Inti perbaikannya: dibaca dari DB, jadi hasilnya utuh tidak peduli
		// berapa kali worker dijalankan untuk batch ini.
		const isi = await daftarHasilBatch({ batchId: BID });
		expect(isi.length).toBe(2);
		expect(isi.map((h) => h.nomor).sort()).toEqual([1, 2]);
	});

	test("memetakan status dengan benar", async () => {
		const isi = await daftarHasilBatch({ batchId: BID });
		expect(isi.find((h) => h.nomor === 1)?.status).toBe("published");
		expect(isi.find((h) => h.nomor === 2)?.status).toBe("failed");
	});

	test("menerjemahkan sebab kegagalan ke bahasa manusia", async () => {
		const isi = await daftarHasilBatch({ batchId: BID });
		expect(isi.find((h) => h.nomor === 2)?.alasan).toBe(
			"video terlalu pendek untuk Instagram Reels",
		);
	});
});
