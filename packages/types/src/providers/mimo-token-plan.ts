import type { ModelInfo } from "../model.js"

// https://platform.xiaomimimo.com
// Token Plan subscription mode: https://token-plan-cn.xiaomimimo.com/v1
// Uses tp- prefixed API keys. Only specific models are supported.
// Updated: May 2026
export type MimoTokenPlanModelId = keyof typeof mimoTokenPlanModels

export const mimoTokenPlanDefaultModelId: MimoTokenPlanModelId = "mimo-v2-pro"

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
} as const satisfies Record<string, ModelInfo>

export const MIMO_TOKEN_PLAN_DEFAULT_TEMPERATURE = 0.7
