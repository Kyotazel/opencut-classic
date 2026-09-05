"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function readLoginError({ res }: { res: Response }): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return `Login gagal: ${res.status}`;
		}
		const err = Object.fromEntries(Object.entries(body))["error"];
		return typeof err === "string" ? err : `Login gagal: ${res.status}`;
	} catch {
		return `Login gagal: ${res.status}`;
	}
}

export default function LoginPage() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (busy) return;
		// Baca dari FormData (bukan state): autofill browser tidak memicu
		// onChange sehingga state bisa kosong padahal field terlihat terisi.
		const form = new FormData(e.currentTarget);
		const username = String(form.get("username") ?? "");
		const password = String(form.get("password") ?? "");
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			if (!res.ok) {
				throw new Error(await readLoginError({ res }));
			}
			window.location.href = "/projects";
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login gagal");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="bg-background flex min-h-screen items-center justify-center px-4">
			<Card className="w-full max-w-sm">
				<CardContent className="space-y-4 py-6">
					<div>
						<h1 className="text-xl font-semibold">Masuk</h1>
						<p className="text-muted-foreground text-sm">Klip Studio — akses internal.</p>
					</div>
					<form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
						<div className="space-y-1">
							<Label htmlFor="username">Username</Label>
							<Input
								id="username"
								name="username"
								autoComplete="username"
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
							/>
						</div>
						{error && <p className="text-sm text-red-500">{error}</p>}
						<Button type="submit" className="w-full" disabled={busy}>
							{busy ? "Memeriksa..." : "Masuk"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
