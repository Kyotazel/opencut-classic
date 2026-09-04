"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { FaInstagram } from "react-icons/fa6";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/utils/date";
import { cn } from "@/utils/ui";

interface IgAccount {
	id: string;
	igUserId: string;
	username: string;
	profilePicUrl: string | null;
	status: "active" | "token_expired" | "disconnected";
	tokenExpiresAt: string | null;
}

const STATUS_LABEL: Record<IgAccount["status"], string> = {
	active: "Aktif",
	token_expired: "Token expired",
	disconnected: "Terputus",
};

function asRecord({ value }: { value: unknown }): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

function parseAccount({ value }: { value: unknown }): IgAccount | null {
	const r = asRecord({ value });
	if (!r || typeof r["id"] !== "string" || typeof r["username"] !== "string") return null;
	const status = r["status"];
	return {
		id: r["id"],
		igUserId: typeof r["igUserId"] === "string" ? r["igUserId"] : "",
		username: r["username"],
		profilePicUrl: typeof r["profilePicUrl"] === "string" ? r["profilePicUrl"] : null,
		status:
			status === "active" ? "active" : status === "token_expired" ? "token_expired" : "disconnected",
		tokenExpiresAt: typeof r["tokenExpiresAt"] === "string" ? r["tokenExpiresAt"] : null,
	};
}

function InstagramAccounts() {
	const searchParams = useSearchParams();
	const [accounts, setAccounts] = useState<IgAccount[]>([]);
	const [loading, setLoading] = useState(true);
	const [disconnecting, setDisconnecting] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/klip/ig-accounts")
			.then((res) => {
				if (!res.ok) throw new Error(`Gagal memuat akun: ${res.status}`);
				return res.json();
			})
			.then((body: unknown) => {
				const rec = asRecord({ value: body });
				const list = rec?.["accounts"];
				setAccounts(
					(Array.isArray(list) ? list : []).flatMap((raw) => {
						const acc = parseAccount({ value: raw });
						return acc ? [acc] : [];
					}),
				);
			})
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Gagal memuat akun");
			})
			.finally(() => {
				setLoading(false);
			});
	}, []);

	useEffect(() => {
		if (searchParams.get("connected") === "1") {
			toast.success("Akun Instagram terhubung");
			window.history.replaceState(null, "", "/instagram");
		}
	}, [searchParams]);

	const reload = () =>
		fetch("/api/klip/ig-accounts")
			.then((res) => {
				if (!res.ok) throw new Error(`Gagal memuat akun: ${res.status}`);
				return res.json();
			})
			.then((body: unknown) => {
				const rec = asRecord({ value: body });
				const list = rec?.["accounts"];
				setAccounts(
					(Array.isArray(list) ? list : []).flatMap((raw) => {
						const acc = parseAccount({ value: raw });
						return acc ? [acc] : [];
					}),
				);
			})
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Gagal memuat akun");
			});

	const handleDisconnect = async ({ id, username }: { id: string; username: string }) => {
		if (!confirm(`Putuskan @${username}? Riwayat publish tetap tersimpan.`)) return;
		setDisconnecting(id);
		try {
			const res = await fetch(`/api/klip/ig-accounts/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error(`Gagal memutuskan: ${res.status}`);
			toast.success(`@${username} diputus`);
			await reload();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Gagal memutuskan");
		} finally {
			setDisconnecting(null);
		}
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-4 py-6">
			<Breadcrumb className="mb-4">
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink asChild>
							<Link href="/projects">Home</Link>
						</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbItem>
						<BreadcrumbPage>Instagram accounts</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">Instagram accounts</h1>
					<p className="text-muted-foreground text-sm">
						Hubungkan banyak akun. Satu login = satu akun; ulangi untuk menambah lagi.
					</p>
				</div>
				<Button
					onClick={() => {
						window.location.href = "/api/klip/ig-accounts/authorize";
					}}
				>
					<FaInstagram className="size-4" />
					Hubungkan Instagram
				</Button>
			</div>
			{loading ? (
				<div className="space-y-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : accounts.length === 0 ? (
				<Card>
					<CardContent className="py-10 text-center">
						<FaInstagram className="text-muted-foreground mx-auto mb-3 size-8" />
						<p className="text-muted-foreground text-sm">
							Belum ada akun terhubung. Klik Hubungkan Instagram untuk login.
						</p>
					</CardContent>
				</Card>
			) : (
				<div className="space-y-3">
					{accounts.map((a) => (
						<Card key={a.id}>
							<CardContent className="flex items-center gap-3 py-4">
								<Avatar>
									{a.profilePicUrl && <AvatarImage src={a.profilePicUrl} alt={a.username} />}
									<AvatarFallback>@</AvatarFallback>
								</Avatar>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">@{a.username}</p>
									<p className="text-muted-foreground text-xs">
										{a.tokenExpiresAt ? `Token s/d ${formatDate({ date: new Date(a.tokenExpiresAt) })}` : "Token tanpa expiry"}
									</p>
								</div>
								<span
									className={cn(
										"rounded-full px-2.5 py-0.5 text-xs font-medium",
										a.status === "active" && "bg-emerald-500/15 text-emerald-500",
										a.status === "token_expired" && "bg-amber-500/15 text-amber-500",
										a.status === "disconnected" && "bg-zinc-500/15 text-zinc-400",
									)}
								>
									{STATUS_LABEL[a.status]}
								</span>
								{a.status === "token_expired" ? (
									<Button
										size="sm"
										onClick={() => {
											window.location.href = "/api/klip/ig-accounts/authorize";
										}}
									>
										Reconnect
									</Button>
								) : (
									a.status === "active" && (
										<Button
											size="sm"
											variant="outline"
											disabled={disconnecting === a.id}
											onClick={() => void handleDisconnect({ id: a.id, username: a.username })}
										>
											{disconnecting === a.id ? "..." : "Disconnect"}
										</Button>
									)
								)}
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}

export default function InstagramPage() {
	return (
		<Suspense>
			<InstagramAccounts />
		</Suspense>
	);
}
