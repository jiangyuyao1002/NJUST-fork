import { describe, expect, it } from "vitest"

import { StreamingToolExecutor } from "../StreamingToolExecutor"

describe("StreamingToolExecutor", () => {
	it("defers read_file full tool use (non-partial)", () => {
		const ex = new StreamingToolExecutor(4)
		const task = { didRejectTool: false } as any
		const toolUse = { name: "read_file", partial: false } as any
		expect(ex.shouldEagerExecute(task, toolUse)).toBe("deferred")
	})

	it("defers unsafe tools", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute({ didRejectTool: false } as any, { name: "edit_file", partial: false } as any),
		).toBe("deferred")
	})

	it("defers when rejected", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute({ didRejectTool: true } as any, { name: "read_file", partial: false } as any),
		).toBe("deferred")
	})

	it("defers partial read_file even when native args look stable", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "read_file", partial: true, nativeArgs: { path: "src/index.ts" } } as any,
			),
		).toBe("deferred")
	})

	it("defers partial tools when args are not stable", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "search_files", partial: true, nativeArgs: { path: "src" } } as any,
			),
		).toBe("deferred")
	})

	it("defers grep/glob/web_fetch partial tools under current executor policy", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "grep", partial: true, nativeArgs: { pattern: "TODO" } } as any,
			),
		).toBe("deferred")
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "glob", partial: true, nativeArgs: { pattern: "**/*.ts" } } as any,
			),
		).toBe("deferred")
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "web_fetch", partial: true, nativeArgs: { url: "https://example.com" } } as any,
			),
		).toBe("deferred")
	})

	it("defers web_fetch when url is invalid", () => {
		const ex = new StreamingToolExecutor(4)
		expect(
			ex.shouldEagerExecute(
				{ didRejectTool: false } as any,
				{ name: "web_fetch", partial: true, nativeArgs: { url: "file:///etc/passwd" } } as any,
			),
		).toBe("deferred")
	})

	it("runs eager batch and executes each item", async () => {
		const ex = new StreamingToolExecutor(3)
		const task = { abort: false, didRejectTool: false } as any
		const batch = [
			{ name: "read_file", partial: false, id: "1" },
			{ name: "list_files", partial: false, id: "2" },
			{ name: "search_files", partial: false, id: "3" },
		] as any[]
		const seen: string[] = []
		await ex.runEagerBatch(task, batch as any, async (toolUse) => {
			seen.push(toolUse.id)
		})
		expect(seen.sort()).toEqual(["1", "2", "3"])
	})

	it("skips execution when task aborts or rejects", async () => {
		const ex = new StreamingToolExecutor(3)
		const batch = [
			{ name: "read_file", partial: false, id: "1" },
			{ name: "list_files", partial: false, id: "2" },
		] as any[]

		const seenAbort: string[] = []
		await ex.runEagerBatch({ abort: true, didRejectTool: false } as any, batch as any, async (toolUse) => {
			seenAbort.push(toolUse.id)
		})
		expect(seenAbort).toEqual([])

		const seenReject: string[] = []
		await ex.runEagerBatch({ abort: false, didRejectTool: true } as any, batch as any, async (toolUse) => {
			seenReject.push(toolUse.id)
		})
		expect(seenReject).toEqual([])
	})
})
