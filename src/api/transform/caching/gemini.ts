import OpenAI from "openai"

import type { CacheableTextPart } from "./types"

export function addCacheBreakpoints(
	systemPrompt: string,
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
	frequency: number = 10,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	// Shallow clone to avoid mutating the caller's array.
	const result = [...messages]

	// *Always* cache the system prompt.
	result[0] = {
		role: "system",
		content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
	} as unknown as OpenAI.Chat.ChatCompletionMessageParam

	// Add breakpoints every N user messages based on frequency.
	let count = 0

	for (let i = 0; i < result.length; i++) {
		const msg = result[i]
		if (msg.role !== "user") {
			continue
		}

		// Ensure content is in array format for potential modification.
		if (typeof msg.content === "string") {
			result[i] = { ...msg, content: [{ type: "text" as const, text: msg.content }] }
		}

		const isNthMessage = count % frequency === frequency - 1

		if (isNthMessage) {
			const content = result[i].content
			if (Array.isArray(content)) {
				let lastTextPart = content.filter((part) => part.type === "text").pop() as CacheableTextPart | undefined

				if (!lastTextPart) {
					lastTextPart = { type: "text", text: "..." } // Placeholder if no text part exists.
					content.push(lastTextPart)
				}

				;(lastTextPart as CacheableTextPart).cache_control = { type: "ephemeral" }
			}
		}

		count++
	}

	return result
}
