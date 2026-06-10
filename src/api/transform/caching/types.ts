import type OpenAI from "openai"

/**
 * Cache control annotation for Anthropic prompt caching.
 * This is an Anthropic-specific extension that is not part of the OpenAI SDK types.
 */
export interface CacheControl {
	type: "ephemeral"
}

/**
 * Base text content part structure (matches OpenAI's text content part).
 */
interface BaseTextPart {
	type: "text"
	text: string
}

/**
 * Extended text content block with cache control support.
 * Used for adding cache breakpoints to message content.
 */
export interface CacheableTextPart extends BaseTextPart {
	cache_control?: CacheControl
}

/**
 * Extended message param with cache control at the message level.
 * Some providers (like Vercel AI Gateway) support message-level caching.
 */
export interface CacheableMessageParam {
	role: string
	content?: string | OpenAI.Chat.ChatCompletionContentPart[]
	cache_control?: CacheControl
	[key: string]: unknown
}

/**
 * Helper to add cache_control to a text part.
 * Returns a new object with the cache_control property added.
 */
export function withCacheControl<T extends OpenAI.Chat.ChatCompletionContentPartText>(part: T): CacheableTextPart {
	return {
		...part,
		cache_control: { type: "ephemeral" },
	}
}

/**
 * Type guard for checking if content is an array of content parts.
 */
export function isContentArray(
	content: string | OpenAI.Chat.ChatCompletionContentPart[] | null | undefined,
): content is OpenAI.Chat.ChatCompletionContentPart[] {
	return Array.isArray(content)
}
