import { readFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgPublishes } from "@/db";
import { dataRoot } from "@/klip/upload";

// URL publik agar server Meta bisa mengunduh mp4 untuk flow video_url.
// Diakses tanpa session (lihat middleware); id publish acak dan tak tertebak.

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const [publish] = await db
		.select()
		.from(klipIgPublishes)
		.where(eq(klipIgPublishes.id, id))
		.limit(1);
	if (!publish) {
		return NextResponse.json({ error: "Publish tidak ditemukan" }, { status: 404 });
	}
	try {
		const buf = await readFile(path.join(dataRoot(), publish.videoPath));
		const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return new Response(bytes, {
			headers: {
				"content-type": "video/mp4",
				"cache-control": "private, max-age=3600",
			},
		});
	} catch {
		return NextResponse.json({ error: "File video tidak ditemukan" }, { status: 404 });
	}
}
