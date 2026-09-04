import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgAccounts, klipIgPublishItems, klipIgPublishes } from "@/db";
import { IgPublishError, processItems } from "@/klip/ig-publish";

async function getPublish({ id }: { id: string }) {
	const [publish] = await db
		.select()
		.from(klipIgPublishes)
		.where(eq(klipIgPublishes.id, id))
		.limit(1);
	if (!publish) return null;
	const items = await db
		.select()
		.from(klipIgPublishItems)
		.where(eq(klipIgPublishItems.publishId, id));
	const accounts = await db.select().from(klipIgAccounts);
	const usernames = new Map(accounts.map((a) => [a.id, a.username]));
	return {
		publish: {
			id: publish.id,
			projectId: publish.projectId,
			caption: publish.caption,
			status: publish.status,
			createdAt: publish.createdAt,
		},
		items: items.map((i) => ({
			id: i.id,
			igAccountId: i.igAccountId,
			username: usernames.get(i.igAccountId) ?? null,
			status: i.status,
			permalink: i.permalink,
			error: i.error,
			attempts: i.attempts,
		})),
	};
}

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const data = await getPublish({ id });
	if (!data) {
		return NextResponse.json({ error: "Publish tidak ditemukan" }, { status: 404 });
	}
	return NextResponse.json(data);
}

// eslint-disable-next-line opencut/prefer-object-params
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	try {
		const data = await getPublish({ id });
		if (!data) {
			throw new IgPublishError({ message: "Publish tidak ditemukan", status: 404 });
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			throw new IgPublishError({ message: "Invalid JSON body" });
		}
		const rec = typeof body === "object" && body !== null && !Array.isArray(body)
			? Object.fromEntries(Object.entries(body))
			: null;
		const itemId = rec?.["itemId"];
		if (typeof itemId !== "string" || !itemId) {
			throw new IgPublishError({ message: "itemId wajib diisi" });
		}
		const item = data.items.find((i) => i.id === itemId);
		if (!item) {
			throw new IgPublishError({ message: "Item tidak ditemukan", status: 404 });
		}
		if (item.status !== "failed") {
			throw new IgPublishError({ message: "Hanya item gagal yang bisa di-retry", status: 409 });
		}
		const [account] = await db
			.select()
			.from(klipIgAccounts)
			.where(eq(klipIgAccounts.id, item.igAccountId))
			.limit(1);
		if (!account || account.status !== "active") {
			throw new IgPublishError({
				message: "Akun tidak aktif. Hubungkan ulang dulu.",
				status: 409,
			});
		}
		await db
			.update(klipIgPublishItems)
			.set({ status: "queued" })
			.where(eq(klipIgPublishItems.id, itemId));
		void processItems({ publishId: id, onlyItemIds: [itemId] }).catch((error: unknown) => {
			console.error(`retry ${itemId} gagal:`, error);
		});
		return NextResponse.json({ ok: true });
	} catch (error) {
		if (error instanceof IgPublishError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		console.error("retry publish gagal:", error);
		return NextResponse.json({ error: "Retry gagal" }, { status: 500 });
	}
}
