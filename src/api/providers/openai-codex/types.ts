import { Anthropic } from "@anthropic-ai/sdk"
import { z } from "zod"

import { type ModelInfo, type ReasoningEffortExtended, type VerbosityLevel } from "@njust-ai/types"
import { type OpenAiCodexModelId } from "@njust-ai/core/providers"

// ---------------------------------------------------------------------------
// Model type (explicit structural type, avoids circular dependency with base.ts)
// ---------------------------------------------------------------------------

export interface OpenAiCodexModel {
	id: OpenAiCodexModelId
	info: ModelInfo
	format: "openai"
	maxTokens: number | undefined
	temperature: number | undefined
	reasoningEffort: ReasoningEffortExtended | undefined
	reasoningBudget: number | undefined
	verbosity: VerbosityLevel | undefined
	tools?: boolean
	reasoning?: { reasoning_effort?: UnsafeAny }
}

// ---------------------------------------------------------------------------
// Usage data
// ---------------------------------------------------------------------------

export interface OpenAiCodexUsageData {
	input_tokens?: number
	prompt_tokens?: number
	output_tokens?: number
	completion_tokens?: number
	cache_creation_input_tokens?: number
	cache_write_tokens?: number
	cache_read_input_tokens?: number
	cache_read_tokens?: number
	cached_tokens?: number
	input_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number }
	prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number }
	output_tokens_details?: { reasoning_tokens?: number }
}

// ---------------------------------------------------------------------------
// Conversation / request types
// ---------------------------------------------------------------------------

export type CodexInputItem =
	| { role: "user" | "assistant"; content: Record<string, UnsafeAny>[] }
	| { type: string; content?: string; id?: string; encrypted_content?: string; [key: string]: UnsafeAny }
	| Anthropic.Messages.MessageParam

export interface ResponsesOutputItem {
	type?: string
	text?: UnsafeAny
	output_text?: string
	delta?: string
	content?: ResponsesOutputItem[]
	call_id?: string
	tool_call_id?: string
	id?: string
	name?: string
	function_name?: string
	function?: { name?: string; arguments?: UnsafeAny }
	arguments?: UnsafeAny
	input?: UnsafeAny
	encrypted_content?: string
	[key: string]: UnsafeAny
}

export interface ResponsesStreamEvent {
	type?: string
	response?: {
		output?: ResponsesOutputItem[]
		id?: string
		usage?: OpenAiCodexUsageData
	}
	delta?: string
	text?: string
	output_text?: string
	part?: ResponsesOutputItem
	item?: ResponsesOutputItem
	call_id?: string
	tool_call_id?: string
	id?: string
	name?: string
	function_name?: string
	arguments?: UnsafeAny
	index?: number
	choices?: Array<{ delta?: { content?: string } }>
	usage?: OpenAiCodexUsageData
	error?: { message?: string; [key: string]: UnsafeAny }
	message?: string
	[key: string]: UnsafeAny
}

export interface ResponsesRequestBody {
	model: string
	input: CodexInputItem[]
	stream: boolean
	reasoning?: { effort?: ReasoningEffortExtended; summary?: "auto" }
	temperature?: number
	store?: boolean
	instructions?: string
	include?: string[]
	tools?: Array<{
		type: "function"
		name: string
		description?: string
		parameters?: Record<string, UnsafeAny>
		strict?: boolean
	}>
	tool_choice?: UnsafeAny
	parallel_tool_calls?: boolean
}

export interface ResponsesClientLike {
	responses: {
		create(
			body: ResponsesRequestBody,
			options?: { signal?: AbortSignal; headers?: Record<string, string> },
		): Promise<AsyncIterable<ResponsesStreamEvent>>
	}
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const codexErrorResponseSchema = z
	.object({
		error: z
			.object({
				message: z.string().optional(),
			})
			.passthrough()
			.optional(),
		message: z.string().optional(),
		detail: z.string().optional(),
	})
	.passthrough()

export const codexResponsesStreamEventSchema = z.object({}).passthrough()

export const codexCompleteResponseSchema = z
	.object({
		text: z.string().optional(),
		output: z
			.array(
				z
					.object({
						type: z.string().optional(),
						content: z
							.array(
								z
									.object({
										type: z.string().optional(),
										text: z.string().optional(),
									})
									.passthrough(),
							)
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough()
