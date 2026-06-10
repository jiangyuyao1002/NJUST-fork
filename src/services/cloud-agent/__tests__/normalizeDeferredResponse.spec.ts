import { describe, it, expect } from "vitest"

import { normalizeDeferredResponse, parseDeferredToolCallItem } from "../normalizeDeferredResponse"

describe("parseDeferredToolCallItem", () => {
	it("parses NJUST deferred shape", () => {
		expect(
			parseDeferredToolCallItem({
				call_id: "c1",
				tool: "read_file",
				arguments: { path: "a.txt" },
			}),
		).toEqual({ call_id: "c1", tool: "read_file", arguments: { path: "a.txt" } })
	})

	it("parses OpenAI tool_calls shape", () => {
		expect(
			parseDeferredToolCallItem({
				id: "call_abc",
				type: "function",
				function: { name: "list_files", arguments: '{"path":"."}' },
			}),
		).toEqual({ call_id: "call_abc", tool: "list_files", arguments: { path: "." } })
	})
})

describe("normalizeDeferredResponse", () => {
	it("fills pending_tools from tool_calls when pending_tools missing", () => {
		const out = normalizeDeferredResponse({
			run_id: "r1",
			status: "pending",
			tool_calls: [
				{ id: "a", function: { name: "t1", arguments: "{}" } },
				{ id: "b", function: { name: "t2", arguments: "{}" } },
			],
		})
		expect(out.pending_tools).toHaveLength(2)
		expect(out.pending_tools![0].tool).toBe("t1")
		expect(out.pending_tools![1].call_id).toBe("b")
	})

	it("keeps pending_tools when already set", () => {
		const out = normalizeDeferredResponse({
			run_id: "r1",
			status: "pending",
			pending_tools: [{ call_id: "x", tool: "read_file", arguments: {} }],
			tool_calls: [{ id: "x", function: { name: "ignored", arguments: "{}" } }],
		})
		expect(out.pending_tools).toHaveLength(1)
		expect(out.pending_tools![0].tool).toBe("read_file")
	})

	it("rejects deferred_protocol_version below supported minimum", () => {
		expect(() => normalizeDeferredResponse({ run_id: "r1", status: "done", deferred_protocol_version: 0 })).toThrow(
			/deferred_protocol_version/,
		)
	})

	it("rejects run_id with newlines or excessive length", () => {
		expect(() => normalizeDeferredResponse({ run_id: "bad\nid", status: "done" })).toThrow(/run_id/)
	})
})
