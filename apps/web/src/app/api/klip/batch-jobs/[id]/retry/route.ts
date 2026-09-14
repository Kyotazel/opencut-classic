import { type NextRequest, NextResponse } from "next/server";
import { retryJob } from "@/klip/batch-retry";

/**
 * POST /api/klip/batch-jobs/[id]/retry
 *
 * Jalankan ulang satu job dari percobaan pertama (attempts kembali 0),
 * tanpa menyentuh database secara manual.
 *
 * `?fresh=1` membuang hasil render supaya dirender ulang dari nol. Tanpa itu,
 * job yang sudah punya berkas render langsung masuk tahap publish - penting
 * karena render memakan ~17x durasi video di server.
 */
// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const fresh = new URL(request.url).searchParams.get("fresh") === "1";
	try {
		const result = await retryJob({ jobId: id, fresh });
		if (result.retried.length === 0) {
			return NextResponse.json(
				{ error: result.skipped[0]?.reason ?? "job tidak bisa diulang" },
				{ status: 400 },
			);
		}
		return NextResponse.json({ ok: true, retried: result.retried, fresh });
	} catch (error) {
		console.error(`POST /api/klip/batch-jobs/${id}/retry gagal`, error);
		return NextResponse.json({ error: "Gagal menjalankan ulang job" }, { status: 500 });
	}
}
