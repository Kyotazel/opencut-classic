import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { db, klipMedia } from "@/db";
import { BRAND_DIR, classifyBrandUpload, newBrandId } from "@/klip/brand";
import {
	dataRoot,
	newMediaId,
	probeVideo,
	toPortablePath,
} from "@/klip/upload";

const MAX_BRAND_BYTES = 200 * 1024 * 1024;

export async function POST(request: NextRequest) {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return NextResponse.json({ error: "file is required" }, { status: 400 });
	}
	if (file.size === 0) {
		return NextResponse.json({ error: "file is empty" }, { status: 400 });
	}
	if (file.size > MAX_BRAND_BYTES) {
		return NextResponse.json({ error: "file too large" }, { status: 413 });
	}
	const kind = classifyBrandUpload({ filename: file.name });
	if (!kind) {
		return NextResponse.json(
			{
				error:
					"Unsupported file type. Use png, jpg, jpeg, webp, mp4, webm, mov, mp3, wav, m4a, or ogg.",
			},
			{ status: 400 },
		);
	}

	const mediaId = newMediaId();
	const ext = path.extname(file.name).toLowerCase();
	const root = dataRoot();
	await mkdir(path.join(root, BRAND_DIR), { recursive: true });
	const relPath = path.join(BRAND_DIR, `${mediaId}${ext}`);
	const absPath = path.join(root, relPath);
	await writeFile(absPath, Buffer.from(await file.arrayBuffer()));

	let width: number | null = null;
	let height: number | null = null;
	let duration: number | null = null;
	if (kind === "video") {
		const probed = await probeVideo(absPath);
		width = probed.width;
		height = probed.height;
		duration = probed.duration;
	}
	// Images: try ffprobe too (works for stills); audio duration via ffprobe format.
	if (kind === "image" || kind === "audio") {
		const probed = await probeVideo(absPath);
		width = probed.width;
		height = probed.height;
		duration = probed.duration;
	}

	try {
		await db.insert(klipMedia).values({
			id: mediaId,
			kind: "brand",
			assetKind: kind,
			name: file.name.slice(0, 255),
			filePath: toPortablePath(absPath),
			width,
			height,
			duration,
			thumbnailPath: null,
		});
	} catch (error) {
		const { unlink } = await import("node:fs/promises");
		await unlink(absPath).catch(() => {});
		throw error;
	}

	return NextResponse.json(
		{
			mediaId,
			url: `/api/media/${mediaId}`,
			kind,
			width,
			height,
			duration,
		},
		{ status: 201 },
	);
}
