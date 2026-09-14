import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipBatchJobs } from "@/db";
import { dataRoot } from "@/klip/upload";

/**
 * GET /api/klip/batch-jobs/[id]/video
 *
 * Menyajikan berkas MP4 hasil render untuk job ini. Dipakai tombol Download
 * di halaman /batches. Path diambil dari database (rendered_path), bukan dari
 * query, jadi tidak ada celah traversal.
 *
 * content-disposition: attachment dipakai supaya browser mengunduh berkasnya,
 * bukan membukanya di tab. Nama unduhan memakai nama video asli.
 */
// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const rows = await db
		.select({ renderedPath: klipBatchJobs.renderedPath, entryName: klipBatchJobs.entryName })
		.from(klipBatchJobs)
		.where(eq(klipBatchJobs.id, id))
		.limit(1);
	const job = rows[0];
	if (!job) {
		return NextResponse.json({ error: "job tidak ada" }, { status: 404 });
	}
	if (!job.renderedPath) {
		return NextResponse.json(
			{ error: "belum ada hasil render untuk job ini" },
			{ status: 404 },
		);
	}

	const abs = path.join(dataRoot(), job.renderedPath);
	let stat;
	try {
		stat = await fs.stat(abs);
	} catch {
		return NextResponse.json(
			{ error: "berkas hasil render hilang di server" },
			{ status: 404 },
		);
	}

	// Nama unduhan memakai nama video asli supaya mudah dikenali.
	const base = job.entryName.replace(/\.[^.]+$/, "") || "render";
	const fileName = `${base}.mp4`;
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
			"content-type": "video/mp4",
			"content-length": String(stat.size),
			"content-disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
			"cache-control": "private, max-age=3600",
		},
	});
}
