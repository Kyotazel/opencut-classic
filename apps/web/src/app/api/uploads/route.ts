import { type NextRequest, NextResponse } from "next/server";
import { saveUpload, UploadError } from "@/klip/upload";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

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
	if (file.size === 0) {
		return NextResponse.json({ error: "file is empty" }, { status: 400 });
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return NextResponse.json({ error: "file too large" }, { status: 413 });
	}
	try {
		const result = await saveUpload({ file });
		return NextResponse.json(result, { status: 201 });
	} catch (error) {
		const status =
			error instanceof UploadError
				? error.status
				: (error as { status?: number }).status ?? 500;
		const message =
			status === 500 ? "Upload failed" : (error as Error).message;
		return NextResponse.json({ error: message }, { status });
	}
}
