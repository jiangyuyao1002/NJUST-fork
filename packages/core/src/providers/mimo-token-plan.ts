import type { ModelInfo } from "@njust-ai-cj/types"

// https://platform.xiaomimimo.com
// Token Plan subscription mode: https://token-plan-cn.xiaomimimo.com/v1
// Uses tp- prefixed API keys. Only specific models are supported.
// Updated: May 2026
export type MimoTokenPlanModelId = keyof typeof mimoTokenPlanModels

export const mimoTokenPlanDefaultModelId: MimoTokenPlanModelId = "mimo-v2.5-pro"

export const mimoTokenPlanModels = {
	"mimo-v2-pro": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2-Pro (Token Plan): Flagship agent model with 1M context, 2x Credit consumption.",
	},
	"mimo-v2-omni": {
		maxTokens: 128_000,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2-Omni (Token Plan): Multimodal model with vision support, 1x Credit consumption.",
	},
	"mimo-v2-tts": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description:
			"MiMo-V2-TTS (Token Plan): Text-to-speech model, currently free (0x Credit).",
	},
	"mimo-v2.5": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2.5 (Token Plan): Native multimodal model with text/image/video/audio, 1x Credit.",
	},
	"mimo-v2.5-pro": {
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		description:
			"MiMo-V2.5-Pro (Token Plan): Strongest model for complex Agent and Coding tasks, 2x Credit.",
	},
	"mimo-v2.5-tts": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description:
			"MiMo-V2.5-TTS (Token Plan): Latest text-to-speech model with improved naturalness.",
	},
	"mimo-v2.5-asr": {
		maxTokens: 8_192,
		contextWindow: 8_192,
		supportsImages: false,
		supportsPromptCache: false,
		description:
			"MiMo-V2.5-ASR (Token Plan): Automatic speech recognition for high-precision transcription.",
	},
} as const satisfies Record<string, ModelInfo>

export const MIMO_TOKEN_PLAN_DEFAULT_TEMPERATURE = 0.7
