import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, klipSyncMedia, klipSyncProjects } from "@/db";
import { dataRoot } from "@/klip/upload";

export const SYNC_MEDIA_DIR = "sync-media";
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/quicktime": ".mov",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/mp4": ".m4a",
	"audio/ogg": ".ogg",
};

function assetPath({ projectId, assetId, ext }: { projectId: string; assetId: string; ext: string }): {
	abs: string;
	rel: string;
} {
	const rel = path.join(SYNC_MEDIA_DIR, projectId, `${assetId}${ext}`);
	return { abs: path.join(dataRoot(), rel), rel };
}

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const [project] = await db
		.select({ id: klipSyncProjects.id })
		.from(klipSyncProjects)
		.where(eq(klipSyncProjects.id, id))
		.limit(1);
	if (!project) {
		return NextResponse.json({ error: "Project tidak ada di server" }, { status: 404 });
	}
	const rows = await db
		.select()
		.from(klipSyncMedia)
		.where(eq(klipSyncMedia.projectId, id));
	return NextResponse.json({
		media: rows.map((r) => ({ id: r.id, mime: r.mime, size: r.size, updatedAt: r.updatedAt })),
	});
}

// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: projectId } = await params;
	const [project] = await db
		.select({ id: klipSyncProjects.id })
		.from(klipSyncProjects)
		.where(eq(klipSyncProjects.id, projectId))
		.limit(1);
	if (!project) {
		return NextResponse.json(
			{ error: "Project belum ada di server. Simpan project dulu." },
			{ status: 409 },
		);
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
	}
	const assetId = form.get("assetId");
	const file = form.get("file");
	if (typeof assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
		return NextResponse.json({ error: "assetId tidak valid" }, { status: 400 });
	}
	if (!(file instanceof File)) {
		return NextResponse.json({ error: "file wajib disertakan" }, { status: 400 });
	}
	if (file.size === 0) {
		return NextResponse.json({ error: "file kosong" }, { status: 400 });
	}
	if (file.size > MAX_MEDIA_BYTES) {
		return NextResponse.json({ error: "file maksimal 500MB" }, { status: 413 });
	}
	const mime = file.type || "application/octet-stream";
	const ext = MIME_EXT[mime] ?? ".bin";
	const { abs, rel } = assetPath({ projectId, assetId, ext });
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, Buffer.from(await file.arrayBuffer()));
	const [existing] = await db
		.select({ id: klipSyncMedia.id })
		.from(klipSyncMedia)
		.where(and(eq(klipSyncMedia.id, assetId), eq(klipSyncMedia.projectId, projectId)))
		.limit(1);
	if (existing) {
		await db
			.update(klipSyncMedia)
			.set({ filePath: rel, mime, size: file.size, updatedAt: new Date() })
			.where(eq(klipSyncMedia.id, assetId));
	} else {
		// id unik global; jika assetId dipakai project lain (praktis tidak terjadi karena id acak),
		// hapus row lama agar id tetap milik project terbaru.
		await db.delete(klipSyncMedia).where(eq(klipSyncMedia.id, assetId)).catch(() => {});
		await db.insert(klipSyncMedia).values({ id: assetId, projectId, filePath: rel, mime, size: file.size });
	}
	return NextResponse.json({ id: assetId, size: file.size }, { status: 201 });
}
