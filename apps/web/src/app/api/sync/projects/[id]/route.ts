import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipSyncProjects } from "@/db";

const MAX_JSON_BYTES = 50 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const [row] = await db
		.select()
		.from(klipSyncProjects)
		.where(eq(klipSyncProjects.id, id))
		.limit(1);
	if (!row) {
		return NextResponse.json({ error: "Project tidak ada di server" }, { status: 404 });
	}
	return NextResponse.json({ id: row.id, name: row.name, data: row.data, updatedAt: row.updatedAt });
}

// eslint-disable-next-line opencut/prefer-object-params
export async function PUT(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!isRecord(body)) {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const name = body["name"];
	const data = body["data"];
	const baseUpdatedAt = body["baseUpdatedAt"];
	if (typeof name !== "string" || !name || typeof data !== "string") {
		return NextResponse.json({ error: "name dan data wajib string" }, { status: 400 });
	}
	if (data.length > MAX_JSON_BYTES) {
		return NextResponse.json({ error: "data project maksimal 50MB" }, { status: 413 });
	}
	try {
		JSON.parse(data);
	} catch {
		return NextResponse.json({ error: "data bukan JSON valid" }, { status: 400 });
	}
	if (baseUpdatedAt !== null && baseUpdatedAt !== undefined && typeof baseUpdatedAt !== "string") {
		return NextResponse.json({ error: "baseUpdatedAt wajib string/null" }, { status: 400 });
	}
	const [existing] = await db
		.select()
		.from(klipSyncProjects)
		.where(eq(klipSyncProjects.id, id))
		.limit(1);
	const now = new Date();
	if (!existing) {
		await db.insert(klipSyncProjects).values({ id, name: name.slice(0, 255), data });
		const [row] = await db
			.select()
			.from(klipSyncProjects)
			.where(eq(klipSyncProjects.id, id))
			.limit(1);
		return NextResponse.json({ updatedAt: row?.updatedAt ?? now });
	}
	if (typeof baseUpdatedAt === "string" && baseUpdatedAt) {
		const base = new Date(baseUpdatedAt).getTime();
		// Toleransi 2 detik: MySQL timestamp tanpa fractional second dibulatkan ke detik,
		// sehingga updatedAt yang baru ditulis bisa terlihat sedikit lebih baru dari base.
		if (Number.isFinite(base) && existing.updatedAt.getTime() - base > 2000) {
			return NextResponse.json({ serverUpdatedAt: existing.updatedAt }, { status: 409 });
		}
	}
	await db
		.update(klipSyncProjects)
		.set({ name: name.slice(0, 255), data, updatedAt: now })
		.where(eq(klipSyncProjects.id, id));
	return NextResponse.json({ updatedAt: now });
}
