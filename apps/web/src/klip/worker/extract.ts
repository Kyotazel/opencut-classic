import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { sanitizeZipEntryName, MAX_BATCH_FILE_BYTES } from "@/klip/batch-upload";
import { dataRoot, probeVideo, ACCEPTED_VIDEO_EXTS } from "@/klip/upload";
import {
	type ClipCaption,
	captionForEntry,
	parseCaptions,
} from "@/klip/worker/captions";

/** Video hasil ekstraksi: sudah di disk dan sudah diukur. */
export type ExtractedVideo = {
	entryName: string;
	absPath: string;
	relPath: string;
	width: number | null;
	height: number | null;
	duration: number | null;
	/**
	 * Caption dari captions.json, kalau ada. null = pakai caption batch.
	 * Dipasangkan lewat nomor di nama file, bukan urutan - lihat captions.ts.
	 */
	caption: ClipCaption | null;
};

export type ExtractResult = {
	videos: ExtractedVideo[];
	skipped: Array<{ entryName: string; reason: string }>;
};

export const RENDER_DIR = "batch-source";

function openZip({ absPath }: { absPath: string }): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(absPath, { lazyEntries: true, strictFileNames: false }, (err, zip) => {
			if (err || !zip) reject(err ?? new Error("Cannot open zip"));
			else resolve(zip);
		});
	});
}

function readEntry({ zip, entry }: { zip: yauzl.ZipFile; entry: yauzl.Entry }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err || !stream) {
				reject(err ?? new Error("Cannot read entry"));
				return;
			}
			const chunks: Buffer[] = [];
			stream.on("data", (c: Buffer) => chunks.push(c));
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", reject);
		});
	});
}

function extOf(name: string): string {
	return path.extname(name).toLowerCase();
}

/**
 * Ekstrak video dari ZIP ke KLIP_DATA_ROOT/batch-source/<batchId>/ dan ukur
 * masing-masing dengan ffprobe.
 *
 * Guard nama entri memakai sanitizeZipEntryName yang SAMA dengan endpoint
 * upload, jadi zip-slip tetap tertutup. Entri non-video dilewati (dicatat),
 * bukan digagalkan - ZIP nyata biasanya berisi readme atau file lain.
 */
export async function extractVideosFromZip({
	zipAbsPath,
	batchId,
}: {
	zipAbsPath: string;
	batchId: string;
}): Promise<ExtractResult> {
	const zip = await openZip({ absPath: zipAbsPath });
	const outDir = path.join(dataRoot(), RENDER_DIR, batchId);
	// mkdir dipanggil sebelum menulis; kalau KLIP_DATA_ROOT belum ada sama sekali
	// (mis. instalasi baru), recursive membuat seluruh rantainya.
	await mkdir(outDir, { recursive: true });
	const videos: ExtractedVideo[] = [];
	const skipped: Array<{ entryName: string; reason: string }> = [];
	// Isi captions.json ditahan dulu, bukan dipakai langsung: yauzl membaca entri
	// satu per satu secara berurutan, dan captions.json bisa berada SETELAH
	// videonya di dalam ZIP. Kalau dipakai saat itu juga, caption akan kosong.
	let captionsRaw: string | null = null;

	try {
		await new Promise<void>((resolve, reject) => {
			zip.on("error", reject);
			zip.on("end", () => resolve());
			zip.on("entry", (entry: yauzl.Entry) => {
				void (async () => {
					try {
						if (/\/$/.test(entry.fileName)) {
							zip.readEntry();
							return;
						}
						const name = sanitizeZipEntryName({ fileName: entry.fileName });
						if (!name) {
							skipped.push({ entryName: entry.fileName, reason: "unsafe or hidden path" });
							zip.readEntry();
							return;
						}
						const ext = extOf(name);
						// captions.json BUKAN sampah: ia memuat caption per video.
						// Dicek sebelum filter ekstensi, karena .json pasti akan
						// ditolak sebagai "not a video".
						if (name.toLowerCase() === "captions.json") {
							if (entry.uncompressedSize <= MAX_BATCH_FILE_BYTES) {
								captionsRaw = (await readEntry({ zip, entry })).toString("utf8");
							}
							zip.readEntry();
							return;
						}
						if (!ACCEPTED_VIDEO_EXTS.has(ext)) {
							skipped.push({ entryName: name, reason: `not a video (${ext || "no ext"})` });
							zip.readEntry();
							return;
						}
						if (entry.uncompressedSize > MAX_BATCH_FILE_BYTES) {
							skipped.push({ entryName: name, reason: "file too large" });
							zip.readEntry();
							return;
						}
						const data = await readEntry({ zip, entry });
						const fileName = `${videos.length.toString().padStart(3, "0")}_${name}`;
						const absPath = path.join(outDir, fileName);
						await writeFile(absPath, data);
						const probed = await probeVideo(absPath);
						videos.push({
							entryName: name,
							absPath,
							relPath: path.join(RENDER_DIR, batchId, fileName),
							width: probed.width,
							height: probed.height,
							duration: probed.duration,
							// Dipasangkan setelah seluruh ZIP selesai dibaca.
							caption: null,
						});
						zip.readEntry();
					} catch (error) {
						reject(error);
					}
				})();
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}

	// Pemasangan caption dilakukan SETELAH seluruh ZIP terbaca: captions.json
	// bisa muncul setelah videonya, dan mencocokkan sambil jalan akan menghasilkan
	// caption kosong secara acak tergantung urutan entri di ZIP.
	if (captionsRaw) {
		const captions = parseCaptions(captionsRaw);
		for (const video of videos) {
			video.caption = captionForEntry(video.entryName, captions);
		}
	}

	return { videos, skipped };
}

/**
 * Caption untuk satu entri, tanpa mengekstrak video apa pun.
 *
 * Dipakai jalur RESUME: job yang sudah ter-render lalu dicoba ulang tidak
 * mengekstrak ulang (itu pemborosan), jadi caption tidak tersedia dari hasil
 * ekstraksi. Membaca hanya captions.json jauh lebih murah daripada mengekstrak
 * ulang seluruh ZIP yang bisa ratusan MB.
 *
 * Tidak pernah melempar: caption hilang jauh lebih ringan daripada job gagal
 * dan tidak pernah tayang.
 */
export async function captionFromZip({
	zipAbsPath,
	entryName,
}: {
	zipAbsPath: string;
	entryName: string;
}): Promise<string | null> {
	let zip: yauzl.ZipFile;
	try {
		zip = await openZip({ absPath: zipAbsPath });
	} catch {
		return null;
	}
	let raw: string | null = null;
	try {
		await new Promise<void>((resolve, reject) => {
			zip.on("error", reject);
			zip.on("end", () => resolve());
			zip.on("entry", (entry: yauzl.Entry) => {
				void (async () => {
					try {
						const name = sanitizeZipEntryName({ fileName: entry.fileName });
						if (name?.toLowerCase() === "captions.json") {
							if (entry.uncompressedSize <= MAX_BATCH_FILE_BYTES) {
								raw = (await readEntry({ zip, entry })).toString("utf8");
							}
							// Ketemu: tidak perlu membaca entri sisanya.
							zip.close();
							resolve();
							return;
						}
						zip.readEntry();
					} catch (error) {
						reject(error);
					}
				})();
			});
			zip.readEntry();
		});
	} catch {
		return null;
	} finally {
		try {
			zip.close();
		} catch {
			// Sudah tertutup di jalur "ketemu" di atas.
		}
	}
	if (!raw) return null;
	return captionForEntry(entryName, parseCaptions(raw))?.instagram ?? null;
}
