import type { TextContent, ToolUse, McpToolUse } from "../../shared/tools"

export type AssistantMessageContent = TextContent | ToolUse | McpToolUse

/**
 * A discriminated content block that appears in assistant/content arrays.
 * Extends {@link AssistantMessageContent} with Anthropic-native tool_result blocks.
 */
export type ContentBlock = TextContent | ToolUse | McpToolUse | ToolResultBlock

export interface ToolResultBlock {
	type: "tool_result"
	tool_use_id?: string
	content?: unknown
	is_error?: boolean
	[key: string]: unknown
}

// ── Type guards ──────────────────────────────────────────────────────────

export function isTextContentBlock(block: unknown): block is TextContent {
	return typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text"
}

export function isToolUseBlock(block: unknown): block is ToolUse {
	return typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "tool_use"
}

export function isMcpToolUseBlock(block: unknown): block is McpToolUse {
	return typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "mcp_tool_use"
}

export function isAnyToolUse(block: unknown): block is ToolUse | McpToolUse {
	return isToolUseBlock(block) || isMcpToolUseBlock(block)
}

/** Narrower: a block with a `.type` discriminator, safe for accessing `.type` without any. */
export interface TypedBlock {
	type: string
	partial?: boolean
	text?: string
	content?: unknown
	tool_use_id?: string
	is_error?: boolean
	[key: string]: unknown
}
