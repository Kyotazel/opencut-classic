import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, klipIgAccounts, klipIgPublishItems, klipIgPublishes } from "@/db";
import { processItems } from "@/klip/ig-publish";

export type PublishOutcome =
	| { kind: "published"; permalink: string | null }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; error: string };

/**
 * Kirim video hasil render ke Instagram.
 *
 * Memakai jalur publish yang SUDAH ada (klip/ig-publish.ts): IG menerima
 * bytes langsung lewat resumable upload, jadi berkas lokal di server cukup -
 * URL publik hanya dipakai sebagai cadangan kalau IG menolak.
 *
 * videoPath diarahkan ke berkas render (bukan disalin ke publishes/) supaya
 * tidak ada duplikasi berkas 20-50 MB per video.
 */
export async function publishRenderedVideo({
	projectId,
	renderedPath,
	caption,
	igAccountId,
}: {
	/** klip_projects.id milik job ini. Wajib: kolomnya foreign key NOT NULL. */
	projectId: string;
	renderedPath: string;
	caption: string | null;
	igAccountId: string;
}): Promise<PublishOutcome> {
	const accounts = await db
		.select()
		.from(klipIgAccounts)
		.where(eq(klipIgAccounts.id, igAccountId))
		.limit(1);
	const account = accounts[0];
	if (!account) {
		return { kind: "skipped", reason: `akun IG ${igAccountId} tidak ada` };
	}
	if (account.status !== "active") {
		return {
			kind: "skipped",
			reason: `akun IG ${account.username} berstatus ${account.status} - hubungkan ulang`,
		};
	}

	const publishId = `p_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	await db.insert(klipIgPublishes).values({
		id: publishId,
		projectId,
		caption,
		videoPath: renderedPath,
		status: "processing",
	});
	const itemId = `pi_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	await db.insert(klipIgPublishItems).values({
		id: itemId,
		publishId,
		igAccountId,
		status: "queued",
		attempts: 0,
	});

	// processItems menangani upload -> poll -> publish, dan mencatat error per
	// item. Kegagalan TIDAK dilempar; statusnya dibaca dari baris item.
	await processItems({ publishId });

	const items = await db
		.select()
		.from(klipIgPublishItems)
		.where(and(eq(klipIgPublishItems.publishId, publishId), eq(klipIgPublishItems.id, itemId)))
		.limit(1);
	const item = items[0];
	if (!item) return { kind: "failed", error: "item publish hilang" };

	if (item.status === "published") {
		await db
			.update(klipIgPublishes)
			.set({ status: "done", updatedAt: new Date() })
			.where(eq(klipIgPublishes.id, publishId));
		return { kind: "published", permalink: item.permalink };
	}

	await db
		.update(klipIgPublishes)
		.set({ status: "failed", updatedAt: new Date() })
		.where(eq(klipIgPublishes.id, publishId));
	return { kind: "failed", error: item.error ?? `status ${item.status}` };
}

/**
 * Apakah kegagalan ini karena batas laju Instagram, bukan karena konten?
 *
 * Penting untuk circuit breaker: rate limit TIDAK boleh dihitung sebagai
 * kegagalan konten, karena itu bukan tanda template atau video salah - hanya
 * perlu ditunggu. Kalau dihitung, batch sehat akan berhenti sia-sia.
 */
export function isRateLimitError({ message }: { message: string }): boolean {
	const m = message.toLowerCase();
	return (
		// Meta memakai kalimat yang TIDAK memuat "rate limit" sama sekali.
		// Sebelum ini "Application request limit reached" tidak dikenali,
		// sehingga batas laju dihitung sebagai kegagalan konten: circuit breaker
		// ikut menghitungnya, dan job diulang cepat sehingga kuota makin habis.
		m.includes("application request limit reached") ||
		m.includes("request limit reached") ||
		m.includes("rate limit") ||
		m.includes("too many") ||
		m.includes("429") ||
		m.includes("temporarily blocked") ||
		m.includes("user cap") ||
		m.includes("api call limit") ||
		m.includes("spam") ||
		// Kode kesalahan Meta untuk batas laju: 4 = batas aplikasi,
		// 17 = batas pengguna, 32 = batas halaman, 613 = batas panggilan API.
		/"code"\s*:\s*(4|17|32|613)\b/.test(m)
	);
}
