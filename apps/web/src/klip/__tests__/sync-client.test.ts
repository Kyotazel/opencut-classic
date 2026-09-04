import { describe, expect, test } from "bun:test";
import { SyncConflictError, getSyncBase, setSyncBase } from "@/klip/sync";

describe("sync client base", () => {
	test("aman tanpa localStorage (bun env)", () => {
		expect(getSyncBase({ id: "x" })).toBeNull();
		expect(() => setSyncBase({ id: "x", updatedAt: "y" })).not.toThrow();
	});
	test("SyncConflictError bawa serverUpdatedAt", () => {
		const err = new SyncConflictError({ serverUpdatedAt: "2026-01-01" });
		expect(err.serverUpdatedAt).toBe("2026-01-01");
		expect(err).toBeInstanceOf(Error);
	});
});
