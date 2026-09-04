import { type NextRequest, NextResponse } from "next/server";
import { MAX_ZIP_BYTES, saveZipBatch } from "@/klip/batch-upload";
import { UploadError } from "@/klip/upload";

export async function POST(request: NextRequest) {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return NextResponse.json({ error: "file is required" }, { status: 400 });
	}
	if (!file.name.toLowerCase().endsWith(".zip")) {
		return NextResponse.json({ error: "Only .zip files are accepted" }, { status: 400 });
	}
	if (file.size === 0) {
		return NextResponse.json({ error: "file is empty" }, { status: 400 });
	}
	if (file.size > MAX_ZIP_BYTES) {
		return NextResponse.json({ error: "zip too large (max 2GB)" }, { status: 413 });
	}
	try {
		const result = await saveZipBatch({ bytes: Buffer.from(await file.arrayBuffer()), filename: file.name });
		return NextResponse.json(result, { status: 201 });
	} catch (error) {
		const status = error instanceof UploadError ? error.status : 500;
		const message = status === 500 ? "Batch upload failed" : (error as Error).message;
		return NextResponse.json({ error: message }, { status });
	}
}
