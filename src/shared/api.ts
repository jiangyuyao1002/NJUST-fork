import {
	type ModelInfo,
	type ProviderSettings,
	type RouterProvider,
	routerModelProviders as _routerModelProviders,
	isRouterModelProvider as _isRouterModelProvider,
} from "@njust-ai/types"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@njust-ai/core/providers"

// Re-export from @njust-ai/types so consumers can import from either location.
export { _routerModelProviders as routerModelProviders, _isRouterModelProvider as isRouterModelProvider }

// ApiHandlerOptions
// Extend ProviderSettings (minus apiProvider) with handler-specific toggles.
export type ApiHandlerOptions = Omit<ProviderSettings, "apiProvider"> & {
	/** Injected by {@link createHandler} in api/index (native tool-call parsing). */
	toolCallParser?: import("../api/interfaces/IToolCallParser").IToolCallParser
	/**
	 * When true and using OpenAI Responses API models that support reasoning summaries,
	 * include reasoning.summary: "auto" so the API returns summaries (we already parse
	 * and surface them). Defaults to true; set to false to disable summaries.
	 */
	enableResponsesReasoningSummary?: boolean
	/**
	 * Optional override for Ollama's num_ctx parameter.
	 * When set, this value will be used in Ollama chat requests.
	 * When undefined, Ollama will use the model's default num_ctx from the Modelfile.
	 */
	ollamaNumCtx?: number
}

// RouterName

export type RouterName = RouterProvider

export const isRouterName = (value: string): value is RouterName => _isRouterModelProvider(value)

export function toRouterName(value?: string): RouterName {
	if (value && isRouterName(value)) {
		return value
	}

	throw new Error(`Invalid router name: ${value}`)
}

// Reasoning

export const shouldUseReasoningBudget = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => !!model.requiredReasoningBudget || (!!model.supportsReasoningBudget && !!settings?.enableReasoningEffort)

export const shouldUseReasoningEffort = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => {
	// Explicit off switch
	if (settings?.enableReasoningEffort === false) return false

	// Selected effort from settings or model default
	const selectedEffort = (settings?.reasoningEffort ?? (model as Record<string, UnsafeAny>).reasoningEffort) as
		| "disable"
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| undefined

	// "disable" explicitly omits reasoning
	if (selectedEffort === "disable") return false

	const cap = model.supportsReasoningEffort as UnsafeAny

	// Capability array: use only if selected is included (treat "none"/"minimal" as valid)
	if (Array.isArray(cap)) {
		return !!selectedEffort && (cap as ReadonlyArray<string>).includes(selectedEffort as string)
	}

	// Boolean capability: true → require a selected effort
	if (model.supportsReasoningEffort === true) {
		return !!selectedEffort
	}

	// Not explicitly supported: only allow when the model itself defines a default effort
	// Ignore settings-only selections when capability is absent/false
	const modelDefaultEffort = (model as Record<string, UnsafeAny>).reasoningEffort as
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| undefined
	return !!modelDefaultEffort
}

export const DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS = 16_384
export const DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS = 8_192
export const GEMINI_25_PRO_MIN_THINKING_TOKENS = 128

// Max Tokens

export const getModelMaxOutputTokens = ({
	modelId,
	model,
	settings,
	format,
}: {
	modelId: string
	model: ModelInfo
	settings?: ProviderSettings
	format?: "anthropic" | "openai" | "gemini" | "openrouter"
}): number | undefined => {
	if (shouldUseReasoningBudget({ model, settings })) {
		return settings?.modelMaxTokens || DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS
	}

	const isAnthropicContext =
		modelId.includes("claude") ||
		format === "anthropic" ||
		(format === "openrouter" && modelId.startsWith("anthropic/"))

	// For "Hybrid" reasoning models, discard the model's actual maxTokens for Anthropic contexts
	if (model.supportsReasoningBudget && isAnthropicContext) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// For Anthropic contexts, always ensure a maxTokens value is set
	if (isAnthropicContext && (!model.maxTokens || model.maxTokens === 0)) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// If model has explicit maxTokens, clamp it to 20% of the context window
	// Exception: GPT-5 models should use their exact configured max output tokens
	if (model.maxTokens) {
		// Check if this is a GPT-5 model (case-insensitive)
		const isGpt5Model = modelId.toLowerCase().includes("gpt-5")

		// GPT-5 models bypass the 20% cap and use their full configured max tokens
		if (isGpt5Model) {
			return model.maxTokens
		}

		// All other models are clamped to 20% of context window
		return Math.min(model.maxTokens, Math.ceil(model.contextWindow * 0.2))
	}

	// For non-Anthropic formats without explicit maxTokens, return undefined
	if (format) {
		return undefined
	}

	// Default fallback
	return ANTHROPIC_DEFAULT_MAX_TOKENS
}

// GetModelsOptions

// Allow callers to always pass apiKey/baseUrl without excess property errors,
// while still enforcing required fields per provider where applicable.
type CommonFetchParams = {
	apiKey?: string
	baseUrl?: string
}

// Exhaustive, value-level map for all dynamic providers.
// If a new dynamic provider is added in packages/types, this will fail to compile
// until a corresponding entry is added here.
const _dynamicProviderExtras = {
	openrouter: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	"vercel-ai-gateway": {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	litellm: {} as { apiKey: string; baseUrl: string },
	requesty: {} as { apiKey?: string; baseUrl?: string },
	unbound: {} as { apiKey?: string },
	ollama: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	lmstudio: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	"njust-ai": {} as { apiKey?: string; baseUrl?: string },
	deepseek: {} as { apiKey?: string; baseUrl?: string },
	gemini: {} as { apiKey?: string; baseUrl?: string },
	anthropic: {} as { apiKey?: string; baseUrl?: string },
	"openai-native": {} as { apiKey?: string; baseUrl?: string },
	mistral: {} as { apiKey?: string; baseUrl?: string },
	xai: {} as { apiKey?: string; baseUrl?: string },
	qwen: {} as { apiKey?: string; baseUrl?: string },
	moonshot: {} as { apiKey?: string; baseUrl?: string },
	glm: {} as { apiKey?: string; baseUrl?: string },
	minimax: {} as { apiKey?: string; baseUrl?: string },
	fireworks: {} as { apiKey?: string; baseUrl?: string },
	sambanova: {} as { apiKey?: string; baseUrl?: string },
	baseten: {} as { apiKey?: string; baseUrl?: string },
	doubao: {} as { apiKey?: string; baseUrl?: string },
	mimo: {} as { apiKey?: string; baseUrl?: string },
} as const satisfies Record<RouterName, object>

// Build the dynamic options union from the map, intersected with CommonFetchParams
// so extra fields are always allowed while required ones are enforced.
export type GetModelsOptions = {
	[P in keyof typeof _dynamicProviderExtras]: ({ provider: P } & (typeof _dynamicProviderExtras)[P]) &
		CommonFetchParams
}[RouterName]
