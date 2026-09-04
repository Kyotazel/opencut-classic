"use client";

import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useEditor } from "@/editor/use-editor";

export function SyncConflictDialog() {
	const editor = useEditor();
	const conflict = useEditor((e) => e.project.getSyncConflict());
	const [busy, setBusy] = useState(false);

	if (!conflict) return null;

	const resolve = async ({ choice }: { choice: "overwrite" | "reload" }) => {
		if (busy) return;
		setBusy(true);
		try {
			await editor.project.resolveSyncConflict({ choice });
		} finally {
			setBusy(false);
		}
	};

	return (
		<AlertDialog open>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Server menyimpan versi lebih baru</AlertDialogTitle>
					<AlertDialogDescription>
						Project ini diubah dari tempat lain. Timpa server dengan versi yang sedang kamu
						edit, atau muat versi server (perubahan lokal yang belum sync akan hilang).
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						disabled={busy}
						onClick={() => void resolve({ choice: "reload" })}
					>
						Muat dari server
					</AlertDialogCancel>
					<AlertDialogAction disabled={busy} onClick={() => void resolve({ choice: "overwrite" })}>
						{busy ? "Memproses..." : "Timpa server"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
