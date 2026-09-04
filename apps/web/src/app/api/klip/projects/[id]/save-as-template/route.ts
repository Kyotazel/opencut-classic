import { type NextRequest, NextResponse } from "next/server";
import { saveAsTemplate } from "@/klip/templates";

export async function POST(
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
	const name = typeof (body as Record<string, unknown>)?.name === "string"
		? ((body as Record<string, unknown>).name as string)
		: "";
	if (!name.trim()) {
		return NextResponse.json({ error: "name is required" }, { status: 400 });
	}
	try {
		const saved = await saveAsTemplate({ projectId: id, name });
		if (!saved) return NextResponse.json({ error: "Not found" }, { status: 404 });
		return NextResponse.json(saved, { status: 201 });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Save failed" },
			{ status: 500 },
		);
	}
}
