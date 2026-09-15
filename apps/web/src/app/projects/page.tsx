"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { StoragePersistenceDialog } from "@/services/storage/components/storage-persistence-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";
import { useProjectsStore } from "./store";
import type {
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
} from "@/project/types";
import { formatTimecode, mediaTimeToSeconds } from "opencut-wasm";
import { createProjectFromServerVideo } from "@/klip/batch-projects";
import { formatDate } from "@/utils/date";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
	Calendar04Icon,
	GridViewIcon,
	LeftToRightListDashIcon,
	PlusSignIcon,
	Search01Icon,
	Video01Icon,
	MoreHorizontalIcon,
	Delete02Icon,
	Copy01Icon,
	Edit03Icon,
	ArrowDown02Icon,
	InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { OcVideoIcon } from "@/components/icons";
import { Label } from "@/components/ui/label";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteProjectDialog } from "@/project/components/delete-project-dialog";
import { ProjectInfoDialog } from "@/project/components/project-info-dialog";
import { RenameProjectDialog } from "@/project/components/rename-project-dialog";
import { cn } from "@/utils/ui";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
const formatProjectDuration = ({
	duration,
}: {
	duration: number | undefined;
}): string | null => {
	if (duration === undefined) {
		return null;
	}

	const durationSeconds = mediaTimeToSeconds({ time: duration });
	const format = durationSeconds >= 3600 ? "HH:MM:SS" : "MM:SS";
	return formatTimecode({ time: duration, format }) ?? "";
};

const VIEW_MODE_OPTIONS = [
	{ mode: "grid" as const, icon: GridViewIcon, label: "Grid view" },
	{ mode: "list" as const, icon: LeftToRightListDashIcon, label: "List view" },
];

export default function ProjectsPage() {
	const { searchQuery, sortKey, sortOrder, viewMode } = useProjectsStore();
	const editor = useEditor();
	const sortOption: TProjectSortOption = `${sortKey}-${sortOrder}`;

	const isLoading = useEditor((e) => e.project.getIsLoading());
	const isInitialized = useEditor((e) => e.project.getIsInitialized());
	const projectsToDisplay = useEditor((e) =>
		e.project.getFilteredAndSortedProjects({ searchQuery, sortOption }),
	);

	useEffect(() => {
		if (!editor.project.getIsInitialized()) {
			editor.project.loadAllProjects();
		}
	}, [editor.project]);

	return (
		<div className="bg-background min-h-screen">
			<MigrationDialog />
			<StoragePersistenceDialog />
			<ChangelogNotification />
			<ProjectsHeader />
			<ProjectsToolbar projectIds={projectsToDisplay.map((p) => p.id)} />
			<main className="mx-auto px-4 pt-2 pb-6 flex flex-col gap-4">
				{isInitialized && <ServerProjectsSection localIds={projectsToDisplay.map((p) => p.id)} />}
				{isLoading || !isInitialized ? (
					<ProjectsSkeleton />
				) : projectsToDisplay.length === 0 ? (
					<EmptyState />
				) : (
					<div
						className={
							viewMode === "grid"
								? "xs:grid-cols-2 grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4 px-4"
								: "flex flex-col"
						}
					>
						{projectsToDisplay.map((project) => (
							<ProjectItem
								key={project.id}
								project={project}
								allProjectIds={projectsToDisplay.map((p) => p.id)}
							/>
						))}
					</div>
				)}
			</main>
		</div>
	);
}

function ProjectsHeader() {
	const { viewMode, isHydrated, setViewMode } = useProjectsStore();

	return (
		<header className="sticky top-0 z-20 px-8 bg-background flex flex-col gap-2">
			<div className="flex items-center justify-between h-16 pt-2">
				<div className="flex items-center gap-5">
					<Breadcrumb>
						<BreadcrumbList>
							<BreadcrumbItem>
								<BreadcrumbLink asChild>
									<Link href="/" className="text-sm sm:text-base">
										Home
									</Link>
								</BreadcrumbLink>
							</BreadcrumbItem>
							<BreadcrumbSeparator />
							<BreadcrumbItem>
								<BreadcrumbPage className="text-sm sm:text-base font-medium">
									All projects
								</BreadcrumbPage>
							</BreadcrumbItem>
						</BreadcrumbList>
					</Breadcrumb>

					<div className="hidden md:flex items-center rounded-md border p-1 px-1.5 h-10">
						{VIEW_MODE_OPTIONS.map(({ mode, icon, label }) => (
							<Button
								key={mode}
								variant="ghost"
								size="icon"
								className={cn(
									"rounded-sm hover:bg-background",
									isHydrated && viewMode === mode && "!bg-accent",
								)}
								onClick={() => setViewMode({ viewMode: mode })}
								aria-label={label}
								aria-pressed={isHydrated && viewMode === mode}
							>
								<HugeiconsIcon icon={icon} className="size-4" />
							</Button>
						))}
					</div>
				</div>

				<div className="flex items-center gap-3 md:gap-4">
					<SearchBar className="hidden md:block" />
					<UploadZipButton />
					<QueueBatchButton />
					<Link href="/batches">
						<Button variant="outline" size="sm">
							<span className="text-sm font-medium hidden md:block">Antrian</span>
						</Button>
					</Link>
					<Link href="/instagram">
						<Button variant="outline" size="sm">
							<span className="text-sm font-medium hidden md:block">Instagram</span>
						</Button>
					</Link>
					<Link href="/settings">
						<Button variant="outline" size="sm">
							<span className="text-sm font-medium hidden md:block">Setelan</span>
						</Button>
					</Link>
					<SyncUploadButton />
					<LogoutButton />
					<NewProjectButton />
				</div>
			</div>
			<SearchBar className="block md:hidden mb-4" />
		</header>
	);
}

