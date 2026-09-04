import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
	db,
	klipIgAccounts,
	klipIgPublishes,
	klipIgPublishItems,
	type KlipIgPublishItem,
} from "@/db";
import { generateUUID } from "@/utils/id";
import { dataRoot } from "@/klip/upload";
import { decryptToken } from "@/klip/ig-token";
import { publishReel } from "@/klip/ig-api";

export const PUBLISH_DIR = "publishes";
// Batas Reels menurut docs Meta: 300MB.
export const MAX_PUBLISH_BYTES = 300 * 1024 * 1024;
export const MAX_PUBLISH_ACCOUNTS = 10;
export const MAX_CAPTION_LENGTH = 2200;

export class IgPublishError extends Error {
	status: number;

	constructor({ message, status }: { message: string; status?: number }) {
		super(message);
		this.name = "IgPublishError";
		this.status = status ?? 400;
	}
}

export function newPublishId({ prefix }: { prefix: string }): string {
	return `${prefix}_${generateUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface ParsedPublishForm {
	projectId: string;
	caption: string;
	accountIds: string[];
	file: File;
}

export function parseAccountIds({ raw }: { raw: unknown }): string[] {
	if (typeof raw !== "string") {
		throw new IgPublishError({ message: "accountIds wajib JSON array string" });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new IgPublishError({ message: "accountIds bukan JSON valid" });
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		parsed.length > MAX_PUBLISH_ACCOUNTS ||
		!parsed.every((v): v is string => typeof v === "string" && v.length > 0)
	) {
		throw new IgPublishError({
			message: `accountIds wajib array 1-${MAX_PUBLISH_ACCOUNTS} id akun`,
		});
	}
	return [...new Set(parsed)];
}

export function validateCaption({ caption }: { caption: unknown }): string {
	if (typeof caption !== "string") {
		throw new IgPublishError({ message: "caption wajib string" });
	}
	if (caption.length > MAX_CAPTION_LENGTH) {
		throw new IgPublishError({
			message: `caption maksimal ${MAX_CAPTION_LENGTH} karakter`,
		});
	}
	return caption;
}

export function validateVideoFile({ file }: { file: unknown }): File {
	if (!(file instanceof File)) {
		throw new IgPublishError({ message: "file mp4 wajib disertakan" });
	}
	if (!file.name.toLowerCase().endsWith(".mp4")) {
		throw new IgPublishError({ message: "hanya file .mp4 yang didukung" });
	}
	if (file.size === 0) {
		throw new IgPublishError({ message: "file kosong" });
	}
	if (file.size > MAX_PUBLISH_BYTES) {
		throw new IgPublishError({ message: "file maksimal 300MB (batas Reels)", status: 413 });
	}
	return file;
}

export function publishVideoPath({ publishId }: { publishId: string }): {
	abs: string;
	rel: string;
} {
	const rel = path.join(PUBLISH_DIR, `${publishId}.mp4`);
	return { abs: path.join(dataRoot(), rel), rel };
}

export function publishVideoUrl({ publishId }: { publishId: string }): string | null {
	const base = (process.env.KLIP_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
	if (!base) return null;
	return `${base}/api/klip/publishes/${publishId}/video`;
}

export function aggregatePublishStatus({
	items,
}: {
	items: Pick<KlipIgPublishItem, "status">[];
}): "processing" | "done" | "partial" | "failed" {
	if (items.length === 0) return "failed";
	if (items.every((i) => i.status === "published")) return "done";
	if (items.some((i) => i.status === "failed") && items.every((i) => i.status === "published" || i.status === "failed")) {
		return items.some((i) => i.status === "published") ? "partial" : "failed";
	}
	return "processing";
}

type PublishFn = typeof publishReel;
let publishFn: PublishFn = publishReel;

/** @internal seam test */
export function __setPublishFn({ fn }: { fn: PublishFn }): void {
	publishFn = fn;
}

async function refreshPublishStatus({ publishId }: { publishId: string }): Promise<void> {
	const items = await db
		.select({ status: klipIgPublishItems.status })
		.from(klipIgPublishItems)
		.where(eq(klipIgPublishItems.publishId, publishId));
	await db
		.update(klipIgPublishes)
		.set({ status: aggregatePublishStatus({ items }), updatedAt: new Date() })
		.where(eq(klipIgPublishes.id, publishId));
}

export async function processItems({
	publishId,
	onlyItemIds,
}: {
	publishId: string;
	onlyItemIds?: string[];
}): Promise<void> {
	const publishRows = await db
		.select()
		.from(klipIgPublishes)
		.where(eq(klipIgPublishes.id, publishId))
		.limit(1);
	const publish = publishRows[0];
	if (!publish) return;
	const items = await db
		.select()
		.from(klipIgPublishItems)
		.where(eq(klipIgPublishItems.publishId, publishId));
	const targets = onlyItemIds
		? items.filter((i) => onlyItemIds.includes(i.id) && i.status === "failed")
		: items.filter((i) => i.status === "queued");
	let videoBytes: ArrayBuffer | null = null;
	for (const item of targets) {
		await db
			.update(klipIgPublishItems)
			.set({ status: "uploading", attempts: item.attempts + 1 })
			.where(eq(klipIgPublishItems.id, item.id));
		try {
			const [account] = await db
				.select()
				.from(klipIgAccounts)
				.where(eq(klipIgAccounts.id, item.igAccountId))
				.limit(1);
			if (!account || account.status !== "active") {
				throw new Error("Akun tidak aktif. Hubungkan ulang akun ini.");
			}
			if (!videoBytes) {
				const buf = await readFile(path.join(dataRoot(), publish.videoPath));
				videoBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			}
			const token = decryptToken(account.accessTokenEnc);
			const result = await publishFn({
				igUserId: account.igUserId,
				accessToken: token,
				caption: publish.caption ?? "",
				videoBytes,
				videoUrl: publishVideoUrl({ publishId }) ?? undefined,
				onStage: (stage) => {
					void db
						.update(klipIgPublishItems)
						.set({ status: stage === "published" ? "published" : stage === "upload" ? "uploading" : "processing" })
						.where(eq(klipIgPublishItems.id, item.id));
				},
			});
			await db
				.update(klipIgPublishItems)
				.set({ status: "published", permalink: result.permalink, error: null })
				.where(eq(klipIgPublishItems.id, item.id));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Publish gagal";
			if (message.startsWith("IG_TOKEN_INVALID")) {
				await db
					.update(klipIgAccounts)
					.set({ status: "token_expired", updatedAt: new Date() })
					.where(eq(klipIgAccounts.id, item.igAccountId));
			}
			await db
				.update(klipIgPublishItems)
				.set({ status: "failed", error: message.slice(0, 2000) })
				.where(eq(klipIgPublishItems.id, item.id));
		}
	}
	await refreshPublishStatus({ publishId });
}
