import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	hapusSumberJob,
	semuaSudahTayang,
} from "@/klip/worker/source-cleanup";
import { BATCH_DIR } from "@/klip/batch-store";
import { RENDER_DIR } from "@/klip/worker/extract";

/**
 * Pembersihan sumber setelah klip tayang di Instagram.
 *
 * Yang diuji di sini hanya bagian filesystem dan keputusan murninya:
 * hapusZipBatchJikaTuntas() butuh database, dan keputusannya sudah dipisah ke
 * semuaSudahTayang() supaya tetap bisa diuji tanpa itu.
 *
 * Yang paling penting dikunci: renders/ TIDAK ikut terhapus. Pemiliknya
 * memutuskan menyimpannya, supaya "jalankan ulang" untuk klip yang sudah tayang
 * masih mungkin.
 */

let root = "";
const asli = process.env.KLIP_DATA_ROOT;

beforeAll(async () => {
	root = path.join(tmpdir(), `klip-cleanup-${Date.now()}`);
	await mkdir(root, { recursive: true });
	process.env.KLIP_DATA_ROOT = root;
});

afterAll(async () => {
	if (asli === undefined) delete process.env.KLIP_DATA_ROOT;
	else process.env.KLIP_DATA_ROOT = asli;
	await rm(root, { recursive: true, force: true });
});

/** Satu batch: dua berkas sumber, satu berkas render, satu ZIP. */
async function siapkanBatch(batchId: string, entryName: string) {
	const sumberDir = path.join(root, RENDER_DIR, batchId);
	await mkdir(sumberDir, { recursive: true });
	const sumber = path.join(sumberDir, `000_${entryName}`);
	await writeFile(sumber, "sumber");

	const renderDir = path.join(root, "renders");
	await mkdir(renderDir, { recursive: true });
	const render = path.join(renderDir, "j_abc.mp4");
	await writeFile(render, "render");

	const zipDir = path.join(root, BATCH_DIR);
	await mkdir(zipDir, { recursive: true });
	const zip = path.join(zipDir, `${batchId}.zip`);
	await writeFile(zip, "zip");

	return { sumber, render, zip };
}

async function ada(p: string): Promise<boolean> {
	return readdir(path.dirname(p))
		.then((n) => n.includes(path.basename(p)))
		.catch(() => false);
}

describe("hapusSumberJob", () => {
	test("menghapus berkas sumber milik satu job", async () => {
		const { sumber, render } = await siapkanBatch("b_hapus1", "clip_01_a.mp4");
		const dihapus = await hapusSumberJob({
			batchId: "b_hapus1",
			entryName: "clip_01_a.mp4",
		});
		expect(dihapus).toBe(sumber);
		expect(await ada(sumber)).toBe(false);
		expect(await ada(render)).toBe(true); // renders/ TIDAK disentuh
	});

	test("job lain di batch yang sama tidak ikut terhapus", async () => {
		const dir = path.join(root, RENDER_DIR, "b_hapus2");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "000_clip_01_a.mp4"), "a");
		await writeFile(path.join(dir, "001_clip_02_b.mp4"), "b");

		await hapusSumberJob({ batchId: "b_hapus2", entryName: "clip_01_a.mp4" });
		expect(await ada(path.join(dir, "000_clip_01_a.mp4"))).toBe(false);
		expect(await ada(path.join(dir, "001_clip_02_b.mp4"))).toBe(true);
	});

	// Kasus "entryName dipotong di 512 karakter" tidak bisa diuji di sini:
	// APFS dan ext4 membatasi nama berkas di 255 byte, jadi berkas sumbernya
	// sendiri tidak bisa dibuat. Logikanya tetap ada di cocok() karena
	// batch-service memang memotong di 512 - kalau berkas sepanjang itu
	// suatu saat mungkin, di situlah ia bekerja.

	test("batch atau nama yang tidak ada mengembalikan null, bukan melempar", async () => {
		expect(
			await hapusSumberJob({ batchId: "tidak-ada", entryName: "x.mp4" }),
		).toBeNull();
		expect(
			await hapusSumberJob({ batchId: "b_hapus1", entryName: "tidak-ada.mp4" }),
		).toBeNull();
	});
});

describe("semuaSudahTayang", () => {
	test("true hanya kalau semuanya sudah tayang", () => {
		expect(semuaSudahTayang(["published", "published"])).toBe(true);
		expect(semuaSudahTayang(["published", "queued"])).toBe(false);
		expect(semuaSudahTayang(["published", "failed"])).toBe(false);
	});

	test("yang dibatalkan ikut dihitung selesai", () => {
		// Job yang dibatalkan tidak akan pernah tayang; menunggunya berarti
		// ZIP-nya tidak pernah terhapus.
		expect(semuaSudahTayang(["published", "cancelled"])).toBe(true);
	});

	test("batch kosong TIDAK dianggap tuntas", () => {
		// Batch tanpa job tidak boleh menghapus ZIP apa pun - bisa jadi barisnya
		// sedang dibuat, dan ZIP-nya belum sempat dipakai.
		expect(semuaSudahTayang([])).toBe(false);
	});
});
