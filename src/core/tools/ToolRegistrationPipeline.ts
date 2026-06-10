import type { ToolName } from "@njust-ai/types"

import type { BaseTool } from "./BaseTool"
import type { ToolRegistry } from "./ToolSearchTool"

type RegisteredTool = BaseTool<ToolName>

export interface ToolRegistrationRegistry extends ToolRegistry {
	register(tool: RegisteredTool): void
	registerConditional(tool: RegisteredTool, condition: () => boolean): void
}

export interface ConditionalToolRegistration {
	tool: RegisteredTool
	condition: () => boolean
}

export interface ToolRegistrationContext {
	registry: ToolRegistrationRegistry
}

export type ToolRegistrationNext = () => Promise<void>

export type ToolRegistrationMiddleware = (
	context: ToolRegistrationContext,
	next: ToolRegistrationNext,
) => void | Promise<void>

export function createToolRegistrationPipeline(
	...middlewares: ToolRegistrationMiddleware[]
): (context: ToolRegistrationContext) => Promise<void> {
	return async (context) => {
		let index = -1

		const dispatch = async (nextIndex: number): Promise<void> => {
			if (nextIndex <= index) {
				throw new Error("ToolRegistrationPipeline: next() called multiple times")
			}
			index = nextIndex
			const middleware = middlewares[nextIndex]
			if (!middleware) return
			await middleware(context, () => dispatch(nextIndex + 1))
		}

		await dispatch(0)
	}
}

export function registerStaticTools(tools: readonly RegisteredTool[]): ToolRegistrationMiddleware {
	return async (context, next) => {
		for (const tool of tools) {
			context.registry.register(tool)
		}
		await next()
	}
}

export function registerConditionalTools(tools: readonly ConditionalToolRegistration[]): ToolRegistrationMiddleware {
	return async (context, next) => {
		for (const entry of tools) {
			context.registry.registerConditional(entry.tool, entry.condition)
		}
		await next()
	}
}

export function wireToolSearchRegistry(toolSearch: {
	setToolRegistry(registry: ToolRegistry): void
}): ToolRegistrationMiddleware {
	return async (context, next) => {
		toolSearch.setToolRegistry(context.registry)
		await next()
	}
}
