import { NextResponse } from "next/server";
import { createTemplate, listTemplates } from "@/klip/templates";

export async function GET() {
	return NextResponse.json({ templates: await listTemplates() });
}

export async function POST(request: Request) {
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
		const template = await createTemplate({ name });
		return NextResponse.json({ template }, { status: 201 });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Create failed" },
			{ status: 500 },
		);
	}
}
