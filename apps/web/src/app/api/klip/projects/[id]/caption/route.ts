import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipProjects } from "@/db";
import { MAX_CAPTION_LENGTH } from "@/klip/ig-publish";

// eslint-disable-next-line opencut/prefer-object-params
export async function PATCH(
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
	const rec = typeof body === "object" && body !== null && !Array.isArray(body)
		? Object.fromEntries(Object.entries(body))
		: null;
	const caption = rec?.["caption"];
	if (typeof caption !== "string" || caption.length > MAX_CAPTION_LENGTH) {
		return NextResponse.json(
			{ error: `caption wajib string maksimal ${MAX_CAPTION_LENGTH} karakter` },
			{ status: 400 },
		);
	}
	const [project] = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.id, id))
		.limit(1);
	if (!project) {
		return NextResponse.json({ error: "Project tidak ditemukan" }, { status: 404 });
	}
	await db
		.update(klipProjects)
		.set({ caption, updatedAt: new Date() })
		.where(eq(klipProjects.id, id));
	return NextResponse.json({ ok: true, caption });
}
