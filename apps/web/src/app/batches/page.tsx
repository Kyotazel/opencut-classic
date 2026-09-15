"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/utils/date";

/** Ambil field error dari respons API tanpa assertion tipe. */
function pesanErrorDari({ body }: { body: unknown }): string | null {
	if (!body || typeof body !== "object") return null;
	const nilai = Object.fromEntries(Object.entries(body))["error"];
	return typeof nilai === "string" && nilai ? nilai : null;
}

/**
 * Keadaan kuota Instagram, ditulis worker saat kena batas laju.
 *
 * Ditampilkan supaya "kenapa belum terbit" bisa dijawab dari halaman ini,
 * tanpa harus menggali log server.
 */
type KuotaIg = {
	pemakaian: number | null;
	pulihPada: string | null;
	pesan: string | null;
};

/** Perkiraan pulih dalam kata-kata; null kalau waktunya sudah lewat. */
function deskripsiPulih({ kuota }: { kuota: KuotaIg }): string | null {
	if (!kuota.pulihPada) return null;
	const pulih = new Date(kuota.pulihPada).getTime();
	if (!Number.isFinite(pulih)) return null;
	const sisaMenit = Math.ceil((pulih - Date.now()) / 60_000);
	if (sisaMenit <= 0) return null;
	if (sisaMenit < 60) return "sekitar " + sisaMenit + " menit lagi";
	const jam = Math.floor(sisaMenit / 60);
	const sisa = sisaMenit % 60;
	if (sisa === 0) return "sekitar " + jam + " jam lagi";
	return "sekitar " + jam + " jam " + sisa + " menit lagi";
}
type Progress = {
	queued: number;
	running: number;
	done: number;
	failed: number;
};

type BatchRow = {
	id: string;
	ownerUserId: string | null;
	templateId: string | null;
	/** Caption Instagram untuk seluruh video di batch ini. */
	caption: string | null;
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
	/** Terisi setelah render selesai dan berkasnya tersimpan di server. */
	renderedPath: string | null;
	/** Tautan postingan Instagram, terisi setelah publish berhasil. */
	permalink: string | null;
};

/**
 * Tahap yang perlu dilihat manusia.
 *
 * Tahap normal (extracted, project_created, render_done, publishing) tidak
 * ditampilkan supaya baris tidak penuh; yang ditampilkan hanya tahap yang
 * butuh tindakan atau menjelaskan kenapa sebuah video berhenti.
 */
const STAGE_NOTE: Record<string, string> = {
	no_ig_account: "tanpa akun IG - publish dilewati",
	publish_skipped: "publish dilewati",
	publish_failed: "publish gagal",
	publish_rate_limited: "kena batas laju IG",
};

const STATUS_STYLE: Record<string, string> = {
	// Status batch
	queued: "bg-muted text-muted-foreground",
	running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	partial: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	failed: "bg-destructive/15 text-destructive",
	halted: "bg-destructive/15 text-destructive",
	// Status job - kalau tidak dipetakan, semuanya tampil seperti "queued" dan
	// sulit dibedakan saat batch sedang berjalan.
	extracting: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	rendering: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	rendered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	publishing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
	published: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	cancelled: "bg-muted text-muted-foreground",
};

/**
 * Halaman tracking antrian batch.
 *
 * Tahap 1 belum punya worker, jadi job akan lama berstatus "queued".
 * Halaman ini sengaja menampilkan itu apa adanya supaya tidak terlihat
 * seperti aplikasi yang menggantung.
 */
/** Status job yang boleh dijalankan ulang dari UI. */
function isRetryable({ status }: { status: string }): boolean {
	return status === "failed" || status === "cancelled";
}

