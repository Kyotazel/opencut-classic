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


/**
 * Ekstensi -> MIME. Dipakai sebagai CADANGAN saat multipart tidak membawa tipe.
 *
 * Kenapa perlu: `file.type` di sisi server bergantung pada klien, dan pada
 * beberapa jalur (mis. unggahan yang File-nya dibaca ulang dari penyimpanan
 * browser) tipe itu sampai sebagai string kosong. Akibatnya berkas tersimpan
 * sebagai "application/octet-stream" + ".bin", dan editor menolak memuatnya -
 * preview jadi hitam walaupun project-nya benar.
 *
 * Nama berkas justru lebih andal: ia selalu ikut terkirim, dan ekstensinya
 * menentukan cara browser mendekode.
 */
const EXT_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
};

/** Pakai tipe dari klien kalau dikenal; kalau tidak, simpulkan dari ekstensi. */
export function resolveMime({
	reportedType,
	fileName,
}: {
	reportedType: string;
	fileName: string;
}): string {
	// "application/octet-stream" dan string kosong berarti klien tidak tahu.
	if (
		reportedType &&
		reportedType !== "application/octet-stream" &&
		MIME_EXT[reportedType]
	) {
		return reportedType;
	}
	const ext = path.extname(fileName).toLowerCase();
	// "||", bukan "??": reportedType bisa string KOSONG (klien tidak tahu),
	// dan ?? tidak menangkap string kosong.
	return EXT_MIME[ext] || reportedType || "application/octet-stream";
}


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
	const mime = resolveMime({ reportedType: file.type, fileName: file.name });
	const ext = MIME_EXT[mime] ?? path.extname(file.name).toLowerCase();
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
