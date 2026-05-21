import OpenAI from "openai"
import { ensureAllRequired, ensureAdditionalPropertiesFalse } from "../schema-utils"
import { isMcpTool } from "../../../utils/mcp-name"

export function convertToolsForResponsesApi(tools: OpenAI.Chat.ChatCompletionTool[]): Array<{
	type: "function"
	name: string
	description?: string
	parameters?: Record<string, UnsafeAny>
	strict?: boolean
}> {
	return tools
		.filter((tool) => tool.type === "function")
		.map((tool) => {
			const isMcp = isMcpTool(tool.function.name)
			return {
				type: "function" as const,
				name: tool.function.name,
				description: tool.function.description,
				parameters: isMcp
					? ensureAdditionalPropertiesFalse(tool.function.parameters)
					: ensureAllRequired(tool.function.parameters),
				strict: !isMcp,
			}
		})
}
