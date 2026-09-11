"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/utils/date";

type Progress = { queued: number; running: number; done: number; failed: number };

type BatchRow = {
	id: string;
	ownerUserId: string | null;
	templateId: string | null;
	source: "upload" | "api";
	status: "queued" | "running" | "done" | "partial" | "failed" | "halted";
	total: number;
	haltedReason: string | null;
	createdAt: string;
	progress: Progress;
};

type JobRow = {
	id: string;
	entryName: string;
	status: string;
	stage: string | null;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: string | null;
	error: string | null;
};

const STATUS_STYLE: Record<string, string> = {
	queued: "bg-muted text-muted-foreground",
	running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	partial: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	failed: "bg-destructive/15 text-destructive",
	halted: "bg-destructive/15 text-destructive",
};

/**
 * Halaman tracking antrian batch.
 *
 * Tahap 1 belum punya worker, jadi job akan lama berstatus "queued".
 * Halaman ini sengaja menampilkan itu apa adanya supaya tidak terlihat
 * seperti aplikasi yang menggantung.
 */
export default function BatchesPage() {
	const [batches, setBatches] = useState<BatchRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [jobs, setJobs] = useState<JobRow[]>([]);
	const [jobsLoading, setJobsLoading] = useState(false);

	const load = useCallback(async () => {
		setError(null);
		try {
			const res = await fetch("/api/klip/batches", { cache: "no-store" });
			const body = (await res.json()) as { batches?: BatchRow[]; error?: string };
			if (!res.ok) throw new Error(body.error ?? "Gagal memuat batch");
			setBatches(body.batches ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Gagal memuat batch");
			setBatches([]);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = async ({ id }: { id: string }) => {
		if (openId === id) {
			setOpenId(null);
			return;
		}
		setOpenId(id);
		setJobsLoading(true);
		try {
			const res = await fetch(`/api/klip/batches?id=${encodeURIComponent(id)}`, { cache: "no-store" });
			const body = (await res.json()) as { jobs?: JobRow[] };
			setJobs(body.jobs ?? []);
		} catch {
			setJobs([]);
		} finally {
			setJobsLoading(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
			<div className="flex items-center justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold">Antrian batch</h1>
					<p className="text-muted-foreground text-sm">
						ZIP yang sudah masuk antrian. Belum ada worker, jadi job masih
						menunggu.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => void load()}>
						Muat ulang
					</Button>
					<Link href="/projects">
						<Button variant="outline" size="sm">Kembali</Button>
					</Link>
				</div>
			</div>

			{error && (
				<Card>
					<CardContent className="text-destructive p-4 text-sm">{error}</CardContent>
				</Card>
			)}

			{batches === null && (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
				</div>
			)}

			{batches !== null && batches.length === 0 && !error && (
				<Card>
					<CardContent className="text-muted-foreground p-6 text-sm">
						Belum ada batch. Kembali ke halaman projects lalu klik
						<span className="text-foreground font-medium"> &quot;Antrikan batch&quot;</span>.
					</CardContent>
				</Card>
			)}

			<div className="flex flex-col gap-3">
				{(batches ?? []).map((b) => (
					<Card key={b.id}>
						<CardContent className="flex flex-col gap-3 p-4">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex flex-col gap-1">
									<div className="flex items-center gap-2">
										<span className="font-mono text-sm font-medium">{b.id}</span>
										<span
											className={`rounded-sm px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status] ?? STATUS_STYLE.queued}`}
										>
											{b.status}
										</span>
										<span className="text-muted-foreground text-xs">{b.source}</span>
									</div>
									<span className="text-muted-foreground text-xs">
										{b.ownerUserId ?? "(tanpa pemilik)"} &middot;{" "}
										{formatDate({ date: new Date(b.createdAt) })}
									</span>
								</div>
								<Button variant="outline" size="sm" onClick={() => void toggle({ id: b.id })}>
									{openId === b.id ? "Tutup" : "Lihat job"}
								</Button>
							</div>

							<div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
								<span>Total: {b.total}</span>
								<span>Menunggu: {b.progress.queued}</span>
								<span>Jalan: {b.progress.running}</span>
								<span>Selesai: {b.progress.done}</span>
								<span>Gagal: {b.progress.failed}</span>
								{b.templateId && <span>Template: {b.templateId}</span>}
							</div>

							{b.haltedReason && (
								<p className="text-destructive text-xs">
									Dihentikan: {b.haltedReason}
								</p>
							)}

							{openId === b.id && (
								<div className="border-border overflow-hidden rounded-md border">
									{jobsLoading && (
										<p className="text-muted-foreground p-3 text-xs">Memuat job...</p>
									)}
									{!jobsLoading && jobs.length === 0 && (
										<p className="text-muted-foreground p-3 text-xs">Tidak ada job.</p>
									)}
									{!jobsLoading &&
										jobs.map((j) => (
											<div
												key={j.id}
												className="border-border flex items-start justify-between gap-3 border-b px-3 py-2 last:border-0"
											>
												<span className="truncate font-mono text-xs" title={j.entryName}>
													{j.entryName}
												</span>
												<span className="flex shrink-0 items-center gap-2">
													<span className="text-muted-foreground text-xs">
														{j.attempts}/{j.maxAttempts}
													</span>
													<span
														className={`rounded-sm px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[j.status] ?? STATUS_STYLE.queued}`}
													>
														{j.status}
													</span>
												</span>
											</div>
										))}
								</div>
							)}
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	);
}
