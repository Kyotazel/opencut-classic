import { type NextRequest, NextResponse } from "next/server";
import { listLayers, resolveOrCreateProject } from "@/klip/brand";

/**
 * Minimal Slice 1 resolve-or-create: returns { project, layers },
 * creating the klip_projects row (sourceMediaId null) when absent.
 */
export async function GET(request: NextRequest) {
	const url = new URL(request.url);
	const opencutRef = url.searchParams.get("opencutRef");
	if (!opencutRef) {
		return NextResponse.json({ error: "opencutRef is required" }, { status: 400 });
	}
	const name = url.searchParams.get("name") ?? undefined;
	const project = await resolveOrCreateProject({ opencutRef, name });
	const layers = await listLayers({ projectId: project.id });
	return NextResponse.json({ project, layers });
}
