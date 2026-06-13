import { describe, it, expect } from "vitest"

import { NativeToolCallFormatter } from "../NativeToolCallFormatter"

describe("NativeToolCallFormatter", () => {
	describe("tryRecoverMalformedArgs", () => {
		it("parses valid JSON", () => {
			const r = NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", JSON.stringify({ path: "/a.ts" }))
			expect(r).toEqual({ path: "/a.ts" })
		})

		it("parses JSON inside code block", () => {
			const raw = 'text\n```json\n{"path":"/a.ts"}\n```'
			const r = NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", raw)
			expect(r).toEqual({ path: "/a.ts" })
		})

		it("parses JSON inside plain code block", () => {
			const raw = '```\n{"path":"/a.ts"}\n```'
			const r = NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", raw)
			expect(r).toEqual({ path: "/a.ts" })
		})

		it("returns null for invalid code block JSON then falls through", () => {
			const raw = "```json\nnot json\n```"
			expect(NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", raw)).toBeNull()
		})

		it("returns null for completely invalid input", () => {
			expect(NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", "no json here")).toBeNull()
		})

		it("fixes missing closing brace", () => {
			const raw = '{"path": "/a.ts"'
			expect(NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", raw)).toEqual({ path: "/a.ts" })
		})

		it("fixes multiple missing closing braces", () => {
			const raw = '{"a": {"b": 1'
			expect(NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", raw)).toEqual({ a: { b: 1 } })
		})

		it("returns null for deeply broken JSON", () => {
			expect(NativeToolCallFormatter.tryRecoverMalformedArgs("read_file", "{{{{{{{")).toBeNull()
		})

		describe("update_todo_list special handling", () => {
			it("extracts todos from {todos: ...} pattern", () => {
				const r = NativeToolCallFormatter.tryRecoverMalformedArgs(
					"update_todo_list",
					'{"todos": "[x] done [ ] todo"}',
				)
				expect(r).toEqual({ todos: "[x] done [ ] todo" })
			})

			it("extracts todos from bare checkbox pattern", () => {
				const r = NativeToolCallFormatter.tryRecoverMalformedArgs("update_todo_list", "[x] done [ ] todo")
				expect(r).toEqual({ todos: "[x] done [ ] todo" })
			})

			it("does not match for non-update_todo_list tool", () => {
				expect(NativeToolCallFormatter.tryRecoverMalformedArgs("other", "[x] done")).toBeNull()
			})
		})
	})

	describe("remapParamAliases", () => {
		it("remaps known aliases for edit tool", () => {
			const args: Record<string, unknown> = { file: "/a.ts", old_str: "a", new_str: "b" }
			NativeToolCallFormatter.remapParamAliases("edit", args)
			expect(args.file_path).toBe("/a.ts")
			expect(args.file).toBeUndefined()
		})

		it("remaps read_file aliases", () => {
			const args: Record<string, unknown> = { filepath: "/a.ts" }
			NativeToolCallFormatter.remapParamAliases("read_file", args)
			expect(args.path).toBe("/a.ts")
			expect(args.filepath).toBeUndefined()
		})

		it("remaps execute_command aliases", () => {
			const args: Record<string, unknown> = { cmd: "ls -la" }
			NativeToolCallFormatter.remapParamAliases("execute_command", args)
			expect(args.command).toBe("ls -la")
			expect(args.cmd).toBeUndefined()
		})

		it("does nothing for unknown tool", () => {
			const args: Record<string, unknown> = { file: "/a.ts" }
			NativeToolCallFormatter.remapParamAliases("unknown_tool", args)
			expect(args.file).toBe("/a.ts")
		})

		it("does not overwrite existing target key", () => {
			const args: Record<string, unknown> = { file: "old.ts", file_path: "new.ts" }
			NativeToolCallFormatter.remapParamAliases("edit", args)
			expect(args.file_path).toBe("new.ts")
			expect(args.file).toBe("old.ts")
		})

		it("remaps ask_followup_question aliases", () => {
			const args: Record<string, unknown> = { q: "what?" }
			NativeToolCallFormatter.remapParamAliases("ask_followup_question", args)
			expect(args.question).toBe("what?")
		})

		it("remaps attempt_completion aliases", () => {
			const args: Record<string, unknown> = { answer: "done" }
			NativeToolCallFormatter.remapParamAliases("attempt_completion", args)
			expect(args.result).toBe("done")
		})
	})

	describe("coerceArgTypes", () => {
		it("converts string integers", () => {
			const args: Record<string, unknown> = { offset: "10", limit: "20", timeout: "30" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.offset).toBe(10)
			expect(args.limit).toBe(20)
			expect(args.timeout).toBe(30)
		})

		it("truncates decimal strings to integers", () => {
			const args: Record<string, unknown> = { offset: "10.7" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.offset).toBe(10)
		})

		it("ignores non-numeric strings for int keys", () => {
			const args: Record<string, unknown> = { offset: "abc" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.offset).toBe("abc")
		})

		it("ignores non-string values for int keys", () => {
			const args: Record<string, unknown> = { offset: 42 }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.offset).toBe(42)
		})

		it("converts string booleans", () => {
			const args: Record<string, unknown> = { recursive: "true", replace_all: "false" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.recursive).toBe(true)
			expect(args.replace_all).toBe(false)
		})

		it("handles case-insensitive boolean strings", () => {
			const args: Record<string, unknown> = { recursive: " TRUE " }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.recursive).toBe(true)
		})

		it("ignores non-boolean strings for bool keys", () => {
			const args: Record<string, unknown> = { recursive: "yes" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.recursive).toBe("yes")
		})

		it("converts all int keys", () => {
			const args: Record<string, unknown> = {
				anchor_line: "5",
				max_levels: "3",
				max_lines: "100",
				contextLines: "50",
				expected_replacements: "2",
				count: "7",
			}
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.anchor_line).toBe(5)
			expect(args.max_levels).toBe(3)
			expect(args.max_lines).toBe(100)
			expect(args.contextLines).toBe(50)
			expect(args.expected_replacements).toBe(2)
			expect(args.count).toBe(7)
		})

		it("converts include_siblings and include_header bools", () => {
			const args: Record<string, unknown> = { include_siblings: "true", include_header: "false" }
			NativeToolCallFormatter.coerceArgTypes(args)
			expect(args.include_siblings).toBe(true)
			expect(args.include_header).toBe(false)
		})
	})

	describe("coerceOptionalBoolean", () => {
		it("returns boolean as-is", () => {
			expect(NativeToolCallFormatter.coerceOptionalBoolean(true)).toBe(true)
			expect(NativeToolCallFormatter.coerceOptionalBoolean(false)).toBe(false)
		})

		it("converts string true/false", () => {
			expect(NativeToolCallFormatter.coerceOptionalBoolean("true")).toBe(true)
			expect(NativeToolCallFormatter.coerceOptionalBoolean("false")).toBe(false)
		})

		it("handles case-insensitive strings", () => {
			expect(NativeToolCallFormatter.coerceOptionalBoolean(" TRUE ")).toBe(true)
			expect(NativeToolCallFormatter.coerceOptionalBoolean("False")).toBe(false)
		})

		it("returns undefined for non-boolean values", () => {
			expect(NativeToolCallFormatter.coerceOptionalBoolean(42)).toBeUndefined()
			expect(NativeToolCallFormatter.coerceOptionalBoolean("yes")).toBeUndefined()
			expect(NativeToolCallFormatter.coerceOptionalBoolean(null)).toBeUndefined()
			expect(NativeToolCallFormatter.coerceOptionalBoolean(undefined)).toBeUndefined()
		})
	})

	describe("coerceOptionalNumber", () => {
		it("returns finite number as-is", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber(42)).toBe(42)
		})

		it("converts numeric string", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber("42")).toBe(42)
		})

		it("converts decimal string", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber("3.14")).toBe(3.14)
		})

		it("returns undefined for NaN", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber(NaN)).toBeUndefined()
		})

		it("returns undefined for Infinity", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber(Infinity)).toBeUndefined()
		})

		it("returns undefined for non-numeric string", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber("abc")).toBeUndefined()
		})

		it("returns undefined for non-number non-string", () => {
			expect(NativeToolCallFormatter.coerceOptionalNumber(null)).toBeUndefined()
			expect(NativeToolCallFormatter.coerceOptionalNumber(true)).toBeUndefined()
			expect(NativeToolCallFormatter.coerceOptionalNumber(undefined)).toBeUndefined()
		})
	})

	describe("convertFileEntries", () => {
		it("converts basic file entries", () => {
			expect(NativeToolCallFormatter.convertFileEntries([{ path: "/a.ts" }])).toEqual([{ path: "/a.ts" }])
		})

		it("converts array-format line ranges", () => {
			const r = NativeToolCallFormatter.convertFileEntries([
				{
					path: "/a.ts",
					line_ranges: [
						[1, 10],
						[20, 30],
					],
				},
			])
			expect(r[0]!.lineRanges).toEqual([
				{ start: 1, end: 10 },
				{ start: 20, end: 30 },
			])
		})

		it("converts object-format line ranges", () => {
			const r = NativeToolCallFormatter.convertFileEntries([
				{ path: "/a.ts", line_ranges: [{ start: 1, end: 10 }] },
			])
			expect(r[0]!.lineRanges).toEqual([{ start: 1, end: 10 }])
		})

		it("converts string-format line ranges", () => {
			const r = NativeToolCallFormatter.convertFileEntries([{ path: "/a.ts", line_ranges: ["1-10", "20-30"] }])
			expect(r[0]!.lineRanges).toEqual([
				{ start: 1, end: 10 },
				{ start: 20, end: 30 },
			])
		})

		it("filters out invalid ranges", () => {
			const r = NativeToolCallFormatter.convertFileEntries([
				{ path: "/a.ts", line_ranges: ["invalid", null, 42] },
			])
			expect(r[0]!.lineRanges).toEqual([])
		})

		it("handles entries without line_ranges", () => {
			const r = NativeToolCallFormatter.convertFileEntries([{ path: "/a.ts" }])
			expect(r[0]!.lineRanges).toBeUndefined()
		})

		it("handles empty array", () => {
			expect(NativeToolCallFormatter.convertFileEntries([])).toEqual([])
		})
	})

	describe("parseDynamicMcpTool", () => {
		it("parses valid MCP tool call", () => {
			const r = NativeToolCallFormatter.parseDynamicMcpTool({
				id: "call_1",
				name: "mcp__server__tool",
				arguments: JSON.stringify({ key: "value" }),
			})
			expect(r).not.toBeNull()
			expect(r!.serverName).toBe("server")
			expect(r!.toolName).toBe("tool")
			expect(r!.arguments).toEqual({ key: "value" })
			expect(r!.type).toBe("mcp_tool_use")
		})

		it("handles empty arguments string", () => {
			const r = NativeToolCallFormatter.parseDynamicMcpTool({
				id: "call_2",
				name: "mcp__server__tool",
				arguments: "",
			})
			expect(r).not.toBeNull()
			expect(r!.arguments).toEqual({})
		})

		it("returns null for invalid tool name format", () => {
			const r = NativeToolCallFormatter.parseDynamicMcpTool({
				id: "call_3",
				name: "invalid",
				arguments: "{}",
			})
			expect(r).toBeNull()
		})

		it("returns null for invalid JSON arguments", () => {
			const r = NativeToolCallFormatter.parseDynamicMcpTool({
				id: "call_4",
				name: "mcp__server__tool",
				arguments: "not json",
			})
			expect(r).toBeNull()
		})
	})
})
