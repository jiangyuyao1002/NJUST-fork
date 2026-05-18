import type { ModelInfo } from "@njust-ai-cj/types"

// https://platform.deepseek.com/docs/api
// preserveReasoning enables interleaved thinking mode for tool calls:
// DeepSeek requires reasoning_content to be passed back during tool call
// continuation within the same turn. See: https://api-docs.deepseek.com/guides/thinking_mode
export type DeepSeekModelId = keyof typeof deepSeekModels

// Prefer V4 model ids; legacy names route to V4-Flash until 2026-07-24 per DeepSeek API changelog.
export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-flash"

export const deepSeekModels = {
	"deepseek-v4-flash": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		supportsReasoningBudget: true,
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.0028,
		description:
			"DeepSeek-V4-Flash: fast MoE model, 1M context, thinking/non-thinking modes (see API thinking parameter).",
	},
	"deepseek-v4-pro": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		supportsReasoningBudget: true,
		inputPrice: 1.74,
		outputPrice: 3.48,
		cacheWritesPrice: 1.74,
		cacheReadsPrice: 0.0145,
		description:
			"DeepSeek-V4-Pro: flagship MoE model, 1M context, thinking/non-thinking modes. Pricing per api-docs.deepseek.com (list rates).",
	},
	// Legacy: currently mapped to V4-Flash non-thinking / thinking modes (api-docs.deepseek.com/updates/).
	"deepseek-chat": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningBudget: false,
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.0028,
		description: "Legacy alias for deepseek-v4-flash (non-thinking). Retiring 2026-07-24; use deepseek-v4-flash.",
	},
	"deepseek-reasoner": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		supportsReasoningBudget: true,
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.0028,
		description:
			"Legacy alias for deepseek-v4-flash (thinking). Retiring 2026-07-24; use deepseek-v4-flash with thinking enabled.",
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
