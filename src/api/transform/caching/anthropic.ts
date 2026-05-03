import OpenAI from "openai"

import type { CacheableTextPart } from "./types"

export function addCacheBreakpoints(systemPrompt: string, messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
	// Shallow clone to avoid mutating the caller's array.
	const result = [...messages]

	result[0] = {
		role: "system",
		content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
	} as unknown as OpenAI.Chat.ChatCompletionMessageParam

	// Ensure user messages have content in array format before adding breakpoints
	for (let i = 0; i < result.length; i++) {
		const msg = result[i]
		if (msg.role === "user" && typeof msg.content === "string") {
			result[i] = { ...msg, content: [{ type: "text" as const, text: msg.content }] }
		}
	}

	// Add `cache_control: ephemeral` to the last two user messages.
	// (Note: this works because we only ever add one user message at a
	// time, but if we added multiple we'd need to mark the user message
	// before the last assistant message.)
	result
		.filter((msg) => msg.role === "user")
		.slice(-2)
		.forEach((msg) => {
			if (Array.isArray(msg.content)) {
				// NOTE: This is fine since env details will always be added
				// at the end. But if it wasn't there, and the user added a
				// image_url type message, it would pop a text part before
				// it and then move it after to the end.
				let lastTextPart = msg.content.filter((part) => part.type === "text").pop() as CacheableTextPart | undefined

				if (!lastTextPart) {
					lastTextPart = { type: "text", text: "..." }
					msg.content.push(lastTextPart)
				}

				;(lastTextPart as CacheableTextPart).cache_control = { type: "ephemeral" }
			}
		})

	return result
}
