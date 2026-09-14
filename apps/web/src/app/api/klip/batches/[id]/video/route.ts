import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, klipBatchJobs, klipBatches } from "@/db";
import { dataRoot } from "@/klip/upload";
import { RENDER_DIR } from "@/klip/worker/extract";

const MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
};

/**
 * GET /api/klip/batches/[id]/video?entry=<nama entri>
 *
 * Menyajikan berkas video hasil ekstraksi worker supaya Chromium (halaman
 * /internal/batch-job) bisa mengambilnya lewat HTTP. Path TIDAK diambil dari
 * query - selalu disusun dari batchId + entri yang terdaftar di database,
 * jadi tidak ada celah traversal.
 */
// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const entry = request.nextUrl.searchParams.get("entry");
	if (!entry) {
		return NextResponse.json({ error: "entry wajib" }, { status: 400 });
	}

	const rows = await db
		.select({ entryName: klipBatchJobs.entryName })
		.from(klipBatchJobs)
		.where(and(eq(klipBatchJobs.batchId, id), eq(klipBatchJobs.entryName, entry)))
		.limit(1);
	if (!rows[0]) {
		return NextResponse.json({ error: "entri tidak ada di batch ini" }, { status: 404 });
	}

	const batches = await db
		.select({ id: klipBatches.id })
		.from(klipBatches)
		.where(eq(klipBatches.id, id))
		.limit(1);
	if (!batches[0]) {
		return NextResponse.json({ error: "batch tidak ada" }, { status: 404 });
	}

	// Nama berkas di disk diberi prefiks urutan oleh extract.ts.
	const dir = path.join(dataRoot(), RENDER_DIR, id);
	let file: string | null = null;
	try {
		const names = await fs.readdir(dir);
		file = names.find((n) => n.endsWith(`_${entry}`)) ?? null;
	} catch {
		file = null;
	}
	if (!file) {
		return NextResponse.json(
			{ error: "berkas belum diekstrak" },
			{ status: 404 },
		);
	}

	const abs = path.join(dir, file);
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
			"content-type": MIME[path.extname(file).toLowerCase()] ?? "video/mp4",
			"cache-control": "private, max-age=3600",
		},
	});
}
