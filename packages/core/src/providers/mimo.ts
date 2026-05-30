import type { ModelInfo } from "@njust-ai/types"

// https://platform.xiaomimimo.com
// Pay-as-you-go mode: https://api.xiaomimimo.com/v1
// Supports all models, full feature set.
// Updated: May 2026
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-v2.5-pro"

export const mimoModels = {
	"mimo-v2-flash": {
		maxTokens: 128_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.7,
		outputPrice: 2.1,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2-Flash: 309B params (15B active) MoE model, cost-effective with strong coding capabilities.",
	},
	"mimo-v2-pro": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1,
		outputPrice: 3,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2-Pro: Flagship agent model with 1M context, optimized for complex Agent and Coding tasks.",
	},
	"mimo-v2.5": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.5,
		outputPrice: 2,
		cacheReadsPrice: 0.02,
		supportsReasoningBudget: true,
		description: "MiMo-V2.5: Latest version with improved reasoning, Agent stability, and 1M context.",
	},
	"mimo-v2.5-pro": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1,
		outputPrice: 6,
		cacheReadsPrice: 0.025,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2.5-Pro: Strongest model, tops open-source benchmarks for Agent and Coding tasks.",
	},
	"mimo-v2-omni": {
		maxTokens: 128_000,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 1.5,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2-Omni: Multimodal base model with vision, audio, and video support.",
	},
	"mimo-v2-tts": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description: "MiMo-V2-TTS: Text-to-speech model for high-quality voice synthesis.",
	},
	"mimo-v2.5-tts": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description: "MiMo-V2.5-TTS: Latest text-to-speech model with improved naturalness.",
	},
	"mimo-v2.5-asr": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description: "MiMo-V2.5-ASR: Automatic speech recognition model for high-precision transcription.",
	},
} as const satisfies Record<string, ModelInfo>

export const MIMO_DEFAULT_TEMPERATURE = 0.7
