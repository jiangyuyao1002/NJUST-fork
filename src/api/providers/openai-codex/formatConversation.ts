import { Anthropic } from "@anthropic-ai/sdk"

import { sanitizeOpenAiCallId } from "../../../utils/tool-id"
import type { CodexInputItem } from "./types"

/**
 * Convert Anthropic-format conversation messages into Codex/Responses API input items.
 *
 * Pure function — no class state dependencies.
 */
export function formatConversation(
	systemPrompt: string,
	messages: Anthropic.Messages.MessageParam[],
): CodexInputItem[] {
	const formattedInput: CodexInputItem[] = []

	for (const message of messages) {
		// Check if this is a reasoning item
		if ((message as Record<string, UnsafeAny>).type === "reasoning") {
			formattedInput.push(message)
			continue
		}

		if (message.role === "user") {
			const content: Record<string, UnsafeAny>[] = []
			const toolResults: CodexInputItem[] = []

			if (typeof message.content === "string") {
				content.push({ type: "input_text", text: message.content })
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") {
						content.push({ type: "input_text", text: block.text })
					} else if (block.type === "image") {
						const image = block as Anthropic.Messages.ImageBlockParam
						const imageUrl = `data:${image.source.media_type};base64,${image.source.data}`
						content.push({ type: "input_image", image_url: imageUrl })
					} else if (block.type === "tool_result") {
						const result =
							typeof block.content === "string"
								? block.content
								: block.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || ""
						toolResults.push({
							type: "function_call_output",
							// Sanitize and truncate call_id to fit OpenAI's 64-char limit
							call_id: sanitizeOpenAiCallId(block.tool_use_id),
							output: result,
						})
					}
				}
			}

			if (content.length > 0) {
				formattedInput.push({ role: "user", content })
			}

			if (toolResults.length > 0) {
				formattedInput.push(...toolResults)
			}
		} else if (message.role === "assistant") {
			const content: Record<string, UnsafeAny>[] = []
			const toolCalls: CodexInputItem[] = []

			if (typeof message.content === "string") {
				content.push({ type: "output_text", text: message.content })
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") {
						content.push({ type: "output_text", text: block.text })
					} else if (block.type === "tool_use") {
						toolCalls.push({
							type: "function_call",
							// Sanitize and truncate call_id to fit OpenAI's 64-char limit
							call_id: sanitizeOpenAiCallId(block.id),
							name: block.name,
							arguments: JSON.stringify(block.input),
						})
					}
				}
			}

			if (content.length > 0) {
				formattedInput.push({ role: "assistant", content })
			}

			if (toolCalls.length > 0) {
				formattedInput.push(...toolCalls)
			}
		}
	}

	return formattedInput
}
