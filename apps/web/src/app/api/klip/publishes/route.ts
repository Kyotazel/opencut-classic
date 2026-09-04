import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipIgAccounts, klipIgPublishItems, klipIgPublishes, klipProjects } from "@/db";
import { dataRoot } from "@/klip/upload";
import {
	IgPublishError,
	newPublishId,
	parseAccountIds,
	processItems,
	publishVideoPath,
	validateCaption,
	validateVideoFile,
} from "@/klip/ig-publish";

export async function POST(request: NextRequest) {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
	}
	try {
		const projectId = form.get("projectId");
		if (typeof projectId !== "string" || !projectId) {
			throw new IgPublishError({ message: "projectId wajib diisi" });
		}
		const caption = validateCaption({ caption: form.get("caption") ?? "" });
		const accountIds = parseAccountIds({ raw: form.get("accountIds") });
		const file = validateVideoFile({ file: form.get("file") });

		const [project] = await db
			.select()
			.from(klipProjects)
			.where(eq(klipProjects.id, projectId))
			.limit(1);
		if (!project) {
			throw new IgPublishError({ message: "Project tidak ditemukan", status: 404 });
		}
		const accounts = await db.select().from(klipIgAccounts);
		const byId = new Map(accounts.map((a) => [a.id, a]));
		for (const accountId of accountIds) {
			const account = byId.get(accountId);
			if (!account) {
				throw new IgPublishError({ message: `Akun ${accountId} tidak ditemukan`, status: 404 });
			}
			if (account.status !== "active") {
				throw new IgPublishError({
					message: `Akun @${account.username} tidak aktif. Hubungkan ulang dulu.`,
					status: 409,
				});
			}
		}

		const publishId = newPublishId({ prefix: "p" });
		const { abs, rel } = publishVideoPath({ publishId });
		await mkdir(path.join(dataRoot(), "publishes"), { recursive: true });
		await writeFile(abs, Buffer.from(await file.arrayBuffer()));
		await db.insert(klipIgPublishes).values({
			id: publishId,
			projectId,
			caption,
			videoPath: rel,
		});
		for (const accountId of accountIds) {
			await db.insert(klipIgPublishItems).values({
				id: newPublishId({ prefix: "pi" }),
				publishId,
				igAccountId: accountId,
			});
		}
		await db
			.update(klipProjects)
			.set({ caption, updatedAt: new Date() })
			.where(eq(klipProjects.id, projectId));

		void processItems({ publishId }).catch((error: unknown) => {
			console.error(`processItems ${publishId} gagal:`, error);
		});
		return NextResponse.json({ id: publishId }, { status: 201 });
	} catch (error) {
		if (error instanceof IgPublishError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		console.error("POST publishes gagal:", error);
		return NextResponse.json({ error: "Gagal membuat publish job" }, { status: 500 });
	}
}
