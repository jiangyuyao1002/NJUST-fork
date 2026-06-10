import { describe, expect, it } from "vitest"

import { partitionToolCalls } from "../../tools/toolOrchestration"
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

describe("parallel tool gating", () => {
	it("keeps write tool isolated between read-only groups", () => {
		const calls = [mk("read_file", "a"), mk("search_files", "b"), mk("edit_file", "c"), mk("list_files", "d")]
		const safe = (c: ToolUse) =>
			[
				"read_file",
				"search_files",
				"list_files",
				"codebase_search",
				"read_command_output",
				"web_search",
			].includes(c.name)
		const batches = partitionToolCalls(calls, safe)
		expect(batches.map((b) => b.mode)).toEqual(["parallel", "serial", "serial"])
		expect(batches.map((b) => b.calls.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["d"]])
	})

	it("keeps execute_command isolated as serial batch", () => {
		const calls = [mk("read_file", "1"), mk("execute_command", "2"), mk("search_files", "3")]
		const safe = (c: ToolUse) => ["read_file", "search_files"].includes(c.name)
		const batches = partitionToolCalls(calls, safe)
		expect(batches.map((b) => b.mode)).toEqual(["serial", "serial", "serial"])
		expect(batches.map((b) => b.calls.map((x) => x.id))).toEqual([["1"], ["2"], ["3"]])
	})
})