export default function BatchesPage() {
	const [batches, setBatches] = useState<BatchRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [kuotaIg, setKuotaIg] = useState<KuotaIg | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [jobs, setJobs] = useState<JobRow[]>([]);
	const [jobsLoading, setJobsLoading] = useState(false);
	/** URL yang sedang diproses, supaya tombolnya bisa menampilkan status. */
	const [retrying, setRetrying] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const res = await fetch("/api/klip/batches", { cache: "no-store" });
			const body = (await res.json()) as {
				batches?: BatchRow[];
				kuotaIg?: KuotaIg | null;
				error?: string;
			};
			if (!res.ok) throw new Error(body.error ?? "Gagal memuat batch");
			setBatches(body.batches ?? []);
			setKuotaIg(body.kuotaIg ?? null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Gagal memuat batch");
			setBatches([]);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * Jalankan ulang job yang gagal. `fresh` = buang hasil render supaya
	 * dirender ulang dari nol; tanpa itu job yang sudah punya berkas render
	 * langsung masuk tahap publish.
	 */
	const retry = async ({
		url,
		fresh = false,
		reloadJobs = false,
	}: {
		url: string;
		fresh?: boolean;
		reloadJobs?: boolean;
	}) => {
		setRetrying(url);
		setError(null);
		try {
			const res = await fetch(fresh ? `${url}?fresh=1` : url, {
				method: "POST",
			});
			const body: unknown = await res.json();
			if (!res.ok)
				throw new Error(pesanErrorDari({ body }) ?? "Gagal menjalankan ulang");
			await load();
			if (reloadJobs && openId) await toggle({ id: openId });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Gagal menjalankan ulang");
		} finally {
			setRetrying(null);
		}
	};

	const toggle = async ({ id }: { id: string }) => {
		if (openId === id) {
			setOpenId(null);
			return;
		}
		setOpenId(id);
		setJobsLoading(true);
		try {
			const res = await fetch(
				`/api/klip/batches?id=${encodeURIComponent(id)}`,
				{ cache: "no-store" },
			);
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
						ZIP yang sudah masuk antrian. Worker memprosesnya satu per satu:
						render, lalu publish ke Instagram kalau akun tujuannya sudah diatur.
						Video yang sudah dirender punya tautan Unduh.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => void load()}>
						Muat ulang
					</Button>
					<Link href="/projects">
						<Button variant="outline" size="sm">
							Kembali
						</Button>
					</Link>
				</div>
			</div>

			{kuotaIg && deskripsiPulih({ kuota: kuotaIg }) && (
				<Card>
					<CardContent className="flex flex-col gap-1 p-4 text-sm">
						<span className="font-medium text-amber-600 dark:text-amber-400">
							Instagram sedang membatasi panggilan API - publish ditunda
							{deskripsiPulih({ kuota: kuotaIg })}.
						</span>
						<span className="text-muted-foreground text-xs">
							Meta menghitung kuota panggilan per 24 jam bergulir, sebanding
							dengan jumlah penayangan akun. Render tetap jalan; hanya
							penerbitannya yang menunggu.
							{kuotaIg.pemakaian !== null &&
								" Pemakaian terakhir: " + kuotaIg.pemakaian + "%."}
						</span>
					</CardContent>
				</Card>
			)}

			{error && (
				<Card>
					<CardContent className="text-destructive p-4 text-sm">
						{error}
					</CardContent>
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
						<span className="text-foreground font-medium">
							{" "}
							&quot;Antrikan batch&quot;
						</span>
						.
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
										<span className="font-mono text-sm font-medium">
											{b.id}
										</span>
										<span
											className={`rounded-sm px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status] ?? STATUS_STYLE.queued}`}
										>
											{b.status}
										</span>
										<span className="text-muted-foreground text-xs">
											{b.source}
										</span>
									</div>
									<span className="text-muted-foreground text-xs">
										{b.ownerUserId ?? "(tanpa pemilik)"} &middot;{" "}
										{formatDate({ date: new Date(b.createdAt) })}
									</span>
								</div>
								<span className="flex items-center gap-2">
									{b.progress.failed > 0 && (
										<Button
											variant="outline"
											size="sm"
											disabled={retrying !== null}
											onClick={() =>
												void retry({
													url: `/api/klip/batches/${encodeURIComponent(b.id)}/retry-failed`,
													reloadJobs: true,
												})
											}
										>
											{retrying ===
											`/api/klip/batches/${encodeURIComponent(b.id)}/retry-failed`
												? "Menjalankan..."
												: `Ulangi ${b.progress.failed} yang gagal`}
										</Button>
									)}
									<Button
										variant="outline"
										size="sm"
										onClick={() => void toggle({ id: b.id })}
									>
										{openId === b.id ? "Tutup" : "Lihat job"}
									</Button>
								</span>
							</div>

							<div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
								<span>Total: {b.total}</span>
								<span>Menunggu: {b.progress.queued}</span>
								<span>Jalan: {b.progress.running}</span>
								<span>Selesai: {b.progress.done}</span>
								<span>Gagal: {b.progress.failed}</span>
								{b.templateId && <span>Template: {b.templateId}</span>}
							</div>

							{b.caption && (
								<p
									className="text-muted-foreground truncate text-xs"
									title={b.caption}
								>
									Caption: {b.caption}
								</p>
							)}

							{b.haltedReason && (
								<p className="text-destructive text-xs">
									Dihentikan: {b.haltedReason}
								</p>
							)}

							{openId === b.id && (
								<div className="border-border overflow-hidden rounded-md border">
									{jobsLoading && (
										<p className="text-muted-foreground p-3 text-xs">
											Memuat job...
										</p>
									)}
									{!jobsLoading && jobs.length === 0 && (
										<p className="text-muted-foreground p-3 text-xs">
											Tidak ada job.
										</p>
									)}
									{!jobsLoading &&
										jobs.map((j) => (
											<div
												key={j.id}
												className="border-border flex items-start justify-between gap-3 border-b px-3 py-2 last:border-0"
											>
												<span
													className="truncate font-mono text-xs"
													title={j.entryName}
												>
													{j.entryName}
												</span>
												<span className="flex shrink-0 items-center gap-2">
													{isRetryable({ status: j.status }) && (
														<>
															<button
																type="button"
																disabled={retrying !== null}
																onClick={() =>
																	void retry({
																		url: `/api/klip/batch-jobs/${encodeURIComponent(j.id)}/retry`,
																		reloadJobs: true,
																	})
																}
																className="text-xs font-medium text-amber-600 hover:underline disabled:opacity-50 dark:text-amber-400"
															>
																Ulangi
															</button>
															<button
																type="button"
																disabled={retrying !== null}
																title="Buang hasil render lalu render ulang dari nol"
																onClick={() =>
																	void retry({
																		url: `/api/klip/batch-jobs/${encodeURIComponent(j.id)}/retry`,
																		fresh: true,
																		reloadJobs: true,
																	})
																}
																className="text-muted-foreground text-xs font-medium hover:underline disabled:opacity-50"
															>
																Render ulang
															</button>
														</>
													)}
													{j.stage && STAGE_NOTE[j.stage] && (
														<span
															className="text-destructive text-xs"
															title={j.error ?? undefined}
														>
															{STAGE_NOTE[j.stage]}
														</span>
													)}
													{j.permalink && (
														<a
															href={j.permalink}
															target="_blank"
															rel="noreferrer"
															className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
														>
															Lihat di IG
														</a>
													)}
													{j.renderedPath && (
														<a
															href={`/api/klip/batch-jobs/${encodeURIComponent(j.id)}/video`}
															download
															className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
														>
															Unduh
														</a>
													)}
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
