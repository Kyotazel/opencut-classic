"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FaInstagram } from "react-icons/fa6";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import { cn } from "@/utils/ui";

const MAX_CAPTION = 2200;
const POLL_MS = 3000;

interface IgAccount {
	id: string;
	username: string;
	profilePicUrl: string | null;
	status: "active" | "token_expired" | "disconnected";
}

interface PublishItem {
	id: string;
	igAccountId: string;
	username: string | null;
	status: "queued" | "uploading" | "processing" | "published" | "failed";
	permalink: string | null;
	error: string | null;
}

interface PublishStatus {
	publish: { id: string; status: string };
	items: PublishItem[];
}

interface DialogInitial {
	klipProjectId: string | null;
	projectName: string;
	caption: string;
	accounts: IgAccount[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAccounts({ value }: { value: unknown }): IgAccount[] {
	if (!isRecord(value) || !Array.isArray(value["accounts"])) return [];
	const out: IgAccount[] = [];
	for (const raw of value["accounts"]) {
		if (!isRecord(raw)) continue;
		if (typeof raw["id"] !== "string" || typeof raw["username"] !== "string") continue;
		const status = raw["status"];
		out.push({
			id: raw["id"],
			username: raw["username"],
			profilePicUrl: typeof raw["profilePicUrl"] === "string" ? raw["profilePicUrl"] : null,
			status:
				status === "active" ? "active" : status === "token_expired" ? "token_expired" : "disconnected",
		});
	}
	return out;
}

function parsePublishStatus({ value }: { value: unknown }): PublishStatus | null {
	if (!isRecord(value)) return null;
	const publish = value["publish"];
	const items = value["items"];
	if (!isRecord(publish) || typeof publish["id"] !== "string") return null;
	if (!Array.isArray(items)) return null;
	const parsed: PublishItem[] = [];
	for (const raw of items) {
		if (!isRecord(raw)) continue;
		if (typeof raw["id"] !== "string" || typeof raw["igAccountId"] !== "string") continue;
		const status = raw["status"];
		if (
			status !== "queued" &&
			status !== "uploading" &&
			status !== "processing" &&
			status !== "published" &&
			status !== "failed"
		) {
			continue;
		}
		parsed.push({
			id: raw["id"],
			igAccountId: raw["igAccountId"],
			username: typeof raw["username"] === "string" ? raw["username"] : null,
			status,
			permalink: typeof raw["permalink"] === "string" ? raw["permalink"] : null,
			error: typeof raw["error"] === "string" ? raw["error"] : null,
		});
	}
	return {
		publish: {
			id: publish["id"],
			status: typeof publish["status"] === "string" ? publish["status"] : "",
		},
		items: parsed,
	};
}

async function readError({ res }: { res: Response }): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (isRecord(body) && typeof body["error"] === "string") return body["error"];
	} catch {
		// abaikan, pakai pesan default
	}
	return `Request gagal: ${res.status}`;
}

const ITEM_LABEL: Record<PublishItem["status"], string> = {
	queued: "Antri",
	uploading: "Mengunggah",
	processing: "Diproses IG",
	published: "Terbit",
	failed: "Gagal",
};

