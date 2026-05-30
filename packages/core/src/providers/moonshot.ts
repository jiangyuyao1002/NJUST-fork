import type { ModelInfo } from "@njust-ai/types"

// https://platform.moonshot.ai/
// Pricing: https://platform.moonshot.ai/docs/pricing
// Updated: April 2026 (Kimi K2.5; Bedrock id: moonshotai.kimi-k2.5)
export type MoonshotModelId = keyof typeof moonshotModels

export const moonshotDefaultModelId: MoonshotModelId = "kimi-k2.5"

export const moonshotModels = {
	"kimi-k2.5": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.45,
		outputPrice: 2.2,
		cacheReadsPrice: 0.07,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2.5 (Jan 2026) is the latest Kimi with native multimodal thinking, vision, and agent swarm. INT4 quantization for 2x speed. 256K context. Tops Humanity's Last Exam (50.2% with tools).",
	},
	"kimi-k2.5-thinking": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.45,
		outputPrice: 2.2,
		cacheReadsPrice: 0.07,
		supportsTemperature: true,
		preserveReasoning: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2.5 Thinking is a deep reasoning variant with chain-of-thought for complex math, code, and logic tasks. 256K context with vision support.",
	},
	"kimi-k2-0905-preview": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.4,
		outputPrice: 2.0,
		cacheReadsPrice: 0.15,
		description:
			"Kimi K2 (Sep 2025) with improved agentic coding accuracy, better frontend coding, and extended 256K context for long-horizon support.",
	},
	"kimi-k2-thinking": {
		maxTokens: 16_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.47,
		outputPrice: 2.0,
		cacheReadsPrice: 0.141,
		supportsTemperature: true,
		preserveReasoning: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2 Thinking (Nov 2025) is an agentic reasoning model excelling at deep reasoning and multi-turn tool use for the hardest problems.",
	},
	"kimi-k2-turbo-preview": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 2.4,
		outputPrice: 10,
		cacheReadsPrice: 0.6,
		description:
			"Kimi K2 Turbo is a high-speed variant of the K2 MoE model, optimized for 60-100 tokens/s output speed. 256K context.",
	},
	"kimi-k2-0711-preview": {
		maxTokens: 32_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 2.5,
		cacheReadsPrice: 0.15,
		description: "Kimi K2 (Jul 2025) MoE model with 32B activated / 1T total parameters. 128K context.",
	},
} as const satisfies Record<string, ModelInfo>

export const MOONSHOT_DEFAULT_TEMPERATURE = 0.6
