import { describe, expect, it, beforeEach } from "vitest"
import { ToolRegistryImpl } from "../ToolRegistry"
import { BaseTool } from "../BaseTool"

// Minimal test tool that extends BaseTool
class MockReadTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	override isConcurrencySafe() {
		return true
	}
	override isReadOnly() {
		return true
	}
	async execute(): Promise<void> {}
}

class MockWriteTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const
	override readonly requiresCheckpoint = true
	async execute(): Promise<void> {}
}

class MockEditTool extends BaseTool<"edit"> {
	readonly name = "edit" as const
	override readonly requiresCheckpoint = true
	override get aliases(): readonly string[] {
		return ["search_and_replace"]
	}
	async execute(): Promise<void> {}
}

class MockGrepTool extends BaseTool<"grep"> {
	readonly name = "grep" as const
	override isConcurrencySafe() {
		return true
	}
	override isReadOnly() {
		return true
	}
	async execute(): Promise<void> {}
}

describe("ToolRegistryImpl", () => {
	let registry: ToolRegistryImpl

	beforeEach(() => {
		registry = new ToolRegistryImpl()
	})

	describe("register and get", () => {
		it("registers a tool and retrieves it by name", () => {
			const tool = new MockReadTool()
			registry.register(tool)
			expect(registry.get("read_file")).toBe(tool)
		})

		it("returns undefined for unregistered tool", () => {
			expect(registry.get("nonexistent")).toBeUndefined()
		})

		it("throws on duplicate registration", () => {
			registry.register(new MockReadTool())
			expect(() => registry.register(new MockReadTool())).toThrow("already registered")
		})

		it("tracks size correctly", () => {
			expect(registry.size).toBe(0)
			registry.register(new MockReadTool())
			expect(registry.size).toBe(1)
			registry.register(new MockWriteTool())
			expect(registry.size).toBe(2)
		})
	})

	describe("alias resolution", () => {
		it("resolves per-tool aliases", () => {
			const editTool = new MockEditTool()
			registry.register(editTool)
			expect(registry.get("search_and_replace")).toBe(editTool)
		})

		it("resolves shared TOOL_ALIASES (write_file -> write_to_file)", () => {
			const writeTool = new MockWriteTool()
			registry.register(writeTool)
			// TOOL_ALIASES maps write_file -> write_to_file
			expect(registry.get("write_file")).toBe(writeTool)
		})

		it("has() returns true for aliases", () => {
			const editTool = new MockEditTool()
			registry.register(editTool)
			expect(registry.has("search_and_replace")).toBe(true)
			expect(registry.has("edit")).toBe(true)
			expect(registry.has("nonexistent")).toBe(false)
		})

		it("resolveAlias returns canonical name for alias", () => {
			expect(registry.resolveAlias("write_file")).toBe("write_to_file")
			expect(registry.resolveAlias("search_and_replace")).toBe("edit")
		})

		it("resolveAlias returns input unchanged for non-alias", () => {
			expect(registry.resolveAlias("read_file")).toBe("read_file")
		})
	})

	describe("getAllTools", () => {
		it("returns all registered tools without duplicates", () => {
			registry.register(new MockReadTool())
			registry.register(new MockWriteTool())
			registry.register(new MockEditTool())
			const all = registry.getAllTools()
			expect(all).toHaveLength(3)
			expect(all.map((t) => t.name)).toEqual(["read_file", "write_to_file", "edit"])
		})
	})

	describe("getConcurrencySafeNames", () => {
		it("returns only concurrency-safe tools", () => {
			registry.register(new MockReadTool())
			registry.register(new MockWriteTool())
			registry.register(new MockGrepTool())
			const safeNames = registry.getConcurrencySafeNames()
			expect(safeNames.has("read_file")).toBe(true)
			expect(safeNames.has("grep")).toBe(true)
			expect(safeNames.has("write_to_file")).toBe(false)
		})

		it("caches results and invalidates on register", () => {
			registry.register(new MockReadTool())
			const first = registry.getConcurrencySafeNames()
			const second = registry.getConcurrencySafeNames()
			expect(first).toBe(second) // Same reference = cached

			registry.register(new MockGrepTool())
			const third = registry.getConcurrencySafeNames()
			expect(third).not.toBe(first) // New set after register
			expect(third.has("grep")).toBe(true)
		})
	})

	describe("getToolsRequiringCheckpoint", () => {
		it("returns only tools with requiresCheckpoint = true", () => {
			registry.register(new MockReadTool())
			registry.register(new MockWriteTool())
			registry.register(new MockEditTool())
			const checkpointTools = registry.getToolsRequiringCheckpoint()
			expect(checkpointTools.has("write_to_file")).toBe(true)
			expect(checkpointTools.has("edit")).toBe(true)
			expect(checkpointTools.has("read_file")).toBe(false)
		})
	})

	describe("deferred tools", () => {
		it("separates deferred and non-deferred tools", () => {
			class DeferredTool extends BaseTool<"lsp"> {
				readonly name = "lsp" as const
				override get shouldDefer() {
					return true
				}
				async execute(): Promise<void> {}
			}

			registry.register(new MockReadTool())
			registry.register(new DeferredTool())

			expect(registry.getNonDeferredTools()).toHaveLength(1)
			expect(registry.getDeferredTools()).toHaveLength(1)
			expect(registry.getDeferredTools()[0].name).toBe("lsp")
		})
	})
})
