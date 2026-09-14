import yauzl from "yauzl";
import { newBatchId, saveVideoBuffer, UploadError } from "@/klip/upload";

/**
 * Batas aplikasi: sengaja longgar, tapi BUKAN batas sebenarnya di produksi
 * ber-tunnel.
 *
 * Kalau aplikasi diakses lewat Cloudflare Tunnel, Cloudflare memotong request
 * body di 100 MB dan membalas 413 dengan halaman HTML miliknya - browser tidak
 * menerima balasan yang bisa dibaca, jadi tombol unggah hanya berputar tanpa
 * pesan. Sudah diukur: 90 MB lolos, 105 MB ditolak dan baru ~1 MB terkirim.
 *
 * Jalan langsung lewat nginx tidak punya batas ini, jadi server produksi
 * (nginx, tanpa Cloudflare) tetap bisa memakai nilai di bawah.
 */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
/** Batas nyata lewat Cloudflare Tunnel. Pecah ZIP kalau lebih besar dari ini. */
export const CLOUDFLARE_MAX_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_BATCH_FILES = 100;
/** Batas per file sama dengan upload satuan (lihat route /api/uploads). */
export const MAX_BATCH_FILE_BYTES = 500 * 1024 * 1024;

export type BatchItemResult = {
	name: string;
	status: "ok" | "skipped" | "error";
	mediaId: string | null;
	url: string | null;
	width: number | null;
	height: number | null;
	duration: number | null;
	error: string | null;
};

export type BatchUploadResult = {
	batchId: string;
	total: number;
	succeeded: number;
	items: BatchItemResult[];
};

function okItem(
	name: string,
	saved: { mediaId: string; url: string; width: number | null; height: number | null; duration: number | null },
): BatchItemResult {
	return {
		name,
		status: "ok",
		mediaId: saved.mediaId,
		url: saved.url,
		width: saved.width,
		height: saved.height,
		duration: saved.duration,
		error: null,
	};
}

function failItem(name: string, status: "skipped" | "error", error: string): BatchItemResult {
	return {
		name,
		status,
		mediaId: null,
		url: null,
		width: null,
		height: null,
		duration: null,
		error,
	};
}

/** Guard zip-slip + file sampah: hanya nama relatif aman yang lolos. */
export function sanitizeZipEntryName({ fileName }: { fileName: string }): string | null {
	// yauzl selalu memakai / sebagai separator.
	const parts = fileName.split("/");
	const clean = parts.filter((p) => p !== "" && p !== "." && p !== "__MACOSX");
	if (clean.length === 0) return null;
	if (clean.some((p) => p === "..")) return null;
	const base = clean[clean.length - 1]!;
	if (base.startsWith("._") || base.startsWith(".")) return null;
	return base;
}

function openZip({ bytes }: { bytes: Buffer }): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: false }, (err, zip) => {
			if (err || !zip) reject(err ?? new Error("Cannot open zip"));
			else resolve(zip);
		});
	});
}

function readEntry({
	zip,
	entry,
}: {
	zip: yauzl.ZipFile;
	entry: yauzl.Entry;
}): Promise<Buffer> {
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

/**
 * Extract zip (buffer sudah di memori dari multipart) dan simpan tiap video
 * lewat jalur yang sama dengan upload satuan. Tidak pernah melempar untuk
 * kegagalan per-file; kegagalan dicatat di items.
 */
export async function saveZipBatch({
	bytes,
	filename,
}: {
	bytes: Buffer;
	filename: string;
}): Promise<BatchUploadResult> {
	const batchId = newBatchId();
	const items: BatchItemResult[] = [];
	let zip: yauzl.ZipFile;
	try {
		zip = await openZip({ bytes });
	} catch (error) {
		// yauzl menolak zip berisi entri ../ (zip-slip) sejak open.
		if (error instanceof Error && /invalid relative path/i.test(error.message)) {
			throw new UploadError(`"${filename}" contains unsafe file paths.`, 400);
		}
		throw new UploadError(`"${filename}" is not a valid zip file.`, 400);
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const fail = (error: unknown) => {
				// yauzl bisa menolak entri ../ secara async via event error.
				if (error instanceof Error && /invalid relative path/i.test(error.message)) {
					reject(new UploadError(`"${filename}" contains unsafe file paths.`, 400));
					return;
				}
				reject(error);
			};
			let count = 0;
			zip.on("error", fail);
			zip.on("end", () => resolve());
			zip.on("entry", (entry: yauzl.Entry) => {
				void (async () => {
					try {
						if (/\/$/.test(entry.fileName)) {
							zip.readEntry();
							return;
						}
						count += 1;
						if (count > MAX_BATCH_FILES) {
							items.push(failItem(entry.fileName, "skipped", `More than ${MAX_BATCH_FILES} files in zip`));
							zip.readEntry();
							return;
						}
						const name = sanitizeZipEntryName({ fileName: entry.fileName });
						if (!name) {
							items.push(failItem(entry.fileName, "skipped", "Unsafe or hidden path"));
							zip.readEntry();
							return;
						}
						if (entry.uncompressedSize > MAX_BATCH_FILE_BYTES) {
							items.push(failItem(name, "error", "File too large (max 500MB)"));
							zip.readEntry();
							return;
						}
						const data = await readEntry({ zip, entry });
						try {
							const saved = await saveVideoBuffer({ bytes: data, filename: name });
							items.push(okItem(name, saved));
						} catch (error) {
							if (error instanceof UploadError) {
								items.push(failItem(name, "skipped", error.message));
							} else {
								items.push(failItem(name, "error", "Save failed"));
							}
						}
						zip.readEntry();
					} catch (error) {
						fail(error);
					}
				})();
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
	const succeeded = items.filter((i) => i.status === "ok").length;
	return { batchId, total: items.length, succeeded, items };
}
