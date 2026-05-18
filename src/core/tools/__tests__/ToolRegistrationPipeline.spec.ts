import { describe, expect, it, vi } from "vitest"

import { BaseTool } from "../BaseTool"
import {
	createToolRegistrationPipeline,
	registerConditionalTools,
	registerStaticTools,
	wireToolSearchRegistry,
	type ConditionalToolRegistration,
	type ToolRegistrationRegistry,
} from "../ToolRegistrationPipeline"

class MockReadTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	async execute(): Promise<void> {}
}

class MockWriteTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const
	async execute(): Promise<void> {}
}

function createRegistry(): ToolRegistrationRegistry & { registered: string[]; conditional: string[] } {
	return {
		registered: [],
		conditional: [],
		register(tool) {
			this.registered.push(tool.name)
		},
		registerConditional(tool, condition) {
			if (condition()) {
				this.conditional.push(tool.name)
			}
		},
		getAllTools() {
			return []
		},
	}
}

describe("ToolRegistrationPipeline", () => {
	it("runs middleware in order and registers static tools through the chain", async () => {
		const order: string[] = []
		const registry = createRegistry()

		const run = createToolRegistrationPipeline(
			async (_ctx, next) => {
				order.push("before")
				await next()
				order.push("after")
			},
			registerStaticTools([new MockReadTool(), new MockWriteTool()]),
		)

		await run({ registry })

		expect(order).toEqual(["before", "after"])
		expect(registry.registered).toEqual(["read_file", "write_to_file"])
	})

	it("registers conditional tools through middleware", async () => {
		const registry = createRegistry()
		const conditionalTools: ConditionalToolRegistration[] = [
			{ tool: new MockReadTool(), condition: () => true },
			{ tool: new MockWriteTool(), condition: () => false },
		]

		await createToolRegistrationPipeline(registerConditionalTools(conditionalTools))({ registry })

		expect(registry.conditional).toEqual(["read_file"])
	})

	it("wires tool_search to the same registry", async () => {
		const registry = createRegistry()
		const setToolRegistry = vi.fn()

		await createToolRegistrationPipeline(wireToolSearchRegistry({ setToolRegistry }))({ registry })

		expect(setToolRegistry).toHaveBeenCalledWith(registry)
	})
})
