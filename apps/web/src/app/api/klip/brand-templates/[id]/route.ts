import { type NextRequest, NextResponse } from "next/server";
import { deleteTemplate, getTemplateWithLayers, renameTemplate } from "@/klip/templates";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
	const { id } = await params;
	const found = await getTemplateWithLayers({ id });
	if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json(found);
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const name = typeof (body as Record<string, unknown>)?.name === "string"
		? ((body as Record<string, unknown>).name as string)
		: "";
	if (!name.trim()) {
		return NextResponse.json({ error: "name is required" }, { status: 400 });
	}
	const template = await renameTemplate({ id, name });
	if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ template });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
	const { id } = await params;
	const ok = await deleteTemplate({ id });
	if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ ok: true });
}
