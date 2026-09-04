import { createReadStream, promises as fs } from "node:fs";
import { type NextRequest, NextResponse } from "next/server";
import { resolveMediaFile } from "@/klip/upload";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const resolved = await resolveMediaFile(id);
	if (!resolved) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	let stat;
	try {
		stat = await fs.stat(resolved.absPath);
	} catch {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	const stream = createReadStream(resolved.absPath);
	const body = new ReadableStream({
		start(controller) {
			stream.on("data", (chunk) => controller.enqueue(chunk));
			stream.on("end", () => controller.close());
			stream.on("error", (error) => controller.error(error));
		},
		cancel() {
			stream.destroy();
		},
	});
	return new NextResponse(body, {
		headers: {
			"content-type": resolved.contentType,
			"content-length": String(stat.size),
		},
	});
}
