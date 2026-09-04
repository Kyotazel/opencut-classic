import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, klipMedia } from "@/db";
import { generateUUID } from "@/utils/id";

export const UPLOAD_DIR = "uploads";
export const ACCEPTED_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);

const EXT_CONTENT_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
};

export type ProbedVideo = {
	width: number | null;
	height: number | null;
	duration: number | null;
};

export type SaveUploadResult = ProbedVideo & {
	mediaId: string;
	url: string;
	thumbnailUrl: null;
};

export class UploadError extends Error {
	status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "UploadError";
		this.status = status;
	}
}

export function newMediaId(): string {
	return `m_${generateUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newBatchId(): string {
	return `b_${generateUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function dataRoot(): string {
	return process.env.KLIP_DATA_ROOT ?? path.join(process.cwd(), ".klip-data");
}

export function toPortablePath(absPath: string): string {
	return path.relative(dataRoot(), absPath);
}

function extOf(filename: string): string {
	return path.extname(filename).toLowerCase();
}

export function contentTypeForExt(ext: string): string {
	return EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function runFfprobe(filePath: string): Promise<ProbedVideo | null> {
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				"ffprobe",
				[
					"-v",
					"quiet",
					"-print_format",
					"json",
					"-show_format",
					"-show_streams",
					filePath,
				],
				{ timeout: 15_000 },
				(error, out) => (error ? reject(error) : resolve(out)),
			);
		});
		const parsed = JSON.parse(stdout) as {
			streams?: Array<{
				codec_type?: string;
				width?: number;
				height?: number;
				duration?: string;
			}>;
			format?: { duration?: string };
		};
		const streams = parsed.streams ?? [];
		const video =
			streams.find((s) => s.codec_type === "video") ?? streams[0];
		const width = Number(video?.width);
		const height = Number(video?.height);
		const duration = Number(parsed.format?.duration ?? video?.duration);
		return {
			width: Number.isFinite(width) ? width : null,
			height: Number.isFinite(height) ? height : null,
			duration: Number.isFinite(duration) ? duration : null,
		};
	} catch {
		// ffprobe missing or file unreadable: caller stores NULL dims.
		return null;
	}
}

/**
 * Probe width/height/duration via ffprobe. mediabunny's readVideoFile is
 * browser-only (BlobSource) and must never be imported server-side.
 * Returns NULLs when ffprobe is unavailable or the file can't be parsed.
 */
export async function probeVideo(filePath: string): Promise<ProbedVideo> {
	return (
		(await runFfprobe(filePath)) ?? {
			width: null,
			height: null,
			duration: null,
		}
	);
}

export async function saveUpload({
	file,
}: {
	file: File;
}): Promise<SaveUploadResult> {
	return saveVideoBuffer({
		bytes: Buffer.from(await file.arrayBuffer()),
		filename: file.name,
	});
}

/** Inti penyimpanan video dipakai upload satuan maupun hasil extract zip. */
export async function saveVideoBuffer({
	bytes,
	filename,
}: {
	bytes: Buffer;
	filename: string;
}): Promise<SaveUploadResult> {
	const ext = extOf(filename);
	if (!ACCEPTED_VIDEO_EXTS.has(ext)) {
		throw new UploadError(
			`Unsupported file type "${ext || filename}". Only mp4, webm, and mov are accepted.`,
			400,
		);
	}

	const mediaId = newMediaId();
	const root = dataRoot();
	await mkdir(path.join(root, UPLOAD_DIR), { recursive: true });
	const relPath = path.join(UPLOAD_DIR, `${mediaId}${ext}`);
	const absPath = path.join(root, relPath);
	await writeFile(absPath, bytes);

	const probed = await probeVideo(absPath);
	try {
		await db.insert(klipMedia).values({
			id: mediaId,
			kind: "source",
			assetKind: "video",
			name: filename.slice(0, 255),
			filePath: relPath,
			width: probed.width,
			height: probed.height,
			duration: probed.duration,
			thumbnailPath: null,
		});
	} catch (error) {
		await unlink(absPath).catch(() => {});
		throw error;
	}

	return {
		mediaId,
		url: `/api/media/${mediaId}`,
		width: probed.width,
		height: probed.height,
		duration: probed.duration,
		thumbnailUrl: null,
	};
}

export type ResolvedMediaFile = {
	absPath: string;
	contentType: string;
	fileName: string;
};

/** Resolve a media id to its file on disk. Returns null when unknown or unsafe. */
export async function resolveMediaFile(
	mediaId: string,
): Promise<ResolvedMediaFile | null> {
	const rows = await db
		.select()
		.from(klipMedia)
		.where(eq(klipMedia.id, mediaId))
		.limit(1);
	const row = rows[0];
	if (!row) {
		return null;
	}
	const root = path.resolve(dataRoot());
	const absPath = path.resolve(root, row.filePath);
	if (absPath !== root && !absPath.startsWith(root + path.sep)) {
		return null;
	}
	return {
		absPath,
		contentType: contentTypeForExt(extOf(row.filePath)),
		fileName: row.name,
	};
}
