import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db, klipBrandLayers, klipProjects } from "@/db";
import { listLayers, newBrandId, rowToLayer } from "@/klip/brand";

async function getProject({ id }: { id: string }) {
	const rows = await db
		.select()
		.from(klipProjects)
		.where(eq(klipProjects.id, id))
		.limit(1);
	return rows[0] ?? null;
}

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const project = await getProject({ id });
	if (!project) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	return NextResponse.json({
		project,
		layers: await listLayers({ projectId: id }),
	});
}

const PATCH_FIELDS = new Set([
	"enabled",
	"x",
	"y",
	"scale",
	"rotate",
	"opacity",
	"full",
	"start",
	"dur",
	"volume",
	"duck",
	"z",
	"name",
]);

function sanitizePatch({ body }: { body: Record<string, unknown> }) {
	const patch: Record<string, unknown> = {};
	for (const key of PATCH_FIELDS) {
		if (body[key] !== undefined) {
			patch[key] = body[key];
		}
	}
	if (typeof patch.opacity === "number") {
		patch.opacity = Math.round(Math.min(Math.max(patch.opacity, 0), 100));
	}
	if (typeof patch.scale === "number") {
		patch.scale = Math.max(patch.scale, 0.01);
	}
	if (typeof patch.volume === "number") {
		patch.volume = Math.max(patch.volume, 0);
	}
	if (typeof patch.rotate === "number") {
		patch.rotate = Math.min(Math.max(patch.rotate, -360), 360);
	}
	return patch;
}

export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const project = await getProject({ id });
	if (!project) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const layerId =
		typeof (body as Record<string, unknown>)?.id === "string"
			? ((body as Record<string, unknown>).id as string)
			: null;
	if (!layerId) {
		return NextResponse.json({ error: "id is required" }, { status: 400 });
	}
	const patch = sanitizePatch({ body: body as Record<string, unknown> });
	if (Object.keys(patch).length === 0) {
		return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
	}
	const existing = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.id, layerId))
		.limit(1);
	const row = existing[0];
	if (!row || row.projectId !== id) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	await db.update(klipBrandLayers).set(patch).where(eq(klipBrandLayers.id, layerId));
	const updated = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.id, layerId))
		.limit(1);
	return NextResponse.json({ layer: rowToLayer({ row: updated[0]! }) });
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const project = await getProject({ id });
	if (!project) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const b = body as Record<string, unknown>;
	const kind = b.kind;
	if (kind !== "image" && kind !== "video" && kind !== "audio") {
		return NextResponse.json({ error: "kind must be image, video, or audio" }, { status: 400 });
	}
	if (typeof b.file !== "string" || b.file.length === 0) {
		return NextResponse.json({ error: "file is required" }, { status: 400 });
	}
	const siblings = await listLayers({ projectId: id });
	const maxZ = siblings.reduce((m, l) => Math.max(m, l.z), -1);
	const layerId = newBrandId({ prefix: "lyr" });
	await db.insert(klipBrandLayers).values({
		id: layerId,
		projectId: id,
		assetId: typeof b.assetId === "string" ? b.assetId : null,
		filePath: b.file,
		name: typeof b.name === "string" && b.name.length > 0 ? b.name.slice(0, 255) : "Brand layer",
		kind,
		enabled: true,
		x: typeof b.x === "number" ? b.x : 0.06,
		y: typeof b.y === "number" ? b.y : 0.05,
		scale: typeof b.scale === "number" ? Math.max(b.scale, 0.01) : 0.36,
		rotate: 0,
		opacity: 100,
		full: true,
		start: 0,
		dur: 0,
		volume: 0.35,
		duck: false,
		z: maxZ + 1,
	});
	const rows = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.id, layerId))
		.limit(1);
	return NextResponse.json({ layer: rowToLayer({ row: rows[0]! }) }, { status: 201 });
}

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const project = await getProject({ id });
	if (!project) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const layerId = new URL(request.url).searchParams.get("layerId");
	if (!layerId) {
		return NextResponse.json({ error: "layerId is required" }, { status: 400 });
	}
	const existing = await db
		.select()
		.from(klipBrandLayers)
		.where(eq(klipBrandLayers.id, layerId))
		.limit(1);
	const row = existing[0];
	if (!row || row.projectId !== id) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	await db.delete(klipBrandLayers).where(eq(klipBrandLayers.id, layerId));
	return NextResponse.json({ ok: true });
}
