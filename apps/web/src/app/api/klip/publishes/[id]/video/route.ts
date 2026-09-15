import { readFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgPublishes } from "@/db";
import { dataRoot } from "@/klip/upload";

// URL publik agar server Meta bisa mengunduh mp4 untuk flow video_url.
// Diakses tanpa session (lihat middleware); id publish acak dan tak tertebak.
//
// RANGE REQUEST DIDUKUNG. Pengunduh berkas besar - termasuk milik Meta -
// memang memakai Range untuk mengambil sebagian-sebagian, dan endpoint yang
// selalu membalas 200 dengan seluruh isi bisa membuat pengunduhan gagal di
// tengah jalan untuk berkas besar.

/** Batas ukuran satu tanggapan Range agar tidak ada yang tak terbatas. */
const MAX_RANGE_BYTES = 5 * 1024 * 1024;

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	request: NextRequest,
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
	let buf: Buffer;
	try {
		buf = await readFile(path.join(dataRoot(), publish.videoPath));
	} catch {
		return NextResponse.json({ error: "File video tidak ditemukan" }, { status: 404 });
	}

	const total = buf.byteLength;
	const dasar = {
		"content-type": "video/mp4",
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=3600",
	};

	const range = request.headers.get("range");
	const cocok = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (cocok) {
		const mulai = cocok[1] ? Number(cocok[1]) : 0;
		const diminta = cocok[2] ? Number(cocok[2]) : total - 1;
		const akhir = Math.min(diminta, mulai + MAX_RANGE_BYTES - 1, total - 1);
		if (!Number.isFinite(mulai) || mulai >= total || mulai > akhir) {
			return new Response(null, {
				status: 416,
				headers: { ...dasar, "content-range": `bytes */${total}` },
			});
		}
		const potongan = buf.subarray(mulai, akhir + 1);
		return new Response(new Uint8Array(potongan), {
			status: 206,
			headers: {
				...dasar,
				"content-range": `bytes ${mulai}-${akhir}/${total}`,
				"content-length": String(potongan.byteLength),
			},
		});
	}

	return new Response(new Uint8Array(buf), { headers: dasar });
}
