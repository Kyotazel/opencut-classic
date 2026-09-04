import { type NextRequest, NextResponse } from "next/server";
import { applyTemplate } from "@/klip/templates";

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
	const b = body as Record<string, unknown>;
	if (typeof b.templateId !== "string" || !b.templateId) {
		return NextResponse.json({ error: "templateId is required" }, { status: 400 });
	}
	const mainDuration = typeof b.mainDuration === "number" ? b.mainDuration : null;
	const result = await applyTemplate({
		projectId: id,
		templateId: b.templateId,
		mainDuration,
	});
	if (result.status !== 200) {
		return NextResponse.json({ error: result.error }, { status: result.status });
	}
	return NextResponse.json({ layers: result.layers, totalDuration: result.totalDuration });
}
