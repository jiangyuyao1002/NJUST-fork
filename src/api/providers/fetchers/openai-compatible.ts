import type { ProviderName } from "@njust-ai-cj/types"
import type { DynamicModelRecord, ListModelsOptions } from "../modelTypes"

interface ProviderConfig {
	apiKeyEnv: string
	baseUrlEnv: string
	defaultBaseUrl: string
	path: string
}

const configs: Partial<Record<ProviderName, ProviderConfig>> = {
	openai: {
		apiKeyEnv: "OPENAI_API_KEY",
		baseUrlEnv: "OPENAI_BASE_URL",
		defaultBaseUrl: "https://api.openai.com/v1",
		path: "/models",
	},
	mistral: {
		apiKeyEnv: "MISTRAL_API_KEY",
		baseUrlEnv: "MISTRAL_BASE_URL",
		defaultBaseUrl: "https://api.mistral.ai/v1",
		path: "/models",
	},
	xai: {
		apiKeyEnv: "XAI_API_KEY",
		baseUrlEnv: "XAI_BASE_URL",
		defaultBaseUrl: "https://api.x.ai/v1",
		path: "/models",
	},
	qwen: {
		apiKeyEnv: "QWEN_API_KEY",
		baseUrlEnv: "QWEN_BASE_URL",
		defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		path: "/models",
	},
	moonshot: {
		apiKeyEnv: "MOONSHOT_API_KEY",
		baseUrlEnv: "MOONSHOT_BASE_URL",
		defaultBaseUrl: "https://api.moonshot.ai/v1",
		path: "/models",
	},
	glm: {
		apiKeyEnv: "GLM_API_KEY",
		baseUrlEnv: "GLM_BASE_URL",
		defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		path: "/models",
	},
	minimax: {
		apiKeyEnv: "MINIMAX_API_KEY",
		baseUrlEnv: "MINIMAX_BASE_URL",
		defaultBaseUrl: "https://api.minimax.io/v1",
		path: "/models",
	},
	deepseek: {
		apiKeyEnv: "DEEPSEEK_API_KEY",
		baseUrlEnv: "DEEPSEEK_BASE_URL",
		defaultBaseUrl: "https://api.deepseek.com",
		path: "/models",
	},
	"openai-native": {
		apiKeyEnv: "OPENAI_NATIVE_API_KEY",
		baseUrlEnv: "OPENAI_NATIVE_BASE_URL",
		defaultBaseUrl: "https://api.openai.com/v1",
		path: "/models",
	},
	fireworks: {
		apiKeyEnv: "FIREWORKS_API_KEY",
		baseUrlEnv: "FIREWORKS_BASE_URL",
		defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
		path: "/models",
	},
	sambanova: {
		apiKeyEnv: "SAMBANOVA_API_KEY",
		baseUrlEnv: "SAMBANOVA_BASE_URL",
		defaultBaseUrl: "https://api.sambanova.ai/v1",
		path: "/models",
	},
	baseten: {
		apiKeyEnv: "BASETEN_API_KEY",
		baseUrlEnv: "BASETEN_BASE_URL",
		defaultBaseUrl: "https://inference.baseten.co/v1",
		path: "/models",
	},
	doubao: {
		apiKeyEnv: "DOUBAO_API_KEY",
		baseUrlEnv: "DOUBAO_BASE_URL",
		defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		path: "/models",
	},
	mimo: {
		apiKeyEnv: "MIMO_API_KEY",
		baseUrlEnv: "MIMO_BASE_URL",
		defaultBaseUrl: "https://api.xiaomimimo.com/v1",
		path: "/models",
	},
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
}

export async function fetchOpenAICompatibleModels(
	provider: ProviderName,
	options: ListModelsOptions = {},
): Promise<DynamicModelRecord> {
	const config = configs[provider]
	if (!config) {
		throw new Error(`Unsupported OpenAI-compatible provider: ${provider}`)
	}

	const apiKey = options.apiKey ?? process.env[config.apiKeyEnv]
	if (!apiKey) {
		throw new Error(`Missing API key for provider: ${provider}`)
	}

	const baseUrl =
		options.baseUrl ?? process.env[config.baseUrlEnv] ?? config.defaultBaseUrl

	const res = await fetch(joinUrl(baseUrl, config.path), {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	})

	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`Failed to fetch models for ${provider}: ${res.status} ${body}`)
	}

	const json = await res.json()
	const list = Array.isArray(json.data)
		? json.data
		: Array.isArray(json.models)
			? json.models
			: []

	const models: DynamicModelRecord = {}

	for (const item of list) {
		const id: string | undefined = item.id ?? item.name
		if (!id || typeof id !== "string") continue

		models[id] = {
			maxTokens: item.max_tokens ?? item.maxTokens ?? undefined,
			contextWindow: item.context_window ?? item.contextWindow ?? 128_000,
			supportsPromptCache: false,
			deprecated: Boolean(item.deprecated),
			source: "api",
		}
	}

	return models
}
