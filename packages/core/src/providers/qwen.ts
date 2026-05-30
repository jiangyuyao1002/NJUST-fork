import type { ModelInfo } from "@njust-ai/types"

// https://help.aliyun.com/zh/model-studio/getting-started/models
// Pricing: https://help.aliyun.com/zh/model-studio/billing-overview
// Updated: April 2026
export type QwenModelId = keyof typeof qwenModels

export const qwenDefaultModelId: QwenModelId = "qwen3.5-plus"

export const qwenModels = {
	"qwen3-next-80b-a3b-instruct": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 1.2,
		description:
			"Qwen3-Next 80B A3B Instruct (DashScope): sparse MoE, strong coding/reasoning; pricing aligned with Bedrock qwen3-next listing.",
	},
	"qwen3-next-80b-a3b-thinking": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.15,
		outputPrice: 1.2,
		description: "Qwen3-Next 80B A3B Thinking (DashScope): reasoning-optimized variant with chain-of-thought.",
	},
	"qwen3.5-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.15,
		description:
			"Qwen3.5-Plus (Feb 2026) is Alibaba's latest flagship with 1M context, vision+video support, 201 languages, hybrid linear-attention + MoE architecture. Tops benchmarks on MMMU, MMLU-Pro, SWE-bench.",
	},
	"qwen-max-latest": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 2.11,
		outputPrice: 8.45,
		description:
			"Qwen-Max-Latest is the most capable dense model for complex multi-step reasoning and generation. 256K context with vision.",
	},
	"qwen-plus-latest": {
		maxTokens: 32_768,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 1.2,
		description:
			"Qwen-Plus-Latest balances performance and cost. 1M context, vision support, ideal for most production tasks.",
	},
	"qwen-turbo-latest": {
		maxTokens: 16_384,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.042,
		outputPrice: 0.084,
		description:
			"Qwen-Turbo-Latest is optimized for speed and low cost with 1M context. Best for simple tasks requiring fast responses.",
	},
	"qwen3-max": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.11,
		outputPrice: 8.45,
		description:
			"Qwen3-Max (Jan 2026) with 258K context and 66K max output. Strong reasoning and function calling capabilities.",
	},
	"qwen3-coder-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.65,
		outputPrice: 3.25,
		cacheReadsPrice: 0.13,
		description:
			"Qwen3-Coder-Plus (Sep 2025) is specialized for code generation, debugging, and agentic coding tasks. 1M context window for large codebases.",
	},
	"qwq-plus": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 2.11,
		outputPrice: 8.45,
		description:
			"QwQ-Plus is a deep reasoning model that thinks step-by-step before answering. Excels at math, code, and complex logical problems.",
	},
	"qwen-vl-max": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.21,
		outputPrice: 0.63,
		description:
			"Qwen-VL-Max is a vision-language model for image understanding, OCR, visual reasoning, and multimodal tasks.",
	},
	"qwen-long": {
		maxTokens: 16_384,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.28,
		description: "Qwen-Long is optimized for ultra-long document processing with 1M context at very low cost.",
	},
} as const satisfies Record<string, ModelInfo>

export const QWEN_DEFAULT_TEMPERATURE = 0.3
