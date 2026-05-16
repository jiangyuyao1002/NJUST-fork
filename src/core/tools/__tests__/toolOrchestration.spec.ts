import { describe, expect, it } from "vitest"

import { dedupeReadonlyToolCalls, partitionToolCalls, type ToolExecutionBatch } from "../toolOrchestration"
import type { ToolUse } from "../../../shared/tools"

function mk(name: string, id: string): ToolUse {
	return {
		type: "tool_use",
		id,
		name: name as any,
		params: {},
		partial: false,
		nativeArgs: {},
	}
}

describe("dedupeReadonlyToolCalls", () => {
	it("dedupes identical readonly calls and keeps mapping", () => {
		const a = { ...mk("read_file", "1"), nativeArgs: { path: "a.ts" } }
		const b = { ...mk("read_file", "2"), nativeArgs: { path: "a.ts" } }
		const c = { ...mk("search_files", "3"), nativeArgs: { path: ".", regex: "x" } }
		const d = { ...mk("write_to_file", "4"), nativeArgs: { path: "a.ts", content: "x" } }

		const r = dedupeReadonlyToolCalls([a, b, c, d] as ToolUse[])
		expect(r.uniqueCalls.map((x) => x.id)).toEqual(["1", "3", "4"])
		expect(r.duplicateToOriginal.get("2")).toBe("1")
	})

	it("falls back to params when nativeArgs are absent", () => {
		const a = { ...mk("read_file", "1"), nativeArgs: undefined, params: { path: "a.ts" } }
		const b = { ...mk("read_file", "2"), nativeArgs: undefined, params: { path: "a.ts" } }

		const r = dedupeReadonlyToolCalls([a, b] as ToolUse[])

		expect(r.uniqueCalls.map((x) => x.id)).toEqual(["1"])
		expect(r.duplicateToOriginal.get("2")).toBe("1")
	})

	it("keeps readonly calls separate when semantic fields differ", () => {
		const calls = [
			{ ...mk("read_file", "1"), nativeArgs: { path: "a.ts", offset: 1 } },
			{ ...mk("read_file", "2"), nativeArgs: { path: "a.ts", offset: 2 } },
			{ ...mk("list_files", "3"), nativeArgs: { path: ".", recursive: true } },
			{ ...mk("list_files", "4"), nativeArgs: { path: ".", recursive: false } },
		]

		const r = dedupeReadonlyToolCalls(calls as ToolUse[])

		expect(r.uniqueCalls.map((x) => x.id)).toEqual(["1", "2", "3", "4"])
		expect(r.duplicateToOriginal.size).toBe(0)
	})
})

describe("partitionToolCalls", () => {
	it("returns no batches for empty input", () => {
		expect(partitionToolCalls([], () => true)).toEqual([])
	})

	it("groups consecutive safe calls into parallel batch", () => {
		const calls = [mk("read_file", "1"), mk("list_files", "2"), mk("write_to_file", "3")]
		const safe = (c: ToolUse) => c.name === "read_file" || c.name === "list_files"
		const batches = partitionToolCalls(calls, safe)
		expect(batches).toHaveLength(2)
		expect(batches[0]).toMatchObject({ mode: "parallel" })
		expect(batches[0].calls.map((c) => c.id)).toEqual(["1", "2"])
		expect(batches[1]).toMatchObject({ mode: "serial" })
		expect(batches[1].calls.map((c) => c.id)).toEqual(["3"])
	})

	it("keeps ordering and boundaries", () => {
		const calls = [mk("read_file", "1"), mk("execute_command", "2"), mk("search_files", "3")]
		const safe = (c: ToolUse) => c.name === "read_file" || c.name === "search_files"
		const batches = partitionToolCalls(calls, safe)
		expect(batches).toHaveLength(3)
		expect(batches.map((b) => b.calls[0].id)).toEqual(["1", "2", "3"])
		expect(batches.map((b) => b.mode)).toEqual(["serial", "serial", "serial"])
	})

	it("creates stable mixed parallel-serial groups", () => {
		const calls = [
			mk("read_file", "1"),
			mk("search_files", "2"),
			mk("execute_command", "3"),
			mk("list_files", "4"),
			mk("web_search", "5"),
			mk("write_to_file", "6"),
		]
		const safe = (c: ToolUse) =>
			["read_file", "search_files", "list_files", "web_search"].includes(c.name)
		const batches = partitionToolCalls(calls, safe)
		expect(batches.map((b) => ({ mode: b.mode, ids: b.calls.map((c) => c.id) }))).toEqual([
			{ mode: "parallel", ids: ["1", "2"] },
			{ mode: "serial", ids: ["3"] },
			{ mode: "parallel", ids: ["4", "5"] },
			{ mode: "serial", ids: ["6"] },
		])
	})

	it("uses serial mode for a single concurrency-safe call", () => {
		const batches = partitionToolCalls([mk("read_file", "1")], () => true)

		expect(batches).toEqual([{ mode: "serial", calls: [expect.objectContaining({ id: "1" })] }])
	})
})

describe("cascade skip semantics", () => {
	it("emits skip errors for remaining batches after execute_command failure", () => {
		const batches: ToolExecutionBatch[] = [
			{ mode: "parallel", calls: [mk("read_file", "1"), mk("search_files", "2")] },
			{ mode: "serial", calls: [mk("execute_command", "3")] },
			{ mode: "parallel", calls: [mk("list_files", "4"), mk("web_search", "5")] },
		]

		const failedExecuteCommandIds = new Set(["3"])
		const skippedIds: string[] = []
		let cascadeStop = false
		for (const batch of batches) {
			if (cascadeStop) {
				skippedIds.push(...batch.calls.map((c) => c.id || ""))
				continue
			}
			for (const call of batch.calls) {
				if (failedExecuteCommandIds.has(call.id || "") && call.name === "execute_command") {
					cascadeStop = true
					break
				}
			}
		}

		expect(skippedIds).toEqual(["4", "5"])
	})
})
