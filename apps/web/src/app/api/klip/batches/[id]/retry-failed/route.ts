import { type NextRequest, NextResponse } from "next/server";
import { retryFailedJobsInBatch } from "@/klip/batch-retry";

/**
 * POST /api/klip/batches/[id]/retry-failed
 *
 * Jalankan ulang SEMUA job gagal di satu batch. Tanpa ini, batch berisi
 * puluhan video gagal harus diklik satu per satu.
 */
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const fresh = new URL(request.url).searchParams.get("fresh") === "1";
	try {
		const result = await retryFailedJobsInBatch({ batchId: id, fresh });
		if (result.retried.length === 0) {
			return NextResponse.json(
				{ error: result.skipped[0]?.reason ?? "tidak ada job yang bisa diulang" },
				{ status: 400 },
			);
		}
		return NextResponse.json({ ok: true, retried: result.retried, fresh });
	} catch (error) {
		console.error(`POST /api/klip/batches/${id}/retry-failed gagal`, error);
		return NextResponse.json({ error: "Gagal menjalankan ulang job" }, { status: 500 });
	}
}
