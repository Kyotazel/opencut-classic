import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { sanitizeZipEntryName, MAX_BATCH_FILE_BYTES } from "@/klip/batch-upload";
import { dataRoot, probeVideo, ACCEPTED_VIDEO_EXTS } from "@/klip/upload";

/** Video hasil ekstraksi: sudah di disk dan sudah diukur. */
export type ExtractedVideo = {
	entryName: string;
	absPath: string;
	relPath: string;
	width: number | null;
	height: number | null;
	duration: number | null;
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
	return { videos, skipped };
}