const SORT_LABELS: Record<TProjectSortKey, string> = {
	createdAt: "Created",
	updatedAt: "Modified",
	name: "Name",
	duration: "Duration",
};

function ProjectsToolbar({ projectIds }: { projectIds: string[] }) {
	const {
		selectedProjectIds,
		sortKey,
		sortOrder,
		setSortOrder,
		setSelectedProjects,
		clearSelectedProjects,
		viewMode,
		setViewMode,
	} = useProjectsStore();

	const selectedProjectCount = selectedProjectIds.length;
	const isAllSelected =
		projectIds.length > 0 && selectedProjectCount === projectIds.length;
	const hasSomeSelected =
		selectedProjectCount > 0 && selectedProjectCount < projectIds.length;

	const handleSelectAll = ({ checked }: { checked: boolean }) => {
		if (checked) {
			setSelectedProjects({ projectIds });
			return;
		}
		clearSelectedProjects();
	};

	return (
		<div className="sticky top-16 z-10 flex items-center justify-between px-6 h-14 pt-2 bg-background">
			<div className="flex items-center gap-2">
				<Label
					className="flex items-center gap-3 cursor-pointer px-2"
					htmlFor="select-all-projects"
				>
					<Checkbox
						className="size-5"
						id="select-all-projects"
						checked={
							isAllSelected ? true : hasSomeSelected ? "indeterminate" : false
						}
						onCheckedChange={(checked) =>
							handleSelectAll({ checked: checked === true })
						}
					/>
					<span className="text-muted-foreground hidden md:block">
						Select all
					</span>
				</Label>

				<div className="h-4 w-px bg-border/50" />

				<SortDropdown>
					<Button variant="text" className="text-muted-foreground pl-2">
						{SORT_LABELS[sortKey]}
					</Button>
				</SortDropdown>
				<Button
					variant="text"
					className="text-muted-foreground"
					onClick={() =>
						setSortOrder({
							sortOrder: sortOrder === "asc" ? "desc" : "asc",
						})
					}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							setSortOrder({
								sortOrder: sortOrder === "asc" ? "desc" : "asc",
							});
						}
					}}
					aria-label={`Sort ${sortOrder === "asc" ? "ascending" : "descending"}`}
				>
					<HugeiconsIcon
						icon={ArrowDown02Icon}
						className={sortOrder === "asc" ? "rotate-180" : ""}
					/>
				</Button>

				<div className="h-4 w-px bg-border/50 block md:hidden" />

				<div className="flex md:hidden items-center gap-4">
					{VIEW_MODE_OPTIONS.map(({ mode, icon, label }) => (
						<Button
							key={mode}
							variant="text"
							onClick={() => setViewMode({ viewMode: mode })}
							aria-label={label}
						>
							<HugeiconsIcon
								icon={icon}
								className={cn(
									viewMode === mode ? "text-primary" : "text-muted-foreground",
								)}
							/>
						</Button>
					))}
				</div>
			</div>
			{selectedProjectCount > 0 ? <ProjectActions /> : null}
		</div>
	);
}

function SearchBar({
	className,
	collapsed,
}: {
	className?: string;
	collapsed?: boolean;
}) {
	const { searchQuery, setSearchQuery } = useProjectsStore();

	return (
		<>
			{collapsed ? (
				<div className="block md:hidden">
					<Button
						size="icon"
						variant="outline"
						className="size-10.5 rounded-full"
					>
						<HugeiconsIcon icon={Search01Icon} />
					</Button>
				</div>
			) : (
				<div className={cn("relative", className)}>
					<HugeiconsIcon
						icon={Search01Icon}
						className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
						aria-hidden="true"
					/>
					<Input
						placeholder="Search..."
						value={searchQuery}
						onChange={(event) => setSearchQuery({ query: event.target.value })}
						size="lg"
						className="pl-9"
					/>
				</div>
			)}
		</>
	);
}

