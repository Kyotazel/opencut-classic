import yauzl from "yauzl";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot, newBatchId, UploadError } from "@/klip/upload";
import { MAX_ZIP_BYTES, sanitizeZipEntryName } from "@/klip/batch-upload";

/** ZIP batch disimpan di disk, bukan di memori (T1-4). */
export const BATCH_DIR = "batches";
export const MAX_BATCH_ENTRIES = 100;

export { MAX_ZIP_BYTES };

export type ZipEntryInfo = { name: string; uncompressedSize: number };

export function newJobId(): string {
	return `j_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newBatchRowId(): string {
	return newBatchId();
}

export function batchZipPath({ batchId }: { batchId: string }): string {
	return path.join(BATCH_DIR, `${batchId}.zip`);
}

/** Simpan byte ZIP ke KLIP_DATA_ROOT/batches dan kembalikan path relatif. */
export async function saveBatchZip({
	batchId,
	bytes,
}: {
	batchId: string;
	bytes: Buffer;
}): Promise<string> {
	const rel = batchZipPath({ batchId });
	const abs = path.join(dataRoot(), rel);
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, bytes);
	return rel;
}

function openZipFromPath({ absPath }: { absPath: string }): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(absPath, { lazyEntries: true, strictFileNames: false }, (err, zip) => {
			if (err || !zip) reject(err ?? new Error("Cannot open zip"));
			else resolve(zip);
		});
	});
}

/**
 * Daftar entri video di dalam zip pada disk, memakai guard yang SAMA dengan
 * /api/uploads/batch (sanitizeZipEntryName), supaya jalur baru tidak
 * melonggarkan proteksi zip-slip yang sudah diuji.
 *
 * Hanya membaca daftar — tidak mengekstrak isi. Ekstraksi nyata terjadi di
 * worker (Tahap 2), yang memakai file zipPath ini.
 */
export async function listZipEntries({
	absPath,
}: {
	absPath: string;
}): Promise<ZipEntryInfo[]> {
	let zip: yauzl.ZipFile;
	try {
		zip = await openZipFromPath({ absPath });
	} catch (error) {
		if (error instanceof Error && /invalid relative path/i.test(error.message)) {
			throw new UploadError("Zip contains unsafe file paths.", 400);
		}
		throw new UploadError("Not a valid zip file.", 400);
	}
	const entries: ZipEntryInfo[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			const fail = (error: unknown) => {
				if (error instanceof Error && /invalid relative path/i.test(error.message)) {
					reject(new UploadError("Zip contains unsafe file paths.", 400));
					return;
				}
				reject(error);
			};
			zip.on("error", fail);
			zip.on("end", () => resolve());
			zip.on("entry", (entry: yauzl.Entry) => {
				// Direktori dan sampah (__MACOSX, .DS_Store) dilewati tanpa dicatat.
				if (/\/$/.test(entry.fileName)) {
					zip.readEntry();
					return;
				}
				const name = sanitizeZipEntryName({ fileName: entry.fileName });
				if (name) entries.push({ name, uncompressedSize: entry.uncompressedSize });
				zip.readEntry();
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
	if (entries.length === 0) {
		throw new UploadError("Zip has no usable entries.", 400);
	}
	if (entries.length > MAX_BATCH_ENTRIES) {
		throw new UploadError(`Zip has more than ${MAX_BATCH_ENTRIES} entries.`, 400);
	}
	return entries;
}
