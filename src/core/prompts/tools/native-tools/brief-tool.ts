import type OpenAI from "openai"

const BRIEF_TOOL_DESCRIPTION = `Summarize or truncate content to a shorter form. Use this tool when you need to condense long text while preserving the most important information. The tool keeps the first paragraph, key lines (headings, definitions, bullet points), and the ending, while removing redundant or less important content. If the content is already shorter than maxLength, it is returned unchanged.

Parameters:
- content: (required) The text content to summarize / truncate.
- maxLength: (optional) Maximum character length of the output. Default: 500.

Example: Summarize a long file content
{ "content": "...long text...", "maxLength": 500 }

Example: Brief with custom length
{ "content": "...long text...", "maxLength": 1000 }`

export default {
	type: "function",
	function: {
		name: "brief",
		description: BRIEF_TOOL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The text content to summarize or truncate.",
				},
				maxLength: {
					type: ["number", "null"],
					description: "Maximum character length of the output. Default: 500.",
				},
			},
			required: ["content"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
