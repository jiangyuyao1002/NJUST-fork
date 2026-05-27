import type { DynamicModelInfo, DynamicModelRecord } from "./modelTypes"
import type { ProviderName } from "@njust-ai-cj/types"

function model(id: string, contextWindow: number = 128_000): DynamicModelInfo {
	return {
		maxTokens: undefined,
		contextWindow,
		supportsPromptCache: false,
		source: "hardcoded-fallback",
	}
}

export const fallbackModels: Partial<Record<ProviderName, DynamicModelRecord>> = {
	openai: {
		"gpt-5.4": model("gpt-5.4"),
		"gpt-5.4-mini": model("gpt-5.4-mini"),
	},

	anthropic: {
		"claude-sonnet-4-6": model("claude-sonnet-4-6", 200_000),
		"claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001", 200_000),
	},

	gemini: {
		"gemini-3.1-pro-preview": model("gemini-3.1-pro-preview", 1_000_000),
		"gemini-2.5-flash": model("gemini-2.5-flash", 1_000_000),
	},

	deepseek: {
		"deepseek-v4-flash": model("deepseek-v4-flash"),
		"deepseek-v4-pro": model("deepseek-v4-pro"),
	},

	mistral: {
		"mistral-large-latest": model("mistral-large-latest", 128_000),
		"mistral-medium-latest": model("mistral-medium-latest", 128_000),
	},

	xai: {
		"grok-code-fast-1": model("grok-code-fast-1"),
	},

	qwen: {
		"qwen3-coder-plus": model("qwen3-coder-plus"),
		"qwen3.5-plus": model("qwen3.5-plus"),
	},

	moonshot: {
		"kimi-k2.6": model("kimi-k2.6"),
		"kimi-k2.5": model("kimi-k2.5"),
	},

	glm: {
		"glm-5": model("glm-5"),
		"glm-4.7": model("glm-4.7"),
	},

	minimax: {
		"MiniMax-M2.7": model("MiniMax-M2.7"),
		"MiniMax-M2.5": model("MiniMax-M2.5"),
	},

	fireworks: {
		"accounts/fireworks/models/llama4-maverick-instruct-basic": model("accounts/fireworks/models/llama4-maverick-instruct-basic"),
	},

	sambanova: {
		"samba-1": model("samba-1"),
	},

	baseten: {
		"qwen3-235b-a22b": model("qwen3-235b-a22b"),
	},

	doubao: {
		"doubao-1-5-pro-256k": model("doubao-1-5-pro-256k", 256_000),
	},

	mimo: {
		"mimo-v2.5-pro": model("mimo-v2.5-pro", 1_000_000),
		"mimo-v2.5": model("mimo-v2.5", 1_000_000),
	},

	"mimo-token-plan": {
		"mimo-v2-pro": model("mimo-v2-pro", 1_000_000),
		"mimo-v2-omni": model("mimo-v2-omni", 256_000),
	},
}
