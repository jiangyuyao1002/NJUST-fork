import type { ModelInfo } from "@njust-ai-cj/types"

// https://docs.bigmodel.cn/cn/guide/start/model-overview
// Pricing: https://open.bigmodel.cn/pricing (international: https://docs.z.ai/guides/overview/pricing)
// Updated: March 2026
export type GlmModelId = keyof typeof glmModels

export const glmDefaultModelId: GlmModelId = "glm-5"

export const glmModels = {
	"glm-5": {
		maxTokens: 131_072,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.0,
		outputPrice: 3.2,
		description:
			"GLM-5 is Zhipu AI's latest flagship model with coding ability on par with Claude Opus 4.5. Strong agentic long-term planning and execution capabilities. 200K context, 128K max output.",
	},
	"glm-4.7": {
		maxTokens: 131_072,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 2.2,
		description:
			"GLM-4.7 is the flagship general-purpose model with enhanced coding, reasoning, and agent capabilities. 200K context with function calling, MCP, and JSON output support.",
	},
	"glm-4.7-flashx": {
		maxTokens: 131_072,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.4,
		description:
			"GLM-4.7-FlashX is a lightweight high-speed model with strong capabilities for Chinese writing, translation, long text, and sentiment analysis. 200K context.",
	},
	"glm-4-plus": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.7,
		outputPrice: 0.7,
		description:
			"GLM-4-Plus with 128K context. Strong reasoning and instruction following. (Price after 90% reduction, Mar 2026.)",
	},
	"glm-4-air-250k": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.07,
		description: "GLM-4-Air with 256K ultra-long context, ideal for processing very long documents at low cost.",
	},
	"glm-4-air": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.07,
		description: "GLM-4-Air balances performance and speed for general-purpose tasks. 128K context.",
	},
	"glm-4-flash": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "GLM-4-Flash is a free lightweight model for simple tasks with 128K context.",
	},
	"glm-4-flashx": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "GLM-4-FlashX is a free model with enhanced performance over Flash. 128K context.",
	},
	"glm-4v-plus": {
		maxTokens: 16_384,
		contextWindow: 8_192,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.39,
		outputPrice: 1.39,
		description: "GLM-4V-Plus is a vision-language model for image understanding, OCR, and visual Q&A.",
	},
	"glm-z1-air": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.07,
		outputPrice: 0.07,
		description:
			"GLM-Z1-Air is a reasoning model with chain-of-thought for math, logic, and code tasks. 128K context.",
	},
	"glm-z1-airx": {
		maxTokens: 16_384,
		contextWindow: 16_384,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.7,
		outputPrice: 0.7,
		description: "GLM-Z1-AirX is a fast reasoning model optimized for quick deep-thinking tasks.",
	},
	"glm-z1-flash": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0,
		outputPrice: 0,
		description: "GLM-Z1-Flash is a free reasoning model with chain-of-thought for cost-effective deep thinking.",
	},
	"codegeex-4": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.014,
		outputPrice: 0.014,
		description: "CodeGeeX-4 is a code-specialized model for generation, completion, and debugging. 128K context.",
	},
} as const satisfies Record<string, ModelInfo>

export const GLM_DEFAULT_TEMPERATURE = 0.3
