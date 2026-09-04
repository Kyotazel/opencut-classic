import { unlink } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { createReadStream, promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { db, klipSyncMedia } from "@/db";
import { dataRoot } from "@/klip/upload";

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId } = await params;
	const [row] = await db
		.select()
		.from(klipSyncMedia)
		.where(eq(klipSyncMedia.id, assetId))
		.limit(1);
	if (!row) {
		return NextResponse.json({ error: "Media tidak ditemukan" }, { status: 404 });
	}
	const abs = path.join(dataRoot(), row.filePath);
	try {
		await fs.access(abs);
	} catch {
		await db.delete(klipSyncMedia).where(eq(klipSyncMedia.id, assetId)).catch(() => {});
		return NextResponse.json({ error: "File hilang di server" }, { status: 404 });
	}
	const stream = createReadStream(abs);
	const body = new ReadableStream({
		start(controller) {
			stream.on("data", (chunk: Buffer | string) => {
				controller.enqueue(
					typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
				);
			});
			stream.on("end", () => controller.close());
			stream.on("error", (e) => controller.error(e));
		},
		cancel() {
			stream.destroy();
		},
	});
	return new NextResponse(body, {
		headers: {
			"content-type": row.mime,
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
}

// eslint-disable-next-line opencut/prefer-object-params
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId } = await params;
	const [row] = await db
		.select()
		.from(klipSyncMedia)
		.where(eq(klipSyncMedia.id, assetId))
		.limit(1);
	if (row) {
		await unlink(path.join(dataRoot(), row.filePath)).catch(() => {});
		await db.delete(klipSyncMedia).where(eq(klipSyncMedia.id, assetId));
	}
	return NextResponse.json({ ok: true });
}
