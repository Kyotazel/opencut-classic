"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

/**
 * Setelan default: template brand dan akun Instagram tujuan.
 *
 * KENAPA ADA: dua nilai ini dulu hanya bisa diubah lewat terminal
 * (`bun run klip:setting`). Tanpa halaman ini, worker sering berhenti di
 * tahap "no_ig_account" - bukan karena error, tapi karena akun tujuannya
 * belum pernah diatur dan tidak ada cara mengaturnya dari UI.
 */

type Pilihan = { id: string; name: string };
type Akun = { id: string; username: string; status: string };

/** Nilai kosong dipakai untuk "tidak diatur" - Select tidak menerima "". */
const TIDAK_DIATUR = "__kosong__";

export default function SettingsPage() {
	const [templates, setTemplates] = useState<Pilihan[]>([]);
	const [accounts, setAccounts] = useState<Akun[]>([]);
	const [templateId, setTemplateId] = useState(TIDAK_DIATUR);
	const [igAccountId, setIgAccountId] = useState(TIDAK_DIATUR);
	const [ambang, setAmbang] = useState("2");
	/**
	 * Nilai yang sedang tersimpan di server, untuk membandingkan saat menyimpan.
	 *
	 * KENAPA PERLU: tombol Simpan dulu mengirim KETIGA nilai tanpa syarat. Kalau
	 * salah satu <Select> gagal menampilkan nilai tersimpan - misalnya id-nya
	 * tidak ada lagi di daftar pilihan - nilainya menjadi kosong, dan menekan
	 * Simpan akan MENGHAPUS setelan itu tanpa peringatan apa pun.
	 *
	 * Dengan membandingkan, menekan Simpan tanpa mengubah apa pun tidak menulis
	 * apa-apa. Perubahan hanya terjadi kalau kamu memang mengubahnya.
	 */
	const [tersimpan, setTersimpan] = useState<{
		template: string;
		ig: string;
		ambang: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [menyimpan, setMenyimpan] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pesan, setPesan] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const res = await fetch("/api/klip/settings", { cache: "no-store" });
			const body = (await res.json()) as {
				settings?: {
					defaultTemplateId: string;
					defaultIgAccountId: string;
					publishFailureThreshold: string;
				};
				templates?: Pilihan[];
				accounts?: Akun[];
				error?: string;
			};
			if (!res.ok) throw new Error(body.error ?? "Gagal memuat setelan");
			setTemplates(body.templates ?? []);
			setAccounts(body.accounts ?? []);
			const tpl = body.settings?.defaultTemplateId || TIDAK_DIATUR;
			const ig = body.settings?.defaultIgAccountId || TIDAK_DIATUR;
			const amb = body.settings?.publishFailureThreshold ?? "2";
			setTemplateId(tpl);
			setIgAccountId(ig);
			setAmbang(amb);
			setTersimpan({ template: tpl, ig, ambang: amb });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Gagal memuat setelan");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const simpan = async () => {
		setMenyimpan(true);
		setError(null);
		setPesan(null);
		try {
			// Hanya key yang BERUBAH yang dikirim. Menekan Simpan tanpa mengubah
			// apa pun jadi tidak menulis apa-apa - jadi nilai yang gagal tampil
			// di salah satu pilihan tidak pernah menghapus setelan tersimpan.
			const patch: Record<string, string> = {};
			if (!tersimpan || templateId !== tersimpan.template) {
				patch.default_template_id =
					templateId === TIDAK_DIATUR ? "" : templateId;
			}
			if (!tersimpan || igAccountId !== tersimpan.ig) {
				patch.default_ig_account_id =
					igAccountId === TIDAK_DIATUR ? "" : igAccountId;
			}
			if (!tersimpan || ambang !== tersimpan.ambang) {
				patch.publish_failure_threshold = ambang;
			}
			if (Object.keys(patch).length === 0) {
				setPesan("Tidak ada perubahan.");
				return;
			}
			const res = await fetch("/api/klip/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			const body = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(body.error ?? "Gagal menyimpan");
			// Muat ulang supaya nilai acuan ikut diperbarui.
			await load();
			setPesan("Setelan tersimpan.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Gagal menyimpan");
		} finally {
			setMenyimpan(false);
		}
	};

	if (loading) {
		return <p className="text-muted-foreground p-6 text-sm">Memuat setelan...</p>;
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
			<div>
				<h1 className="text-lg font-semibold">Setelan batch</h1>
				<p className="text-muted-foreground text-sm">
					Nilai default yang dipakai worker saat memproses ZIP. Tanpa akun
					Instagram tujuan, video hanya dirender dan TIDAK diposting.
				</p>
			</div>

			{error && <p className="text-destructive text-sm">{error}</p>}
			{pesan && <p className="text-sm text-emerald-600">{pesan}</p>}

			<div className="flex flex-col gap-2">
				<Label htmlFor="ig">Akun Instagram tujuan</Label>
				<Select value={igAccountId} onValueChange={setIgAccountId}>
					<SelectTrigger id="ig">
						<SelectValue placeholder="Pilih akun" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={TIDAK_DIATUR}>
							(tidak diatur - publish dilewati)
						</SelectItem>
						{accounts.map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.username}
								{a.status !== "active" ? ` (${a.status})` : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Tanpa akun, worker berhenti di tahap "no_ig_account" dan video
					tidak tayang. Ini bukan error - memang belum ada tujuannya.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor="tpl">Template brand</Label>
				<Select value={templateId} onValueChange={setTemplateId}>
					<SelectTrigger id="tpl">
						<SelectValue placeholder="Pilih template" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={TIDAK_DIATUR}>
							(tidak diatur - project tanpa template)
						</SelectItem>
						{templates.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor="ambang">Ambang penghentian batch</Label>
				<Select value={ambang} onValueChange={setAmbang}>
					<SelectTrigger id="ambang">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{[1, 2, 3, 4, 5].map((n) => (
							<SelectItem key={n} value={String(n)}>
								{n} kegagalan berturut-turut
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Batch dihentikan setelah sekian kegagalan berturut-turut, supaya
					template yang salah tidak mengirim puluhan video sekaligus.
				</p>
			</div>

			<div>
				<Button onClick={() => void simpan()} disabled={menyimpan}>
					{menyimpan ? "Menyimpan..." : "Simpan"}
				</Button>
			</div>
		</div>
	);
}
