import { beforeEach, describe, expect, it, vi } from "vitest"

import { toolSearchTool } from "../ToolSearchTool"

describe("toolSearchTool", () => {
	const pushToolResult = vi.fn()
	const mockTask = {} as any

	beforeEach(() => {
		pushToolResult.mockReset()
	})

	it("finds deferred tools by keyword", async () => {
		toolSearchTool.setToolRegistry({
			getAllTools: () =>
				[
					{
						name: "read_file",
						shouldDefer: true,
						searchHint: "read file text contents",
						userFacingName: () => "Read File",
						isReadOnly: () => true,
						isConcurrencySafe: () => true,
					},
					{
						name: "write_to_file",
						shouldDefer: true,
						searchHint: "create and update files",
						userFacingName: () => "Write To File",
						isReadOnly: () => false,
						isConcurrencySafe: () => false,
					},
					{
						name: "tool_search",
						shouldDefer: false,
						searchHint: "discover tools",
						userFacingName: () => "Tool Search",
						isReadOnly: () => true,
						isConcurrencySafe: () => true,
					},
				] as any,
		})

		await toolSearchTool.execute({ query: "read" }, mockTask, {
			pushToolResult,
		} as any)

		const output = pushToolResult.mock.calls[0][0] as string
		expect(output).toContain('Found 1 deferred tool(s) matching "read"')
		expect(output).toContain("Read File (read_file)")
		expect(output).not.toContain("Tool Search")
	})

	it("returns no-match message with available deferred tools", async () => {
		toolSearchTool.setToolRegistry({
			getAllTools: () =>
				[
					{
						name: "read_file",
						shouldDefer: true,
						searchHint: "read file text contents",
						userFacingName: () => "Read File",
						isReadOnly: () => true,
						isConcurrencySafe: () => true,
					},
				] as any,
		})

		await toolSearchTool.execute({ query: "database" }, mockTask, {
			pushToolResult,
		} as any)

		const output = pushToolResult.mock.calls[0][0] as string
		expect(output).toContain('No deferred tools matched the query "database"')
		expect(output).toContain("Available deferred tools: Read File")
	})
})
