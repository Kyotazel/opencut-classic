import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, klipBatchJobs, klipProjects, klipSyncProjects } from "@/db";

/**
 * Daftar project yang ada di server.
 *
 * Menyertakan renderJobId kalau project ini punya hasil render, supaya halaman
 * /projects bisa menampilkan tautan unduh tanpa permintaan tambahan per kartu.
 *
 * Rantainya: klip_sync_projects.id = klip_projects.opencut_ref, lalu
 * klip_batch_jobs.project_id menunjuk ke klip_projects.id.
 */
export async function GET() {
	const rows = await db
		.select({
			id: klipSyncProjects.id,
			name: klipSyncProjects.name,
			updatedAt: klipSyncProjects.updatedAt,
			projectId: klipProjects.id,
		})
		.from(klipSyncProjects)
		.leftJoin(klipProjects, eq(klipProjects.opencutRef, klipSyncProjects.id));

	// Satu query untuk semua job, bukan satu per project.
	const renderByProject = new Map<string, string>();
	const jobs = await db
		.select({
			id: klipBatchJobs.id,
			projectId: klipBatchJobs.projectId,
			renderedPath: klipBatchJobs.renderedPath,
		})
		.from(klipBatchJobs);
	for (const job of jobs) {
		if (!job.projectId || !job.renderedPath) continue;
		renderByProject.set(job.projectId, job.id);
	}

	return NextResponse.json({
		projects: rows.map((r) => ({
			id: r.id,
			name: r.name,
			updatedAt: r.updatedAt,
			renderJobId: r.projectId ? (renderByProject.get(r.projectId) ?? null) : null,
		})),
	});
}