export function PublishButton() {
	const [initial, setInitial] = useState<DialogInitial | null>(null);
	const [opening, setOpening] = useState(false);
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handleOpen = async () => {
		const opencutRef = activeProject?.metadata.id ?? null;
		const opencutName = activeProject?.metadata.name ?? "Untitled";
		if (!opencutRef || opening) return;
		setOpening(true);
		try {
			const data: DialogInitial = {
				klipProjectId: null,
				projectName: "video",
				caption: "",
				accounts: [],
			};
			const res = await fetch(
				`/api/klip/projects/by-opencut?opencutRef=${encodeURIComponent(opencutRef)}&name=${encodeURIComponent(opencutName)}`,
			);
			if (res.ok) {
				const body: unknown = await res.json();
				if (isRecord(body) && isRecord(body["project"])) {
					const proj = body["project"];
					if (typeof proj["id"] === "string") data.klipProjectId = proj["id"];
					if (typeof proj["name"] === "string") data.projectName = proj["name"];
					if (typeof proj["caption"] === "string") data.caption = proj["caption"];
				}
			}
			const accRes = await fetch("/api/klip/ig-accounts");
			if (accRes.ok) {
				data.accounts = parseAccounts({ value: (await accRes.json()) as unknown });
			}
			setInitial(data);
		} finally {
			setOpening(false);
		}
	};

	return (
		<>
			<button
				type="button"
				className={cn(
					"flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[0.875rem] text-white",
					hasProject && !opening
						? "cursor-pointer bg-gradient-to-r from-[#F58529] via-[#DD2A7B] to-[#8134AF]"
						: "cursor-not-allowed opacity-50",
				)}
				disabled={!hasProject || opening}
				onClick={hasProject && !opening ? () => void handleOpen() : undefined}
			>
				<FaInstagram className="size-3.5" />
				<span>{opening ? "Membuka..." : "Publish"}</span>
			</button>
			{initial && <PublishDialog initial={initial} onOpenChange={() => setInitial(null)} />}
		</>
	);
}

