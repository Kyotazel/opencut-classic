import { describe, expect, test } from "bun:test";

/**
 * Kontrak endpoint hapus batch.
 *
 * Tes ini SENGAJA tidak menyentuh database: rangkaian tes batch yang ada
 * memang sudah gagal karena koneksi DB di lingkungan tes, dan menambah tes
 * yang bergantung DB hanya akan menambah kegagalan palsu.
 *
 * Yang dijaga di sini adalah hal yang tidak bisa dilihat dari perilaku runtime:
 * bahwa handler-nya benar-benar diekspor dengan nama yang dicari Next.js.
 * Salah nama berarti tombol Hapus selalu 405, dan itu tidak ketahuan sampai
 * ada yang mengkliknya.
 */

describe("DELETE /api/klip/batches/[id]", () => {
	test("mengekspor handler DELETE", async () => {
		const mod = await import("@/app/api/klip/batches/[id]/route");
		expect(typeof mod.DELETE).toBe("function");
	});

	test("tidak mengekspor handler lain yang tidak diinginkan", async () => {
		// Di-cast ke Record supaya bisa MEMERIKSA KETIADAAN: TypeScript menolak
		// mengakses properti yang memang tidak ada di tipe modulnya, padahal
		// justru itu yang ingin dibuktikan di sini.
		const mod = (await import("@/app/api/klip/batches/[id]/route")) as Record<
			string,
			unknown
		>;
		// POST/PUT di sini akan mengejutkan: rute ini hanya untuk menghapus.
		expect(mod.POST).toBeUndefined();
		expect(mod.PUT).toBeUndefined();
		// GET sengaja tidak ada: detail batch dibaca lewat /api/klip/batches?id=
		expect(mod.GET).toBeUndefined();
	});
});
