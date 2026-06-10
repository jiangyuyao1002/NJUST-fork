import type OpenAI from "openai"

const TOOL_SEARCH_DESCRIPTION = `Search for additional tools that are not loaded in the current session. Some specialized or low-frequency tools are deferred and not included in the initial prompt to save tokens. Use this tool when you need a capability that none of the currently available tools provide.

The search matches your query against tool names, display names, and keyword hints. It returns full descriptions of matching tools so you can invoke them in subsequent turns.

Parameters:
- query: (required) Space-separated keywords describing the capability you are looking for. For example: "image generation", "notebook edit", "sleep wait".

Example: Search for tools related to image generation
{ "query": "image generate" }`

export default {
	type: "function",
	function: {
		name: "tool_search",
		description: TOOL_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Space-separated keywords describing the tool capability you need",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
