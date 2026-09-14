import { describe, expect, test } from "bun:test";
import { resolveMime } from "@/app/api/sync/projects/[id]/media/route";

/**
 * MIME untuk berkas yang diunggah ke penyimpanan server.
 *
 * KENAPA INI ADA
 * file.type di sisi server bergantung pada klien. Pada unggahan dari editor,
 * File-nya dibaca ulang dari OPFS - yang hanya menyimpan ISI berkas, bukan
 * nama maupun tipe. Akibatnya server menerima nama berupa UUID tanpa ekstensi
 * dan tipe "application/octet-stream", lalu menyimpannya sebagai .bin.
 *
 * Editor memakai kolom mime itu sebagai header content-type, jadi berkas
 * seperti itu ditolak dan preview project jadi HITAM walaupun datanya benar.
 *
 * Perbaikannya: nama berkas (yang membawa ekstensi) jadi sumber utama.
 */

describe("resolveMime", () => {
	test("memakai tipe dari klien kalau dikenal", () => {
		expect(resolveMime({ reportedType: "video/mp4", fileName: "clip.mp4" })).toBe("video/mp4");
		expect(resolveMime({ reportedType: "image/png", fileName: "logo.png" })).toBe("image/png");
	});

	test("menyimpulkan dari ekstensi saat klien mengirim octet-stream", () => {
		// Kasus nyata yang membuat preview hitam.
		expect(
			resolveMime({
				reportedType: "application/octet-stream",
				fileName: "clip_06.mp4",
			}),
		).toBe("video/mp4");
	});

	test("menyimpulkan dari ekstensi saat tipe kosong", () => {
		expect(resolveMime({ reportedType: "", fileName: "a.mov" })).toBe("video/quicktime");
		expect(resolveMime({ reportedType: "", fileName: "a.webm" })).toBe("video/webm");
		expect(resolveMime({ reportedType: "", fileName: "a.mp3" })).toBe("audio/mpeg");
	});

	test("huruf besar pada ekstensi tetap dikenali", () => {
		expect(resolveMime({ reportedType: "", fileName: "CLIP.MP4" })).toBe("video/mp4");
	});

	test("tipe klien yang tidak dikenal jatuh ke ekstensi", () => {
		expect(resolveMime({ reportedType: "video/x-matroska", fileName: "a.mp4" })).toBe("video/mp4");
	});

	test("ekstensi tak dikenal mempertahankan tipe klien", () => {
		expect(resolveMime({ reportedType: "video/mp4", fileName: "tanpa-ekstensi" })).toBe("video/mp4");
	});

	test("tidak ada petunjuk sama sekali menjadi octet-stream", () => {
		expect(resolveMime({ reportedType: "", fileName: "uuid-tanpa-ekstensi" })).toBe(
			"application/octet-stream",
		);
	});
});
