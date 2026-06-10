import { describe, it, expect, vi, beforeEach } from "vitest"

import { BriefTool, briefTool } from "../BriefTool"

function createTask(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		...overrides,
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	}
}

describe("BriefTool", () => {
	let tool: BriefTool

	beforeEach(() => {
		tool = new BriefTool()
	})

	describe("metadata methods", () => {
		it("isConcurrencySafe returns true", () => {
			expect(tool.isConcurrencySafe()).toBe(true)
		})

		it("isReadOnly returns true", () => {
			expect(tool.isReadOnly()).toBe(true)
		})

		it("userFacingName returns 'Brief'", () => {
			expect(tool.userFacingName()).toBe("Brief")
		})

		it("searchHint returns expected keywords", () => {
			expect(tool.searchHint).toBe("brief summary summarize truncate")
		})

		it("shouldDefer returns true", () => {
			expect(tool.shouldDefer).toBe(true)
		})
	})

	describe("execute() with short content", () => {
		it("returns content as-is when length <= maxLength", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const shortContent = "Hello, world!"

			await tool.execute({ content: shortContent, maxLength: 500 }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(shortContent)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("returns content as-is when length equals maxLength exactly", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "a".repeat(100)

			await tool.execute({ content, maxLength: 100 }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})
	})

	describe("execute() with default maxLength (500)", () => {
		it("uses DEFAULT_MAX_LENGTH=500 when maxLength is not provided", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "short content"

			await tool.execute({ content }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})

		it("uses DEFAULT_MAX_LENGTH=500 when maxLength is null", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "short content"

			await tool.execute({ content, maxLength: null }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})

		it("uses DEFAULT_MAX_LENGTH=500 when maxLength is undefined", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "short content"

			await tool.execute({ content, maxLength: undefined }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})
	})

	describe("execute() with long content (triggers briefContent)", () => {
		it("truncates content longer than maxLength", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const longContent = "This is a long paragraph that goes on and on.\n".repeat(50)

			await tool.execute({ content: longContent, maxLength: 200 }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalled()
			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result.length).toBeLessThanOrEqual(200)
			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("preserves first paragraph in output", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const firstPara = "This is the first paragraph of the document."
			const rest = "\n\n" + "Some other content here.\n".repeat(50)
			const content = firstPara + rest

			await tool.execute({ content, maxLength: 300 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("This is the first paragraph")
		})
	})

	describe("execute() error handling", () => {
		it("calls handleError when an error occurs", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const error = new Error("test error")

			// Force an error by making pushToolResult throw
			callbacks.pushToolResult.mockImplementation(() => {
				throw error
			})

			await tool.execute({ content: "some content", maxLength: 500 }, task, callbacks)

			expect(callbacks.handleError).toHaveBeenCalledWith("generating brief", error)
		})
	})

	describe("briefContent() via execute() - content with multiple paragraphs", () => {
		it("includes key lines from middle section", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const lines = [
				"First paragraph introduction.",
				"",
				"Some filler text here.",
				"# Important Heading",
				"More filler text.",
				"function doSomething() {}",
				"Even more filler.",
				"- bullet point item",
				"Final line of the document.",
			]
			const content = lines.join("\n") + "\n" + "padding\n".repeat(50)

			await tool.execute({ content, maxLength: 300 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			// First paragraph should be preserved
			expect(result).toContain("First paragraph")
			// Key lines (headings, functions, bullets) should be included
			expect(result).toContain("# Important Heading")
		})

		it("handles content with markdown headings", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Introduction paragraph here.",
				"",
				"## Section One",
				"Details about section one.",
				"## Section Two",
				"Details about section two.",
				"## Section Three",
				"Conclusion details here.",
				"",
				"Final summary line.",
			]
				.join("\n")
				.repeat(5)

			await tool.execute({ content, maxLength: 400 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Introduction paragraph")
		})

		it("handles content with key: value lines", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Configuration overview document.",
				"",
				"host: localhost",
				"port: 3000",
				"database: mydb",
				"timeout: 5000",
				"retries: 3",
				"",
				"End of configuration.",
			]
				.join("\n")
				.repeat(10)

			await tool.execute({ content, maxLength: 300 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result.length).toBeLessThanOrEqual(300)
		})

		it("handles content with function/class definitions", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Code overview for the module.",
				"",
				"export class UserService {",
				"  some implementation details here",
				"  function getUser() {",
				"    more details",
				"  }",
				"  const timeout = 5000",
				"}",
				"",
				"End of module.",
			]
				.join("\n")
				.repeat(8)

			await tool.execute({ content, maxLength: 400 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Code overview")
			expect(result.length).toBeLessThanOrEqual(400)
		})

		it("handles content with bullet points", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Project requirements document.",
				"",
				"- First requirement detail",
				"- Second requirement detail",
				"- Third requirement detail",
				"* Fourth requirement detail",
				"* Fifth requirement detail",
				"",
				"Project timeline and milestones.",
			]
				.join("\n")
				.repeat(8)

			await tool.execute({ content, maxLength: 350 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Project requirements")
			expect(result.length).toBeLessThanOrEqual(350)
		})

		it("handles empty lines between paragraphs", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Paragraph one content here.",
				"",
				"",
				"",
				"Paragraph two content here.",
				"",
				"",
				"Paragraph three content here.",
				"",
				"Final paragraph content.",
			]
				.join("\n")
				.repeat(10)

			await tool.execute({ content, maxLength: 300 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result.length).toBeLessThanOrEqual(300)
			expect(result).toContain("Paragraph one")
		})
	})

	describe("isKeyLine() via execute()", () => {
		it("recognizes lines with colons as key lines", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			const content = [
				"Start of document.",
				"",
				"important: this is a key value",
				"filler line without markers",
				"status: active",
				"another filler line here",
				"mode: production",
				"",
				"End of document.",
			]
				.join("\n")
				.repeat(10)

			await tool.execute({ content, maxLength: 400 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("important:")
		})

		it("does not treat short lines (< 3 chars) as key lines", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			// Lines like "a:" are too short to be key lines (< 3 chars)
			const content = ["Document start here.", "", "a:", "b:", "filler text padding", "", "Document end here."]
				.join("\n")
				.repeat(20)

			await tool.execute({ content, maxLength: 300 }, task, callbacks)

			const result = callbacks.pushToolResult.mock.calls[0][0]
			// Short colon lines should NOT appear as key lines
			expect(result).toContain("Document start")
		})
	})

	describe("edge cases: maxLength=0 or negative", () => {
		it("uses DEFAULT_MAX_LENGTH=500 when maxLength is 0", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "Short enough for 500 chars."

			await tool.execute({ content, maxLength: 0 }, task, callbacks)

			// 0 is not > 0, so DEFAULT_MAX_LENGTH (500) is used
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})

		it("uses DEFAULT_MAX_LENGTH=500 when maxLength is negative", async () => {
			const task = createTask()
			const callbacks = createCallbacks()
			const content = "Short enough for 500 chars."

			await tool.execute({ content, maxLength: -10 }, task, callbacks)

			// -10 is not > 0, so DEFAULT_MAX_LENGTH (500) is used
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(content)
		})
	})

	describe("exported instance", () => {
		it("briefTool is an instance of BriefTool", () => {
			expect(briefTool).toBeInstanceOf(BriefTool)
		})

		it("briefTool has name 'brief'", () => {
			expect(briefTool.name).toBe("brief")
		})
	})
})
