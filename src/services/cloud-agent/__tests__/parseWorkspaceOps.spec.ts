import { describe, expect, it } from "vitest"

import { parseWorkspaceOps, WORKSPACE_OPS_MAX_BODY_CHARS, WORKSPACE_OPS_MAX_COUNT } from "../parseWorkspaceOps"

describe("parseWorkspaceOps", () => {
	it("returns empty when workspace_ops is absent", () => {
		expect(parseWorkspaceOps({ ok: true })).toEqual({ operations: [] })
	})

	it("parses valid write_file and apply_diff", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				version: 1,
				operations: [
					{ op: "write_file", path: "a.md", content: "hello" },
					{ op: "apply_diff", path: "b.ts", diff: "<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE" },
				],
			},
		})
		expect(r.error).toBeUndefined()
		expect(r.operations).toHaveLength(2)
		expect(r.operations[0]).toEqual({ op: "write_file", path: "a.md", content: "hello" })
	})

	it("rejects too many operations", () => {
		const ops = Array.from({ length: WORKSPACE_OPS_MAX_COUNT + 1 }, (_, i) => ({
			op: "write_file" as const,
			path: `f${i}.txt`,
			content: "x",
		}))
		const r = parseWorkspaceOps({ workspace_ops: { operations: ops } })
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})

	it("rejects content over max length", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				operations: [{ op: "write_file", path: "x", content: "a".repeat(WORKSPACE_OPS_MAX_BODY_CHARS + 1) }],
			},
		})
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})

	it("rejects unknown op discriminator", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				operations: [{ op: "delete_file", path: "x" }],
			},
		})
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})

	it("rejects absolute paths", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				operations: [{ op: "write_file", path: "/etc/passwd", content: "evil" }],
			},
		})
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})

	it("rejects paths with null bytes", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				operations: [{ op: "write_file", path: "safe.txt\0/../../etc/passwd", content: "evil" }],
			},
		})
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})

	it("rejects URL-encoded traversal", () => {
		const r = parseWorkspaceOps({
			workspace_ops: {
				operations: [{ op: "apply_diff", path: "%2e%2e/etc/shadow", diff: "x" }],
			},
		})
		expect(r.operations).toEqual([])
		expect(r.error).toBeDefined()
	})
})
