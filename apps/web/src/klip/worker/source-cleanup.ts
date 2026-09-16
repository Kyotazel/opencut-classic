import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, klipBatchJobs } from "@/db";
import { BATCH_DIR } from "@/klip/batch-store";
import { dataRoot } from "@/klip/upload";
import { RENDER_DIR } from "@/klip/worker/extract";

/**
 * Buang berkas MASUKAN begitu klipnya tayang di Instagram.
 *
 * KENAPA: klip yang sudah tayang tidak membutuhkan berkas masukannya lagi - IG
 * sudah punya salinannya, dan yang disimpan di sini adalah hasil render. Tanpa
 * ini `batch-source/` dan `batches/` tumbuh tanpa batas; di server yang
 * produksi tiap hari, itu yang menghabiskan disk.
 *
 * APA YANG TIDAK DIHAPUS: `renders/`. Pemiliknya memutuskan begitu, supaya
 * "jalankan ulang" untuk klip yang sudah tayang masih mungkin.
 *
 * DUA TINGKAT, dan pembagiannya bukan pilihan gaya:
 *
 *   batch-source/<batchId>/<idx>_<nama>   per job   -> hapus begitu job tayang
 *   batches/<batchId>.zip                 per batch -> hapus HANYA kalau
 *                                                      seluruh job tuntas
 *
 * ZIP dipakai bersama semua job dalam satu batch. Menghapusnya saat satu job
 * tayang akan membuat job lain kehilangan sumbernya saat resume.
 *
 * Tidak satu pun fungsi di sini melempar. Berkas yang gagal dihapus jauh lebih
 * ringan daripada publish yang gagal gara-gara pembersihan.
 */

/** Nama berkas di batch-source diberi awalan nomor urut: "000_<nama>". */
function lepasIndeks(nama: string): string {
	return nama.replace(/^\d+_/, "");
}

function cocok(nama: string, entryName: string): boolean {
	const tanpaIndeks = lepasIndeks(nama);
	if (tanpaIndeks === entryName) return true;
	// batch-service memotong entryName di 512 karakter, jadi nama yang sangat
	// panjang tersimpan terpotong. Bandingkan sepanjang yang tersimpan saja.
	return entryName.length >= 512 && tanpaIndeks.startsWith(entryName);
}

/**
 * Hapus berkas sumber milik SATU job hasil ekstraksi ZIP.
 *
 * Mengembalikan path yang dihapus, atau null kalau tidak ada yang cocok -
 * termasuk kalau job ini memang tidak pernah diekstrak (mis. alur resume yang
 * melewati ekstraksi). Keduanya bukan kesalahan.
 */
export async function hapusSumberJob({
	batchId,
	entryName,
}: {
	batchId: string;
	entryName: string;
}): Promise<string | null> {
	try {
		const dir = path.join(dataRoot(), RENDER_DIR, batchId);
		const nama = await readdir(dir).catch(() => [] as string[]);
		const target = nama.find((n) => cocok(n, entryName));
		if (!target) return null;
		const abs = path.join(dir, target);
		await rm(abs, { force: true });
		return abs;
	} catch {
		return null;
	}
}

/**
 * True kalau tidak ada lagi job yang menunggu di batch ini.
 *
 * Murni supaya bisa dites tanpa database. "cancelled" ikut dihitung
 * selesai: job yang dibatalkan tidak akan pernah tayang, dan menunggunya
 * berarti ZIP-nya tidak pernah terhapus.
 */
export function semuaSudahTayang(statuses: string[]): boolean {
	return (
		statuses.length > 0 &&
		statuses.every((s) => s === "published" || s === "cancelled")
	);
}

/**
 * Hapus ZIP batch kalau TIDAK ADA lagi job yang belum tayang.
 *
 * Sengaja memeriksa seluruh baris job, bukan sekadar "job terakhir yang
 * selesai": keputusan yang bergantung pada urutan pemanggilan akan salah
 * begitu ada job yang dijalankan ulang.
 *
 * ZIP dipakai bersama semua job, jadi menghapusnya terlalu awal membuat
 * job yang belum selesai kehilangan sumbernya saat resume.
 */
export async function hapusZipBatchJikaTuntas({
	batchId,
}: {
	batchId: string;
}): Promise<string | null> {
	try {
		const semua = await db
			.select({ status: klipBatchJobs.status })
			.from(klipBatchJobs)
			.where(eq(klipBatchJobs.batchId, batchId))
			.limit(500);
		if (!semuaSudahTayang(semua.map((j) => j.status))) return null;
		const zip = path.join(dataRoot(), BATCH_DIR, `${batchId}.zip`);
		await rm(zip, { force: true });
		return zip;
	} catch {
		return null;
	}
}
