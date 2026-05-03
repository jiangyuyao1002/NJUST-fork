import OpenAI from "openai"

import type { CacheableTextPart } from "./types"

export function addCacheBreakpoints(systemPrompt: string, messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
	// Shallow clone to avoid mutating the caller's array.
	// Individual messages are cloned when their content needs to be modified.
	const result = [...messages]

	// Apply cache_control to system message at the message level
	result[0] = {
		role: "system",
		content: systemPrompt,
		cache_control: { type: "ephemeral" },
	} as OpenAI.Chat.ChatCompletionMessageParam

	// Add cache_control to the last two user messages for conversation context caching
	const lastTwoUserIndices: number[] = []
	for (let i = result.length - 1; i >= 0 && lastTwoUserIndices.length < 2; i--) {
		if (result[i].role === "user") {
			lastTwoUserIndices.unshift(i)
		}
	}

	for (const idx of lastTwoUserIndices) {
		const msg = result[idx]
		if (typeof msg.content === "string" && msg.content.length > 0) {
			result[idx] = { ...msg, content: [{ type: "text" as const, text: msg.content }] } as OpenAI.Chat.ChatCompletionMessageParam
		}

		const content = result[idx].content
		if (Array.isArray(content)) {
			let lastTextPart = content.filter((part) => part.type === "text").pop() as CacheableTextPart | undefined

			if (lastTextPart && lastTextPart.text && lastTextPart.text.length > 0) {
				;(lastTextPart as CacheableTextPart).cache_control = { type: "ephemeral" }
			}
		}
	}

	return result
}
