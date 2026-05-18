import type { ModelInfo } from "@njust-ai-cj/types"

// Minimax
// https://platform.minimax.io/docs/guides/pricing
// https://platform.minimax.io/docs/api-reference/text-openai-api
// https://platform.minimax.io/docs/api-reference/text-anthropic-api
// Updated: April 2026 (Bedrock: minimax.minimax-m2.1)
export type MinimaxModelId = keyof typeof minimaxModels
export const minimaxDefaultModelId: MinimaxModelId = "MiniMax-M2.7"

export const minimaxModels = {
	"MiniMax-M2.7": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.7 (Mar 2026) focuses on recursive self-improvement with strengths in real-world engineering, professional delivery, and character-rich interaction. ~60 tokens/s.",
	},
	"MiniMax-M2.7-highspeed": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.7 High-Speed variant with output speeds up to ~100 tokens/s, same capabilities as M2.7.",
	},
	"MiniMax-M2.5": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.2,
		outputPrice: 0.95,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.5 (Feb 2026) optimized for code generation and refactoring with polyglot code mastery. ~60 tokens/s.",
	},
	"MiniMax-M2.5-highspeed": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.2,
		outputPrice: 0.95,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.5 High-Speed variant with output speeds up to ~100 tokens/s, optimized for code tasks.",
	},
	"MiniMax-M2.1": {
		maxTokens: 16_384,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.27,
		outputPrice: 0.95,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.1 (Dec 2025) builds on M2 with improved performance for agentic coding tasks and faster response times.",
	},
	"MiniMax-M2": {
		maxTokens: 16_384,
		contextWindow: 192_000,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.255,
		outputPrice: 1.0,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2 (Oct 2025), a model born for Agents and code, featuring top-tier coding, powerful agentic performance, and cost-effectiveness.",
	},
} as const satisfies Record<string, ModelInfo>

export const minimaxDefaultModelInfo: ModelInfo = minimaxModels[minimaxDefaultModelId]

export const MINIMAX_DEFAULT_MAX_TOKENS = 16_384
export const MINIMAX_DEFAULT_TEMPERATURE = 1.0