function PublishDialog({
	initial,
	onOpenChange,
}: {
	initial: DialogInitial;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const exportState = useEditor((e) => e.project.getExportState());
	const [klipProjectId] = useState<string | null>(initial.klipProjectId);
	const [projectName] = useState(initial.projectName);
	const [accounts] = useState<IgAccount[]>(initial.accounts);
	const [selected, setSelected] = useState<string[]>([]);
	const [caption, setCaption] = useState(initial.caption);
	const [captionSaved, setCaptionSaved] = useState(initial.caption);
	const [phase, setPhase] = useState<"form" | "sending" | "progress">("form");
	const [sendNote, setSendNote] = useState("Menyiapkan...");
	const [publishId, setPublishId] = useState<string | null>(null);
	const [status, setStatus] = useState<PublishStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	const poll = useCallback(({ id }: { id: string }) => {
		if (pollRef.current) clearInterval(pollRef.current);
		const tick = async () => {
			try {
				const res = await fetch(`/api/klip/publishes/${id}`);
				if (!res.ok) throw new Error(await readError({ res }));
				const parsed = parsePublishStatus({ value: (await res.json()) as unknown });
				if (!parsed) throw new Error("Respons status tidak valid");
				setStatus(parsed);
				if (["done", "partial", "failed"].includes(parsed.publish.status)) {
					if (pollRef.current) clearInterval(pollRef.current);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : "Polling gagal");
				if (pollRef.current) clearInterval(pollRef.current);
			}
		};
		void tick();
		pollRef.current = setInterval(() => void tick(), POLL_MS);
	}, []);

	const handleSubmit = async () => {
		if (!klipProjectId || selected.length === 0) return;
		setError(null);
		try {
			if (caption !== captionSaved) {
				const res = await fetch(`/api/klip/projects/${klipProjectId}/caption`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ caption }),
				});
				if (!res.ok) throw new Error(await readError({ res }));
				setCaptionSaved(caption);
			}
			setPhase("sending");
			setSendNote("Render video di browser...");
			const result = await editor.project.export({
				options: {
					format: "mp4",
					quality: DEFAULT_EXPORT_OPTIONS.quality,
					includeAudio: true,
				},
			});
			if (!result.success || !result.buffer) {
				throw new Error(result.error ?? "Export gagal");
			}
			setSendNote("Mengunggah ke server...");
			const form = new FormData();
			form.set("projectId", klipProjectId);
			form.set("caption", caption);
			form.set("accountIds", JSON.stringify(selected));
			form.set("file", new File([result.buffer], `${projectName}.mp4`, { type: "video/mp4" }));
			const res = await fetch("/api/klip/publishes", { method: "POST", body: form });
			if (!res.ok) throw new Error(await readError({ res }));
			const body: unknown = await res.json();
			if (!isRecord(body) || typeof body["id"] !== "string") {
				throw new Error("Respons server tidak valid");
			}
			setPublishId(body["id"]);
			setPhase("progress");
			poll({ id: body["id"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Publish gagal");
			setPhase("form");
		}
	};

	const handleRetry = async ({ itemId }: { itemId: string }) => {
		if (!publishId) return;
		setError(null);
		const res = await fetch(`/api/klip/publishes/${publishId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ itemId }),
		});
		if (!res.ok) {
			setError(await readError({ res }));
			return;
		}
		poll({ id: publishId });
	};

	const done = status !== null && ["done", "partial", "failed"].includes(status.publish.status);

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Publish ke Instagram</DialogTitle>
					<DialogDescription>
						Video di-render dari timeline lalu dikirim sebagai Reels ke akun terpilih.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{phase === "form" && (
						<>
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">Akun tujuan</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											window.location.href = "/api/klip/ig-accounts/authorize";
										}}
									>
										Hubungkan Instagram
									</Button>
								</div>
								{accounts.length === 0 && (
									<p className="text-muted-foreground text-sm">
										Belum ada akun terhubung. Klik Hubungkan Instagram dulu.
									</p>
								)}
								{accounts.map((a) => (
									<label key={a.id} className="flex items-center gap-2 text-sm">
										<Checkbox
											checked={selected.includes(a.id)}
											disabled={a.status !== "active"}
											onCheckedChange={(v) => {
												setSelected((prev) =>
													v ? [...prev, a.id] : prev.filter((id) => id !== a.id),
												);
											}}
										/>
										<span>@{a.username}</span>
										{a.status === "token_expired" && (
											<span className="text-xs text-amber-500">
												perlu reconnect — hubungkan ulang
											</span>
										)}
										{a.status === "disconnected" && (
											<span className="text-muted-foreground text-xs">terputus</span>
										)}
									</label>
								))}
							</div>
							<div className="space-y-1">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">Caption</span>
									<span className="text-muted-foreground text-xs">
										{caption.length}/{MAX_CAPTION}
									</span>
								</div>
								<Textarea
									value={caption}
									maxLength={MAX_CAPTION}
									rows={4}
									onChange={(e) => setCaption(e.target.value)}
								/>
							</div>
							{error && <p className="text-sm text-red-500">{error}</p>}
						</>
					)}
					{phase === "sending" && (
						<div className="space-y-2">
							<p className="text-sm">{sendNote}</p>
							<Progress value={exportState.isExporting ? exportState.progress * 100 : 100} />
							{error && <p className="text-sm text-red-500">{error}</p>}
						</div>
					)}
					{phase === "progress" && (
						<div className="space-y-2">
							{(status?.items ?? []).map((item) => (
								<div key={item.id} className="flex items-center justify-between gap-2 text-sm">
									<span>
										@{item.username ?? item.igAccountId} — {ITEM_LABEL[item.status]}
									</span>
									<span className="flex items-center gap-2">
										{item.status === "published" && item.permalink && (
											<a
												href={item.permalink}
												target="_blank"
												rel="noreferrer"
												className="text-sky-500 underline"
											>
												Lihat
											</a>
										)}
										{item.status === "failed" && (
											<Button
												size="sm"
												variant="outline"
												onClick={() => void handleRetry({ itemId: item.id })}
											>
												Retry
											</Button>
										)}
									</span>
								</div>
							))}
							{(status?.items ?? [])
								.filter((i) => i.status === "failed" && i.error)
								.map((i) => (
									<p key={i.id} className="text-xs text-red-500">
										@{i.username}: {i.error}
									</p>
								))}
							{error && <p className="text-sm text-red-500">{error}</p>}
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					{phase === "form" && (
						<Button
							disabled={!klipProjectId || selected.length === 0 || caption.length > MAX_CAPTION}
							onClick={() => void handleSubmit()}
						>
							Publish ke {selected.length} akun
						</Button>
					)}
					{phase === "progress" && done && (
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Tutup
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