const PROJECT_ACTIONS = [
	{
		id: "duplicate",
		label: "Duplicate",
		icon: Copy01Icon,
		variant: "outline" as const,
	},
	{
		id: "delete",
		label: "Delete",
		icon: Delete02Icon,
		variant: "destructive-foreground" as const,
	},
] as const;

async function deleteProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.deleteProjects({ ids });
}

async function duplicateProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.duplicateProjects({ ids });
}

async function renameProject({
	editor,
	id,
	name,
}: {
	editor: EditorCore;
	id: string;
	name: string;
}) {
	await editor.project.renameProject({ id, name });
}

function ProjectActions() {
	const editor = useEditor();
	const { selectedProjectIds, clearSelectedProjects } = useProjectsStore();
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	const savedProjects = editor.project.getSavedProjects();
	const selectedProjectNames = savedProjects
		.filter((project) => selectedProjectIds.includes(project.id))
		.map((project) => project.name);

	const handleDuplicate = async () => {
		await duplicateProjects({ editor, ids: selectedProjectIds });
		clearSelectedProjects();
	};

	const handleDeleteClick = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDeleteConfirm = async () => {
		await deleteProjects({ editor, ids: selectedProjectIds });
		clearSelectedProjects();
		setIsDeleteDialogOpen(false);
	};

	const actionHandlers: Record<string, () => void> = {
		duplicate: handleDuplicate,
		delete: handleDeleteClick,
	};

	return (
		<>
			<div className="flex items-center gap-2.5 px-3">
				<div className="hidden sm:flex items-center gap-2.5">
					{PROJECT_ACTIONS.map((action) => (
						<Button
							key={action.id}
							size="icon"
							variant={action.variant}
							className="size-9"
							onClick={actionHandlers[action.id]}
						>
							<HugeiconsIcon icon={action.icon} />
						</Button>
					))}
				</div>

				<DropdownMenu>
					<DropdownMenuTrigger asChild className="sm:hidden">
						<Button size="icon" variant="outline" className="size-9">
							<HugeiconsIcon icon={MoreHorizontalIcon} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{PROJECT_ACTIONS.map((action) => (
							<DropdownMenuItem
								key={action.id}
								variant={action.id === "delete" ? "destructive" : undefined}
								onClick={actionHandlers[action.id]}
							>
								<HugeiconsIcon icon={action.icon} />
								{action.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={selectedProjectNames}
				onConfirm={handleDeleteConfirm}
			/>
		</>
	);
}

function SortDropdown({ children }: { children: React.ReactNode }) {
	const { sortKey, setSortKey } = useProjectsStore();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
			<DropdownMenuContent className="w-48" align="center">
				<DropdownMenuCheckboxItem
					checked={sortKey === "createdAt"}
					onCheckedChange={() => setSortKey({ sortKey: "createdAt" })}
				>
					Created
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={sortKey === "updatedAt"}
					onCheckedChange={() => setSortKey({ sortKey: "updatedAt" })}
				>
					Modified
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={sortKey === "name"}
					onCheckedChange={() => setSortKey({ sortKey: "name" })}
				>
					Name
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={sortKey === "duration"}
					onCheckedChange={() => setSortKey({ sortKey: "duration" })}
				>
					Duration
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function UploadZipButton() {
	const editor = useEditor();
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("Upload zip");
	const fileRef = useRef<HTMLInputElement>(null);

	const handleFile = async ({ files }: { files: FileList | null }) => {
		if (!files || files.length === 0) return;
		const zip = files[0]!;
		if (fileRef.current) fileRef.current.value = "";
		setBusy(true);
		try {
			setLabel(`Mengupload ${zip.name}...`);
			const form = new FormData();
			form.append("file", zip);
			const res = await fetch("/api/uploads/batch", { method: "POST", body: form });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Upload gagal: ${zip.name}`);
			}
			const body = (await res.json()) as {
				succeeded: number;
				items: Array<{
					name: string;
					status: string;
					url: string | null;
					width: number | null;
					height: number | null;
					duration: number | null;
				}>;
			};
			const videos = body.items.filter((i) => i.status === "ok" && i.url);
			let created = 0;
			for (const [i, item] of videos.entries()) {
				setLabel(`Membuat project ${i + 1}/${videos.length}...`);
				try {
					await createProjectFromServerVideo({
						item: { ...item, url: item.url! },
						fetchFile: async (url) => {
							const r = await fetch(url);
							if (!r.ok) throw new Error(`Fetch gagal: ${item.name}`);
							const blob = await r.blob();
							const ext = item.name.slice(item.name.lastIndexOf(".")).toLowerCase();
							return new File([blob], item.name, {
								type: blob.type || (ext === ".mov" ? "video/quicktime" : `video/${ext.slice(1)}`),
							});
						},
					});
					created += 1;
				} catch (error) {
					console.error("Batch: create project failed", item.name, error);
				}
			}
			await editor.project.loadAllProjects();
			if (created === 0) throw new Error("Tidak ada project yang berhasil dibuat");
			toast.success(`${created} project dibuat dari ${zip.name}`);
		} catch (error) {
			console.error("Batch: upload zip failed", error);
			toast.error(error instanceof Error ? error.message : "Upload zip gagal");
		} finally {
			setBusy(false);
			setLabel("Upload zip");
		}
	};

	return (
		<>
			<input
				ref={fileRef}
				type="file"
				accept=".zip"
				className="hidden"
				onChange={(e) => void handleFile({ files: e.target.files })}
			/>
			<Button
				size="lg"
				variant="secondary"
				className="flex px-5 md:px-6"
				disabled={busy}
				onClick={() => fileRef.current?.click()}
			>
				<span className="text-sm font-medium hidden md:block">{label}</span>
				<span className="text-sm font-medium block md:hidden">Zip</span>
			</Button>
		</>
	);
}

/**
 * Jalur ANTRIAN (Tahap 1). Berbeda dari "Upload zip" di atas yang langsung
 * mengekstrak di browser, tombol ini hanya MENCATAT batch ke database lalu
 * menyerahkan pekerjaan ke worker (Tahap 2). Sengaja terpisah supaya kedua
 * jalur bisa dibandingkan tanpa mengubah perilaku yang lama.
 *
 * Setelah berhasil, job akan tetap berstatus "queued" — memang belum ada
 * yang mengerjakannya sampai Tahap 2 selesai.
 */
function QueueBatchButton() {
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("Antrikan batch");
	// Radix Select menolak value string kosong, jadi "tanpa template"
	// diwakili sentinel dan diterjemahkan saat mengirim.
	const NO_TEMPLATE = "__none__";
	const [templateId, setTemplateId] = useState<string>(NO_TEMPLATE);
	// Caption untuk SEMUA video di batch. Kosong = posting tanpa caption.
	const [caption, setCaption] = useState("");
	const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	// Template dimuat sekali saat mount. Kegagalan di sini tidak menghalangi:
	// batch tetap bisa diantrikan tanpa template.
	useEffect(() => {
		fetch("/api/klip/brand-templates")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: unknown) => {
				const list = (body as { templates?: Array<{ id: string; name: string }> } | null)
					?.templates;
				if (Array.isArray(list)) setTemplates(list);
			})
			.catch(() => {});
	}, []);

	const handleFile = async ({ files }: { files: FileList | null }) => {
		if (!files || files.length === 0) return;
		const zip = files[0]!;
		if (fileRef.current) fileRef.current.value = "";
		setBusy(true);
		try {
			setLabel(`Mengantrikan ${zip.name}...`);
			const form = new FormData();
			form.append("file", zip);
			// Template dipilih user, bukan ditebak. Kosong = pakai default global
			// di klip_settings saat worker mengerjakan.
			if (templateId && templateId !== NO_TEMPLATE) {
				form.append("templateId", templateId);
			}
			if (caption.trim()) form.append("caption", caption.trim());
			const res = await fetch("/api/klip/batches", { method: "POST", body: form });
			const body = (await res.json().catch(() => null)) as
				| { batchId?: string; jobCount?: number; templateId?: string | null; error?: string }
				| null;
			if (!res.ok) {
				throw new Error(body?.error ?? `Gagal antri: ${zip.name}`);
			}
			toast.success(
				`Batch ${body?.batchId} masuk antrian (${body?.jobCount ?? 0} job)${
					body?.templateId ? " + template" : " tanpa template"
				}. Menunggu worker.`,
			);
		} catch (error) {
			console.error("Batch: queue failed", error);
			toast.error(error instanceof Error ? error.message : "Gagal antri batch");
		} finally {
			setBusy(false);
			setLabel("Antrikan batch");
		}
	};

	return (
		<>
			<input
				ref={fileRef}
				type="file"
				accept=".zip"
				className="hidden"
				onChange={(e) => void handleFile({ files: e.target.files })}
			/>
			<Input
				value={caption}
				onChange={(e) => setCaption(e.target.value)}
				placeholder="Caption IG (opsional)"
				className="hidden w-[200px] md:block"
				maxLength={2200}
				aria-label="Caption Instagram"
			/>
			{templates.length > 0 && (
				<Select value={templateId} onValueChange={setTemplateId}>
					<SelectTrigger size="sm" className="w-[150px]" aria-label="Template">
						<SelectValue placeholder="Tanpa template" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NO_TEMPLATE}>Tanpa template</SelectItem>
						{templates.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<Button
				size="lg"
				variant="outline"
				className="flex px-5 md:px-6"
				disabled={busy}
				onClick={() => fileRef.current?.click()}
			>
				<span className="text-sm font-medium hidden md:block">{label}</span>
				<span className="text-sm font-medium block md:hidden">Antri</span>
			</Button>
		</>
	);
}

interface ServerProjectMeta {
	id: string;
	name: string;
	updatedAt: string;
	/** Id job yang punya berkas MP4 hasil render, kalau sudah dirender. */
	renderJobId: string | null;
}

function ServerProjectsSection({ localIds }: { localIds: string[] }) {
	const router = useRouter();
	const [items, setItems] = useState<ServerProjectMeta[] | null>(null);
	const [opening, setOpening] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/sync/projects")
			.then((res) => {
				if (!res.ok) throw new Error(`Sync status ${res.status}`);
				return res.json();
			})
			.then((body: unknown) => {
				const rec =
					typeof body === "object" && body !== null && !Array.isArray(body)
						? Object.fromEntries(Object.entries(body))
						: null;
				const list = rec?.["projects"];
				if (!Array.isArray(list)) {
					setItems([]);
					return;
				}
				setItems(
					list.flatMap((raw): ServerProjectMeta[] => {
						if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
						const r = Object.fromEntries(Object.entries(raw));
						if (typeof r["id"] !== "string" || typeof r["name"] !== "string") return [];
						return [
							{
								id: r["id"],
								name: r["name"],
								updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
								renderJobId:
									typeof r["renderJobId"] === "string" ? r["renderJobId"] : null,
							},
						];
					}),
				);
			})
			.catch((error: unknown) => {
				console.warn("Gagal memuat daftar server:", error);
				setItems([]);
			});
	}, []);

	if (items === null) return null;
	const onlyServer = items.filter((s) => !localIds.includes(s.id));
	if (onlyServer.length === 0) return null;

	const handleOpen = async ({ id }: { id: string }) => {
		if (opening) return;
		setOpening(id);
		try {
			const { pullProject } = await import("@/klip/sync");
			await pullProject({ id });
			router.push(`/editor/${id}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Gagal menarik dari server");
			setOpening(null);
		}
	};

	const handleDelete = async ({ id, name }: { id: string; name: string }) => {
		if (!confirm(`Hapus "${name}" dari server? File media ikut terhapus. Tidak bisa dibatalkan.`)) {
			return;
		}
		try {
			const res = await fetch(`/api/sync/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!res.ok) throw new Error(`Hapus gagal: ${res.status}`);
			setItems((prev) => (prev ?? []).filter((s) => s.id !== id));
			toast.success(`"${name}" dihapus dari server`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Hapus gagal");
		}
	};

	const handleDeleteAll = async ({ count }: { count: number }) => {
		if (
			!confirm(
				`Hapus SEMUA ${count} project dari server beserta medianya? Tidak bisa dibatalkan.`,
			)
		) {
			return;
		}
		let ok = 0;
		let failed = 0;
		for (const s of items ?? []) {
			try {
				const res = await fetch(`/api/sync/projects/${encodeURIComponent(s.id)}`, {
					method: "DELETE",
				});
				if (!res.ok) throw new Error(`Hapus gagal: ${res.status}`);
				ok += 1;
				setItems((prev) => (prev ?? []).filter((x) => x.id !== s.id));
			} catch (error) {
				failed += 1;
				console.warn(`Hapus ${s.name} gagal:`, error);
			}
		}
		if (failed === 0) {
			toast.success(`${ok} project dihapus dari server. Fresh!`);
		} else {
			toast.warning(`${ok} terhapus, ${failed} gagal. Coba Hapus semua lagi.`);
		}
	};

	return (
		<div className="flex flex-col gap-2 px-4">
			<div className="flex items-center justify-between">
				<p className="text-sm font-medium">Di server ({onlyServer.length})</p>
				<Button size="sm" variant="destructive" onClick={() => void handleDeleteAll({ count: onlyServer.length })}>
					Hapus semua
				</Button>
			</div>
			{onlyServer.map((s) => (
				<Card key={s.id}>
					<CardContent className="flex items-center gap-3 py-3">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">{s.name}</p>
							<p className="text-muted-foreground text-xs">
								Hanya ada di server — klik Buka untuk menarik ke browser ini
							</p>
						</div>
						{s.renderJobId && (
							<a
								href={`/api/klip/batch-jobs/${encodeURIComponent(s.renderJobId)}/video`}
								download
								className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
							>
								Unduh MP4
							</a>
						)}
						<Button
							size="sm"
							variant="outline"
							disabled={opening === s.id}
							onClick={() => void handleOpen({ id: s.id })}
						>
							{opening === s.id ? "Menarik..." : "Buka"}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => void handleDelete({ id: s.id, name: s.name })}
						>
							Hapus
						</Button>
					</CardContent>
				</Card>
			))}
		</div>
	);
}

function SyncUploadButton() {
	const [busy, setBusy] = useState(false);

	const handleUpload = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const { pushProject } = await import("@/klip/sync");
			const { storageService } = await import("@/services/storage/service");
			const metas = await storageService.loadAllProjectsMetadata();
			let ok = 0;
			const failed: string[] = [];
			let firstError = "";
			for (const meta of metas) {
				try {
					await pushProject({ id: meta.id });
					ok += 1;
				} catch (error) {
					failed.push(meta.name);
					const message = error instanceof Error ? error.message : String(error);
					if (!firstError) firstError = message;
					console.warn(`Upload ${meta.name} gagal:`, error);
				}
			}
			if (failed.length === 0) {
				toast.success(`${ok} project terupload ke server`);
			} else {
				toast.warning(`${ok} terupload, ${failed.length} gagal: ${failed.join(", ")}`, {
					description: firstError ? `Contoh error: ${firstError.slice(0, 300)}` : undefined,
					duration: 15000,
				});
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Button variant="outline" size="sm" disabled={busy} onClick={() => void handleUpload()}>
			<span className="text-sm font-medium hidden md:block">
				{busy ? "Mengupload..." : "Upload ke server"}
			</span>
		</Button>
	);
}

function LogoutButton() {
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => {
				void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
					window.location.href = "/";
				});
			}}
		>
			<span className="text-sm font-medium hidden md:block">Keluar</span>
		</Button>
	);
}

function NewProjectButton() {
	const editor = useEditor();
	const router = useRouter();

	const handleCreateProject = async () => {
		const projectId = await editor.project.createNewProject({
			name: "New project",
		});
		router.push(`/editor/${projectId}`);
	};

	return (
		<Button
			size="lg"
			className="flex px-5 md:px-6"
			onClick={handleCreateProject}
		>
			<span className="text-sm font-medium hidden md:block">New project</span>
			<span className="text-sm font-medium block md:hidden">New</span>
		</Button>
	);
}

function ProjectItem({
	project,
	allProjectIds,
}: {
	project: TProjectMetadata;
	allProjectIds: string[];
}) {
	const {
		selectedProjectIds,
		viewMode,
		setProjectSelected,
		selectProjectRange,
	} = useProjectsStore();
	const selectedProjectIdSet = new Set(selectedProjectIds);
	const isSelected = selectedProjectIdSet.has(project.id);
	const selectedProjectCount = selectedProjectIds.length;
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isInfoDialogOpen, setIsInfoDialogOpen] = useState(false);
	const editor = useEditor();
	const durationLabel = formatProjectDuration({ duration: project.duration });
	const isMultiSelect = selectedProjectCount > 1;
	const isGridView = viewMode === "grid";

	const handleRename = () => setIsRenameDialogOpen(true);
	const handleDuplicate = async () => {
		await duplicateProjects({ editor, ids: [project.id] });
	};
	const handleDeleteClick = () => setIsDeleteDialogOpen(true);
	const handleInfoClick = () => setIsInfoDialogOpen(true);
	const handleDeleteConfirm = async () => {
		await deleteProjects({ editor, ids: [project.id] });
		setIsDeleteDialogOpen(false);
	};

	const handleCheckboxChange = ({
		checked,
		shiftKey,
	}: {
		checked: boolean;
		shiftKey: boolean;
	}) => {
		if (shiftKey && checked) {
			selectProjectRange({ projectId: project.id, allProjectIds });
			return;
		}
		setProjectSelected({ projectId: project.id, isSelected: checked });
	};

	const gridContent = (
		<Card className="bg-background overflow-hidden border-none p-0">
			<div className="bg-muted relative aspect-video">
				<div className="absolute inset-0">
					{project.thumbnail ? (
						<Image
							src={project.thumbnail}
							alt="Project thumbnail"
							fill
							className="object-cover"
						/>
					) : (
						<div className="flex size-full items-center justify-center">
							<OcVideoIcon className="text-muted-foreground size-12 shrink-0" />
						</div>
					)}
				</div>

				{durationLabel && (
					<div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs font-semibold px-2 py-1 rounded-sm">
						{durationLabel}
					</div>
				)}
			</div>

			<CardContent className="flex flex-col gap-2 px-0 pt-4">
				<h3 className="group-hover:text-foreground/90 line-clamp-2 text-sm leading-snug font-medium">
					{project.name}
				</h3>
				<div className="text-muted-foreground flex items-center gap-1.5 text-sm">
					<HugeiconsIcon icon={Calendar04Icon} className="size-4" />
					<span>Created {formatDate({ date: project.createdAt })}</span>
				</div>
			</CardContent>
		</Card>
	);

	const listRowContent = (
		<div className="flex items-center gap-3 flex-1 min-w-0">
			<div className="bg-muted relative size-10 rounded overflow-hidden shrink-0">
				{project.thumbnail ? (
					<Image
						src={project.thumbnail}
						alt="Project thumbnail"
						fill
						className="object-cover"
					/>
				) : (
					<div className="flex size-full items-center justify-center">
						<OcVideoIcon className="text-muted-foreground size-5 shrink-0" />
					</div>
				)}
			</div>

			<h3 className="group-hover:text-foreground/90 text-sm font-medium truncate flex-1 min-w-0">
				{project.name}
			</h3>

			<span className="text-muted-foreground text-sm shrink-0 hidden sm:block">
				{durationLabel ?? "—"}
			</span>

			<span className="text-muted-foreground text-sm shrink-0 w-auto pl-8 text-right hidden xs:block">
				{formatDate({ date: project.createdAt })}
			</span>
		</div>
	);

	const listContent = (
		<div
			className={`flex items-center gap-4 py-2 px-4 border-b border-border/50 ${
				isSelected ? "bg-primary/5" : ""
			}`}
		>
			<Checkbox
				checked={isSelected}
				onMouseDown={(event) => event.preventDefault()}
				onClick={(event) => {
					handleCheckboxChange({
						checked: !isSelected,
						shiftKey: event.shiftKey,
					});
				}}
				onCheckedChange={() => {}}
				className="size-5 shrink-0"
			/>

			<Link href={`/editor/${project.id}`} className="flex-1 min-w-0">
				{listRowContent}
			</Link>

			{!isMultiSelect && (
				<ProjectMenu
					isOpen={isDropdownOpen}
					onOpenChange={setIsDropdownOpen}
					variant="list"
					onRenameClick={handleRename}
					onDuplicateClick={handleDuplicate}
					onDeleteClick={handleDeleteClick}
					onInfoClick={handleInfoClick}
				/>
			)}
		</div>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div className="group relative">
						{isGridView ? (
							<>
								<Link href={`/editor/${project.id}`} className="block">
									{gridContent}
								</Link>

								<Checkbox
									checked={isSelected}
									onMouseDown={(event) => event.preventDefault()}
									onClick={(event) => {
										handleCheckboxChange({
											checked: !isSelected,
											shiftKey: event.shiftKey,
										});
									}}
									onCheckedChange={() => {}}
									className={`absolute z-10 size-5 top-3 left-3 ${
										isSelected || isDropdownOpen
											? "opacity-100"
											: "opacity-0 group-hover:opacity-100"
									}`}
								/>

								{!isMultiSelect && (
									<ProjectMenu
										isOpen={isDropdownOpen}
										onOpenChange={setIsDropdownOpen}
										onRenameClick={handleRename}
										onDuplicateClick={handleDuplicate}
										onDeleteClick={handleDeleteClick}
										onInfoClick={handleInfoClick}
									/>
								)}
							</>
						) : (
							listContent
						)}
					</div>
				</ContextMenuTrigger>
				<ProjectContextMenuContent
					onRenameClick={handleRename}
					onDuplicateClick={handleDuplicate}
					onDeleteClick={handleDeleteClick}
					onInfoClick={handleInfoClick}
				/>
			</ContextMenu>

			<RenameProjectDialog
				isOpen={isRenameDialogOpen}
				onOpenChange={setIsRenameDialogOpen}
				projectName={project.name}
				onConfirm={async (newName) => {
					await renameProject({ editor, id: project.id, name: newName });
					setIsRenameDialogOpen(false);
				}}
			/>

			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={[project.name]}
				onConfirm={handleDeleteConfirm}
			/>

			<ProjectInfoDialog
				isOpen={isInfoDialogOpen}
				onOpenChange={setIsInfoDialogOpen}
				project={project}
			/>
		</>
	);
}

function ProjectContextMenuContent({
	onRenameClick,
	onDuplicateClick,
	onDeleteClick,
	onInfoClick,
}: {
	onRenameClick: () => void;
	onDuplicateClick: () => void;
	onDeleteClick: () => void;
	onInfoClick: () => void;
}) {
	return (
		<ContextMenuContent>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={Edit03Icon} />}
				onClick={onRenameClick}
			>
				Rename
			</ContextMenuItem>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={Copy01Icon} />}
				onClick={onDuplicateClick}
			>
				Duplicate
			</ContextMenuItem>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={InformationCircleIcon} />}
				onClick={onInfoClick}
			>
				Info
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				variant="destructive"
				icon={<HugeiconsIcon icon={Delete02Icon} />}
				onClick={onDeleteClick}
			>
				Delete
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

function ProjectMenu({
	isOpen,
	onOpenChange,
	variant = "grid",
	onRenameClick,
	onDuplicateClick,
	onDeleteClick,
	onInfoClick,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	variant?: "grid" | "list";
	onRenameClick: () => void;
	onDuplicateClick: () => void;
	onDeleteClick: () => void;
	onInfoClick: () => void;
}) {
	const handleMenuClick = ({
		event,
	}: {
		event: MouseEvent<HTMLButtonElement>;
	}) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const handleMenuKeyDown = ({
		event,
	}: {
		event: KeyboardEvent<HTMLButtonElement>;
	}) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	const handleRename = () => {
		onRenameClick();
		onOpenChange(false);
	};

	const handleDuplicate = () => {
		onDuplicateClick();
		onOpenChange(false);
	};

	const handleDeleteClick = () => {
		onDeleteClick();
		onOpenChange(false);
	};

	const handleInfoClick = () => {
		onInfoClick();
		onOpenChange(false);
	};

	const isGrid = variant === "grid";

	return (
		<DropdownMenu open={isOpen} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="background"
					className={
						isGrid
							? `absolute z-10 top-3 right-3 ${isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
							: "!bg-transparent !shadow-none"
					}
					size="icon"
					aria-label="Project menu"
					onClick={(event) =>
						handleMenuClick({
							event: event as unknown as MouseEvent<HTMLButtonElement>,
						})
					}
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) =>
						handleMenuKeyDown({
							event: event as unknown as KeyboardEvent<HTMLButtonElement>,
						})
					}
				>
					<HugeiconsIcon
						icon={MoreHorizontalIcon}
						className="text-foreground"
						aria-hidden="true"
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-48" align="end">
				<DropdownMenuItem onClick={handleRename}>
					<HugeiconsIcon icon={Edit03Icon} />
					Rename
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleDuplicate}>
					<HugeiconsIcon icon={Copy01Icon} />
					Duplicate
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleInfoClick}>
					<HugeiconsIcon icon={InformationCircleIcon} />
					Info
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" onClick={handleDeleteClick}>
					<HugeiconsIcon icon={Delete02Icon} />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ProjectsSkeleton() {
	const skeletonIds = Array.from(
		{ length: 24 },
		(_, index) => `skeleton-${index}`,
	);

	return (
		<div className="px-4 xs:grid-cols-2 grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4">
			{skeletonIds.map((skeletonId) => (
				<Card
					key={skeletonId}
					className="bg-background overflow-hidden border-none p-0"
				>
					<div className="bg-muted relative aspect-video">
						<div className="absolute inset-0">
							<Skeleton className="bg-muted/50 size-full" />
						</div>
					</div>
					<CardContent className="flex flex-col gap-2 px-0 pt-4">
						<Skeleton className="bg-muted/50 h-4 w-3/4" />
						<div className="text-muted-foreground flex items-center gap-1.5">
							<Skeleton className="bg-muted/50 size-4" />
							<Skeleton className="bg-muted/50 h-4 w-24" />
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	);
}

function EmptyState() {
	const { searchQuery, setSearchQuery } = useProjectsStore();
	const router = useRouter();
	const editor = useEditor();
	const savedProjects = editor.project.getSavedProjects();

	const handleCreateProject = async () => {
		try {
			const projectId = await editor.project.createNewProject({
				name: "New project",
			});
			router.push(`/editor/${projectId}`);
		} catch (error) {
			toast.error("Failed to create project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	if (savedProjects.length > 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-5 py-16 text-center">
				<div className="flex flex-col items-center gap-8">
					<HugeiconsIcon
						icon={Search01Icon}
						className="text-muted-foreground size-16 bg-accent/35 border rounded-md p-4"
					/>
					<div className="flex flex-col items-center gap-3">
						<h3 className="text-lg font-medium">No results found</h3>
						<p className="text-muted-foreground max-w-md">
							Your search for "{searchQuery}" did not return any results.
						</p>
					</div>
				</div>
				<Button
					onClick={() => setSearchQuery({ query: "" })}
					variant="outline"
					size="lg"
				>
					Clear search
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center gap-6 py-16 text-center">
			<div className="flex flex-col items-center gap-2">
				<div className="bg-muted/30 flex size-16 items-center justify-center rounded-full">
					<HugeiconsIcon
						icon={Video01Icon}
						className="text-muted-foreground size-8"
					/>
				</div>
				<h3 className="text-lg font-medium">No projects yet</h3>
				<p className="text-muted-foreground max-w-md">
					Start creating your first project. Import media, edit, and export your
					videos. All privately.
				</p>
			</div>
			<Button size="lg" className="gap-2" onClick={handleCreateProject}>
				<HugeiconsIcon icon={PlusSignIcon} />
				Create your first project
			</Button>
		</div>
	);
}
