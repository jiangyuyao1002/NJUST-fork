import { describe, it, expect, vi } from "vitest"
import type { ToolUse } from "../../../../shared/tools"
import type { ModeConfig } from "@njust-ai/types"

const mockReadFileTool = {
	getReadFileToolDescription: vi.fn((_name: string, params: any) => {
		const p = params?.path ?? params
		return typeof p === "string" ? `[read_file for '${p}']` : "[read_file with missing path]"
	}),
}

vi.mock("../../tools/ToolRegistry", () => ({
	toolRegistry: {
		getConcurrencySafeNames: vi.fn().mockReturnValue(new Set()),
		get: vi.fn((name: string) => (name === "read_file" ? mockReadFileTool : null)),
	},
}))
vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

const { buildToolDescription } = await import("../toolUseHelpers")

function makeBlock(name: string, params: Record<string, string> = {}, nativeArgs?: unknown): ToolUse {
	return {
		type: "tool_use",
		name: name as ToolUse["name"],
		params,
		partial: false,
		nativeArgs: nativeArgs as never,
	}
}

describe("buildToolDescription", () => {
	it("formats execute_command", () => {
		expect(buildToolDescription(makeBlock("execute_command", { command: "ls" }))).toBe("[execute_command for 'ls']")
	})

	it("formats read_file with nativeArgs", () => {
		const result = buildToolDescription(makeBlock("read_file", {}, { path: "foo.ts" }))
		expect(result).toContain("read_file")
		expect(result).toContain("foo.ts")
	})

	it("formats read_file without nativeArgs", () => {
		const result = buildToolDescription(makeBlock("read_file", {}))
		expect(result).toContain("read_file")
	})

	it("formats write_to_file with params.path", () => {
		expect(buildToolDescription(makeBlock("write_to_file", { path: "a.ts" }))).toBe("[write_to_file for 'a.ts']")
	})

	it("formats write_to_file with nativeArgs.path", () => {
		const block = makeBlock("write_to_file", {}, { path: "b.ts" })
		expect(buildToolDescription(block)).toBe("[write_to_file for 'b.ts']")
	})

	it("formats write_to_file with empty path", () => {
		expect(buildToolDescription(makeBlock("write_to_file"))).toBe("[write_to_file for '']")
	})

	it("formats apply_diff with path", () => {
		expect(buildToolDescription(makeBlock("apply_diff", { path: "x.ts" }))).toBe("[apply_diff for 'x.ts']")
	})

	it("formats apply_diff without path", () => {
		expect(buildToolDescription(makeBlock("apply_diff"))).toBe("[apply_diff]")
	})

	it("formats search_files with file_pattern", () => {
		expect(buildToolDescription(makeBlock("search_files", { regex: "foo", file_pattern: "*.ts" }))).toBe(
			"[search_files for 'foo' in '*.ts']",
		)
	})

	it("formats search_files without file_pattern", () => {
		expect(buildToolDescription(makeBlock("search_files", { regex: "foo" }))).toBe("[search_files for 'foo']")
	})

	for (const toolName of ["edit", "search_and_replace", "search_replace", "edit_file"]) {
		it(`formats ${toolName} with file_path`, () => {
			expect(buildToolDescription(makeBlock(toolName, { file_path: "a.ts" }))).toBe(`[${toolName} for 'a.ts']`)
		})
	}

	for (const toolName of ["apply_patch", "attempt_completion", "update_todo_list"]) {
		it(`formats ${toolName} without params`, () => {
			expect(buildToolDescription(makeBlock(toolName))).toBe(`[${toolName}]`)
		})
	}

	it("formats list_files with params.path", () => {
		expect(buildToolDescription(makeBlock("list_files", { path: "src/" }))).toBe("[list_files for 'src/']")
	})

	it("formats list_files with nativeArgs.path", () => {
		const block = makeBlock("list_files", {}, { path: "lib/" })
		expect(buildToolDescription(block)).toBe("[list_files for 'lib/']")
	})

	it("formats list_files default path", () => {
		expect(buildToolDescription(makeBlock("list_files"))).toBe("[list_files for '.']")
	})

	for (const toolName of ["use_mcp_tool", "access_mcp_resource"]) {
		it(`formats ${toolName}`, () => {
			expect(buildToolDescription(makeBlock(toolName, { server_name: "srv" }))).toBe(`[${toolName} for 'srv']`)
		})
	}

	it("formats ask_followup_question", () => {
		expect(buildToolDescription(makeBlock("ask_followup_question", { question: "really?" }))).toBe(
			"[ask_followup_question for 'really?']",
		)
	})

	it("formats switch_mode without reason", () => {
		expect(buildToolDescription(makeBlock("switch_mode", { mode_slug: "ask" }))).toBe("[switch_mode to 'ask']")
	})

	it("formats switch_mode with reason", () => {
		expect(buildToolDescription(makeBlock("switch_mode", { mode_slug: "ask", reason: "confused" }))).toBe(
			"[switch_mode to 'ask' because: confused]",
		)
	})

	it("formats codebase_search", () => {
		expect(buildToolDescription(makeBlock("codebase_search", { query: "test" }))).toBe(
			"[codebase_search for 'test']",
		)
	})

	it("formats read_command_output", () => {
		expect(buildToolDescription(makeBlock("read_command_output", { artifact_id: "123" }))).toBe(
			"[read_command_output for '123']",
		)
	})

	it("formats new_task with defaults", () => {
		const result = buildToolDescription(makeBlock("new_task", {}))
		expect(result).toContain("new_task")
		expect(result).toContain("(no message)")
	})

	it("formats new_task with custom modes", () => {
		const modes: ModeConfig[] = [{ slug: "ask", name: "Ask Mode", roleDefinition: "", groups: ["read"] }]
		const result = buildToolDescription(makeBlock("new_task", { mode: "ask", message: "hello" }), modes)
		expect(result).toContain("Ask Mode")
		expect(result).toContain("hello")
	})

	it("formats run_slash_command without args", () => {
		expect(buildToolDescription(makeBlock("run_slash_command", { command: "/test" }))).toBe(
			"[run_slash_command for '/test']",
		)
	})

	it("formats run_slash_command with args", () => {
		expect(buildToolDescription(makeBlock("run_slash_command", { command: "/test", args: "foo" }))).toBe(
			"[run_slash_command for '/test' with args: foo]",
		)
	})

	it("formats skill without args", () => {
		expect(buildToolDescription(makeBlock("skill", { skill: "test" }))).toBe("[skill for 'test']")
	})

	it("formats skill with args", () => {
		expect(buildToolDescription(makeBlock("skill", { skill: "test", args: "bar" }))).toBe(
			"[skill for 'test' with args: bar]",
		)
	})

	it("formats generate_image", () => {
		expect(buildToolDescription(makeBlock("generate_image", { path: "img.png" }))).toBe(
			"[generate_image for 'img.png']",
		)
	})

	it("formats web_search", () => {
		expect(buildToolDescription(makeBlock("web_search", { search_query: "test" }))).toBe("[web_search for 'test']")
	})

	it("formats unknown tool with default", () => {
		expect(buildToolDescription(makeBlock("unknown_tool"))).toBe("[unknown_tool]")
	})
})
