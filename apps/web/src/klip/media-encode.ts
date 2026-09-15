import { execFile } from "node:child_process";
import { rename, stat, unlink } from "node:fs/promises";

/**
 * Pastikan MP4 hasil render memakai audio AAC.
 *
 * KENAPA INI ADA
 * Encoder AAC Chromium TIDAK tersedia di Chrome headless milik Playwright -
 * kodek itu memang tidak disertakan di build terbuka. Akibatnya
 * scene-exporter jatuh ke Opus, tetapi kontainernya tetap MP4, sehingga
 * menghasilkan MP4 ber-audio Opus: kombinasi non-standar.
 *
 * Dua video sempat terbit ke Instagram dengan kombinasi itu, lalu yang ketiga
 * ditolak dengan "Instagram gagal memproses video" tanpa keterangan. Meta
 * mensyaratkan AAC pada MP4, jadi lolosnya dua video itu keberuntungan - bukan
 * jaminan.
 *
 * Video TIDAK di-encode ulang (memakan waktu dan menurunkan mutu); hanya
 * audio yang ditranskode, jadi biayanya beberapa detik per video.
 */

export type HasilNormalisasi = {
	/** true kalau berkas benar-benar diubah. */
	diubah: boolean;
	/** Keterangan singkat untuk log. */
	keterangan: string;
};

/** Kodek audio berkas, atau null kalau tidak ada audio / tidak terbaca. */
async function kodekAudio({ absPath }: { absPath: string }): Promise<string | null> {
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				"ffprobe",
				[
					"-v",
					"quiet",
					"-select_streams",
					"a:0",
					"-show_entries",
					"stream=codec_name",
					"-of",
					"default=noprint_wrappers=1:nokey=1",
					absPath,
				],
				{ timeout: 20_000 },
				(error, out) => (error ? reject(error) : resolve(out)),
			);
		});
		const nama = stdout.trim().toLowerCase();
		return nama.length > 0 ? nama : null;
	} catch {
		return null;
	}
}

export async function pastikanAudioAac({
	absPath,
}: {
	absPath: string;
}): Promise<HasilNormalisasi> {
	const kodek = await kodekAudio({ absPath });
	if (kodek === null) return { diubah: false, keterangan: "tanpa audio" };
	if (kodek === "aac") return { diubah: false, keterangan: "sudah aac" };

	const sementara = `${absPath}.aac.mp4`;
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(
				"ffmpeg",
				[
					"-y",
					// WAJIB: tanpa -nostdin ffmpeg membaca stdin dan bisa menelan
					// input proses pemanggil. Sempat terjadi saat menguji lewat
					// skrip yang dikirim lewat stdin - sisa skripnya hilang.
					"-nostdin",
					"-v",
					"error",
					"-i",
					absPath,
					// Video disalin apa adanya: encode ulang hanya membuang waktu
					// dan menurunkan mutu tanpa manfaat.
					"-c:v",
					"copy",
					"-c:a",
					"aac",
					"-b:a",
					"192k",
					"-movflags",
					"+faststart",
					sementara,
				],
				{ timeout: 10 * 60_000 },
				(error) => (error ? reject(error) : resolve()),
			);
		});

		// Ukuran diperiksa sebelum menimpa: ffmpeg yang gagal separuh jalan bisa
		// meninggalkan berkas kecil, dan menimpanya berarti kehilangan hasil
		// render yang sudah memakan belasan menit.
		const hasil = await stat(sementara);
		const asli = await stat(absPath);
		if (hasil.size < asli.size * 0.5) {
			await unlink(sementara).catch(() => {});
			return {
				diubah: false,
				keterangan: `gagal: hasil transkode hanya ${hasil.size} byte`,
			};
		}

		await rename(sementara, absPath);
		return { diubah: true, keterangan: `${kodek} -> aac` };
	} catch (error) {
		await unlink(sementara).catch(() => {});
		const pesan = error instanceof Error ? error.message : String(error);
		// Tidak dilempar: berkas asli masih utuh dan masih bisa dipakai. Yang
		// penting kegagalannya terlihat di log, bukan menggagalkan job.
		return { diubah: false, keterangan: `gagal transkode: ${pesan.slice(0, 200)}` };
	}
}
