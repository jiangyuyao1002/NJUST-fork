import { describe, expect, it } from "vitest"

import { getValidatableToolNames, validateToolParams } from "../toolParamValidator"

describe("validateToolParams", () => {
	it.each([
		["read_file", { path: "src/app.ts", offset: "1", limit: 20 }],
		["write_to_file", { path: "src/app.ts", content: "" }],
		["apply_diff", { path: "src/app.ts", diff: "<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE" }],
		["apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
		["edit", { file_path: "src/app.ts", old_string: "a", new_string: "b", replace_all: "true" }],
		["edit_file", { file_path: "src/app.ts", old_string: "a", new_string: "b", expected_replacements: "2" }],
		["search_and_replace", { file_path: "src/app.ts", old_string: "a", new_string: "b", replace_all: false }],
		["search_replace", { file_path: "src/app.ts", old_string: "a", new_string: "b" }],
		["execute_command", { command: "echo ok", cwd: null, timeout: "5" }],
		["search_files", { path: "src", regex: "TODO", file_pattern: "*.ts" }],
		["list_files", { path: ".", recursive: "true" }],
		["use_mcp_tool", { server_name: "server", tool_name: "tool", arguments: { a: 1 } }],
		["new_task", { mode: "code", message: "do it" }],
		["switch_mode", { mode_slug: "ask", reason: "need info" }],
		["codebase_search", { query: "symbol", path: "src" }],
		["web_search", { search_query: "docs", count: "3" }],
		["web_fetch", { url: "https://example.com" }],
		["ask_followup_question", { question: "Continue?" }],
		["attempt_completion", { result: "done" }],
		["generate_image", { path: "output.png", prompt: "a sunset" }],
	] as const)("accepts valid %s params", (toolName, params) => {
		expect(validateToolParams(toolName, params)).toEqual({ valid: true })
	})

	it.each([
		["read_file", { path: "" }, "path: path must not be empty"],
		["write_to_file", { path: "a.ts" }, "content: Required"],
		["apply_diff", { path: "a.ts", diff: "" }, "diff: diff must not be empty"],
		["apply_patch", { patch: "" }, "patch: patch must not be empty"],
		["edit", { file_path: "a.ts", old_string: "a" }, "new_string: Required"],
		[
			"edit_file",
			{ file_path: "a.ts", old_string: "a", new_string: "b", expected_replacements: 0 },
			"expected_replacements",
		],
		["execute_command", { command: "" }, "command: command must not be empty"],
		["search_files", { path: "src", regex: "" }, "regex: regex must not be empty"],
		["use_mcp_tool", { server_name: "", tool_name: "tool" }, "server_name: server_name must not be empty"],
		["new_task", { mode: "code", message: "" }, "message: message must not be empty"],
		["switch_mode", { mode_slug: "" }, "mode_slug: mode_slug must not be empty"],
		["web_search", { search_query: "" }, "search_query: search_query must not be empty"],
		["web_fetch", { url: "not-a-url" }, "url: url must be a valid URL"],
		["ask_followup_question", { question: "" }, "question: question must not be empty"],
		["attempt_completion", { result: "" }, "result: result must not be empty"],
		["generate_image", { prompt: "test" }, "path"],
		["generate_image", { path: "", prompt: "test" }, "path must not be empty"],
	] as const)("rejects invalid %s params", (toolName, params, errorPart) => {
		const result = validateToolParams(toolName, params)

		expect(result.valid).toBe(false)
		expect(result.error).toContain(`Invalid parameters for tool "${toolName}"`)
		expect(result.error).toContain(errorPart)
	})

	it.each([
		["write_file", { path: "src/app.ts", content: "x" }],
		["search_and_replace", { file_path: "src/app.ts", old_string: "a", new_string: "b" }],
	] as const)("accepts compatible alias %s", (toolName, params) => {
		expect(validateToolParams(toolName, params)).toEqual({ valid: true })
	})

	it("does not validate unknown tools", () => {
		expect(validateToolParams("custom_tool", {})).toEqual({ valid: true })
	})

	it("returns canonical validatable tool names", () => {
		expect(getValidatableToolNames()).toEqual(
			expect.arrayContaining(["read_file", "write_to_file", "execute_command", "web_fetch"]),
		)
		expect(getValidatableToolNames()).not.toContain("write_file")
	})
})
