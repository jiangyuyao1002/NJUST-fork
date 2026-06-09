import type { Tool, ToolChoice } from "@aws-sdk/client-bedrock-runtime"
import type OpenAI from "openai"

import { normalizeToolSchema } from "../../utils/json-schema"

/**
 * Convert OpenAI tool definitions to Bedrock Converse format
 * Transforms JSON Schema to draft 2020-12 compliant format required by Claude models.
 * @param tools Array of OpenAI ChatCompletionTool definitions
 * @returns Array of Bedrock Tool definitions
 */
export function convertToolsForBedrock(tools: OpenAI.Chat.ChatCompletionTool[]): Tool[] {
	return tools
		.filter((tool) => tool.type === "function")
		.map(
			(tool) =>
				({
					toolSpec: {
						name: tool.function.name,
						description: tool.function.description,
						inputSchema: {
							// Normalize schema to JSON Schema draft 2020-12 compliant format
							// This converts type: ["T", "null"] to anyOf: [{type: "T"}, {type: "null"}]
							json: normalizeToolSchema(tool.function.parameters as Record<string, UnsafeAny>),
						},
					},
				}) as Tool,
		)
}

/**
 * Convert OpenAI tool_choice to Bedrock ToolChoice format
 * @param toolChoice OpenAI tool_choice parameter
 * @returns Bedrock ToolChoice configuration
 */
export function convertToolChoiceForBedrock(
	toolChoice: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"],
): ToolChoice | undefined {
	if (!toolChoice) {
		// Default to auto - model decides whether to use tools
		return { auto: {} } as ToolChoice
	}

	if (typeof toolChoice === "string") {
		switch (toolChoice) {
			case "none":
				return undefined // Bedrock doesn't have "none", just omit tools
			case "auto":
				return { auto: {} } as ToolChoice
			case "required":
				return { any: {} } as ToolChoice // Model must use at least one tool
			default:
				return { auto: {} } as ToolChoice
		}
	}

	// Handle object form { type: "function", function: { name: string } }
	if (typeof toolChoice === "object" && "function" in toolChoice) {
		return {
			tool: {
				name: toolChoice.function.name,
			},
		} as ToolChoice
	}

	return { auto: {} } as ToolChoice
}
