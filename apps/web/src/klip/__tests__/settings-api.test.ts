import { describe, expect, test } from "bun:test";

/**
 * Kontrak endpoint setelan.
 *
 * Tes ini sengaja TIDAK menyentuh database: rangkaian tes yang bergantung DB
 * di repo ini sudah gagal karena koneksi di lingkungan tes, dan menambah tes
 * serupa hanya menambah kegagalan palsu.
 *
 * Yang dijaga di sini adalah hal yang tidak terlihat dari perilaku runtime:
 * bahwa handler-nya diekspor dengan nama yang dicari Next.js. Salah nama
 * berarti halaman Setelan selalu 405 dan itu tidak ketahuan sampai diklik.
 */

describe("/api/klip/settings", () => {
	test("mengekspor GET dan POST", async () => {
		const mod = await import("@/app/api/klip/settings/route");
		expect(typeof mod.GET).toBe("function");
		expect(typeof mod.POST).toBe("function");
	});

	test("tidak mengekspor DELETE", async () => {
		// Cast ke Record supaya bisa memeriksa KETIADAAN properti - TypeScript
		// menolak mengaksesnya langsung karena memang tidak ada di tipe modul.
		const mod = (await import("@/app/api/klip/settings/route")) as Record<
			string,
			unknown
		>;
		// Setelan tidak dihapus, hanya diubah. DELETE di sini akan mengejutkan.
		expect(mod.DELETE).toBeUndefined();
	});
});
