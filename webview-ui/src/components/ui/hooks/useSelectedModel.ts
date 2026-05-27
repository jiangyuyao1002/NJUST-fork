import {
	type ProviderName,
	type ProviderSettings,
	type ModelInfo,
	type ModelRecord,
	type RouterModels,
	isDynamicProvider,
	isRetiredProvider,
	isRouterModelProvider,
} from "@njust-ai-cj/types"
import {
	anthropicModels,
	bedrockModels,
	deepSeekModels,
	moonshotModels,
	minimaxModels,
	geminiModels,
	mistralModels,
	openAiModelInfoSaneDefaults,
	openAiNativeModels,
	vertexModels,
	xaiModels,
	vscodeLlmModels,
	vscodeLlmDefaultModelId,
	openAiCodexModels,
	sambaNovaModels,
	internationalZAiModels,
	mainlandZAiModels,
	fireworksModels,
	basetenModels,
	qwenCodeModels,
	qwenModels,
	doubaoModels,
	glmModels,
	mimoModels,
	mimoTokenPlanModels,
	litellmDefaultModelInfo,
	lMStudioDefaultModelInfo,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	VERTEX_1M_CONTEXT_MODEL_IDS,
	getProviderDefaultModelId,
} from "@njust-ai-cj/core/providers"

import { useRouterModels } from "./useRouterModels"
import { useOpenRouterModelProviders } from "./useOpenRouterModelProviders"
import { useLmStudioModels } from "./useLmStudioModels"
import { useOllamaModels } from "./useOllamaModels"

/**
 * Helper to get a validated model ID for dynamic providers.
 * Returns the configured model ID if it exists in the available models, otherwise returns the default.
 */
function getValidatedModelId(
	configuredId: string | undefined,
	availableModels: ModelRecord | undefined,
	defaultModelId: string,
): string {
	return configuredId && availableModels?.[configuredId] ? configuredId : defaultModelId
}

type StaticModelMap = Record<string, ModelInfo>

function resolveDynamicFirst<T extends StaticModelMap>(
	routerModels: RouterModels,
	routerKey: keyof RouterModels,
	staticModels: T,
	configuredId: string | undefined,
	defaultModelId: string,
	fallbackInfo?: ModelInfo,
): { id: string; info: ModelInfo | undefined } {
	const dynamicModels = routerModels[routerKey]
	const models =
		dynamicModels && Object.keys(dynamicModels).length > 0 ? dynamicModels : staticModels

	const id = getValidatedModelId(configuredId, models, defaultModelId)
	const dynamicInfo = dynamicModels?.[id]
	const staticInfo = staticModels[id as keyof T]

	if (dynamicInfo) {
		return { id, info: { ...(staticInfo ?? fallbackInfo ?? openAiModelInfoSaneDefaults), ...dynamicInfo } }
	}
	if (staticInfo) {
		return { id, info: staticInfo }
	}
	return { id, info: fallbackInfo }
}

export const useSelectedModel = (apiConfiguration?: ProviderSettings) => {
	const provider = apiConfiguration?.apiProvider || "anthropic"
	const activeProvider: ProviderName | undefined = isRetiredProvider(provider) ? undefined : provider
	const dynamicProvider = activeProvider && isDynamicProvider(activeProvider) ? activeProvider : undefined
	const routerProvider = activeProvider && isRouterModelProvider(activeProvider) ? activeProvider : undefined
	const fetchProvider = dynamicProvider || routerProvider || undefined
	const openRouterModelId = activeProvider === "openrouter" ? apiConfiguration?.openRouterModelId : undefined
	const lmStudioModelId = activeProvider === "lmstudio" ? apiConfiguration?.lmStudioModelId : undefined
	const ollamaModelId = activeProvider === "ollama" ? apiConfiguration?.ollamaModelId : undefined

	const shouldFetchRouterModels = Boolean(fetchProvider)
	const routerModels = useRouterModels({
		provider: fetchProvider,
		enabled: shouldFetchRouterModels,
	})

	const openRouterModelProviders = useOpenRouterModelProviders(openRouterModelId)
	const lmStudioModels = useLmStudioModels(lmStudioModelId)
	const ollamaModels = useOllamaModels(ollamaModelId)

	// Compute readiness only for the data actually needed for the selected provider
	const needRouterModels = shouldFetchRouterModels
	const needOpenRouterProviders = activeProvider === "openrouter"
	const needLmStudio = typeof lmStudioModelId !== "undefined"
	const needOllama = typeof ollamaModelId !== "undefined"

	const hasValidRouterData =
		needRouterModels && dynamicProvider
			? routerModels.data &&
				routerModels.data[dynamicProvider] !== undefined &&
				typeof routerModels.data[dynamicProvider] === "object" &&
				!routerModels.isLoading
			: true

	const isReady =
		(!needLmStudio || typeof lmStudioModels.data !== "undefined") &&
		(!needOllama || typeof ollamaModels.data !== "undefined") &&
		hasValidRouterData &&
		(!needOpenRouterProviders || typeof openRouterModelProviders.data !== "undefined")

	const { id, info } =
		apiConfiguration && isReady && activeProvider
			? getSelectedModel({
					provider: activeProvider,
					apiConfiguration,
					routerModels: (routerModels.data || {}) as RouterModels,
					openRouterModelProviders: (openRouterModelProviders.data || {}) as Record<string, ModelInfo>,
					lmStudioModels: (lmStudioModels.data || undefined) as ModelRecord | undefined,
					ollamaModels: (ollamaModels.data || undefined) as ModelRecord | undefined,
				})
			: { id: getProviderDefaultModelId(activeProvider ?? "anthropic"), info: undefined }

	return {
		provider,
		id,
		info,
		isLoading:
			(needRouterModels && routerModels.isLoading) ||
			(needOpenRouterProviders && openRouterModelProviders.isLoading) ||
			(needLmStudio && lmStudioModels!.isLoading) ||
			(needOllama && ollamaModels!.isLoading),
		isError:
			(needRouterModels && routerModels.isError) ||
			(needOpenRouterProviders && openRouterModelProviders.isError) ||
			(needLmStudio && lmStudioModels!.isError) ||
			(needOllama && ollamaModels!.isError),
	}
}

function getSelectedModel({
	provider,
	apiConfiguration,
	routerModels,
	openRouterModelProviders,
	lmStudioModels,
	ollamaModels,
}: {
	provider: ProviderName
	apiConfiguration: ProviderSettings
	routerModels: RouterModels
	openRouterModelProviders: Record<string, ModelInfo>
	lmStudioModels: ModelRecord | undefined
	ollamaModels: ModelRecord | undefined
}): { id: string; info: ModelInfo | undefined } {
	// the `undefined` case are used to show the invalid selection to prevent
	// users from seeing the default model if their selection is invalid
	// this gives a better UX than showing the default model
	const defaultModelId = getProviderDefaultModelId(provider)
	switch (provider) {
		case "openrouter": {
			const id = getValidatedModelId(apiConfiguration.openRouterModelId, routerModels.openrouter, defaultModelId)
			let info = routerModels.openrouter?.[id]
			const specificProvider = apiConfiguration.openRouterSpecificProvider

			if (specificProvider && openRouterModelProviders[specificProvider]) {
				// Overwrite the info with the specific provider info. Some
				// fields are missing the model info for `openRouterModelProviders`
				// so we need to merge the two.
				info = info
					? { ...info, ...openRouterModelProviders[specificProvider] }
					: openRouterModelProviders[specificProvider]
			}

			return { id, info }
		}
		case "requesty": {
			const id = getValidatedModelId(apiConfiguration.requestyModelId, routerModels.requesty, defaultModelId)
			const routerInfo = routerModels.requesty?.[id]
			return { id, info: routerInfo }
		}
		case "unbound": {
			const id = getValidatedModelId(apiConfiguration.unboundModelId, routerModels.unbound, defaultModelId)
			const routerInfo = routerModels.unbound?.[id]
			return { id, info: routerInfo }
		}
		case "litellm": {
			const id = getValidatedModelId(apiConfiguration.litellmModelId, routerModels.litellm, defaultModelId)
			const routerInfo = routerModels.litellm?.[id]
			return { id, info: routerInfo ?? litellmDefaultModelInfo }
		}
		case "xai": {
			return resolveDynamicFirst(routerModels, "xai", xaiModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "baseten": {
			return resolveDynamicFirst(routerModels, "baseten", basetenModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "bedrock": {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = bedrockModels[id as keyof typeof bedrockModels]

			// Special case for custom ARN.
			if (id === "custom-arn") {
				return {
					id,
					info: { maxTokens: 5000, contextWindow: 128_000, supportsPromptCache: true, supportsImages: true },
				}
			}

			// Apply 1M context for supported Claude 4 models when enabled
			if ((BEDROCK_1M_CONTEXT_MODEL_IDS as readonly string[]).includes(id) && apiConfiguration.awsBedrock1MContext && baseInfo) {
				// Create a new ModelInfo object with updated context window
				const info: ModelInfo = {
					...baseInfo,
					contextWindow: 1_000_000,
				}
				return { id, info }
			}

			return { id, info: baseInfo }
		}
		case "vertex": {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = vertexModels[id as keyof typeof vertexModels]

			// Apply 1M context for supported Claude 4 models when enabled
			if ((VERTEX_1M_CONTEXT_MODEL_IDS as readonly string[]).includes(id) && apiConfiguration.vertex1MContext && baseInfo) {
				const modelInfo: ModelInfo = baseInfo
				const tier = modelInfo.tiers?.[0]
				if (tier) {
					const info: ModelInfo = {
						...modelInfo,
						contextWindow: tier.contextWindow,
						inputPrice: tier.inputPrice,
						outputPrice: tier.outputPrice,
						cacheWritesPrice: tier.cacheWritesPrice,
						cacheReadsPrice: tier.cacheReadsPrice,
					}
					return { id, info }
				}
			}

			return { id, info: baseInfo }
		}
		case "gemini": {
			return resolveDynamicFirst(routerModels, "gemini", geminiModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "deepseek": {
			return resolveDynamicFirst(routerModels, "deepseek", deepSeekModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "moonshot": {
			return resolveDynamicFirst(routerModels, "moonshot", moonshotModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "minimax": {
			return resolveDynamicFirst(routerModels, "minimax", minimaxModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "zai": {
			const isChina = apiConfiguration.zaiApiLine === "china_coding"
			const models = isChina ? mainlandZAiModels : internationalZAiModels
			const defaultModelId = getProviderDefaultModelId(provider, { isChina })
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = models[id as keyof typeof models]
			return { id, info }
		}
		case "openai-native": {
			return resolveDynamicFirst(routerModels, "openai-native", openAiNativeModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "mistral": {
			return resolveDynamicFirst(routerModels, "mistral", mistralModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "openai": {
			const id = apiConfiguration.openAiModelId ?? ""
			const customInfo = apiConfiguration?.openAiCustomModelInfo
			const info = customInfo ?? openAiModelInfoSaneDefaults
			return { id, info }
		}
		case "ollama": {
			const id = apiConfiguration.ollamaModelId ?? ""
			const info = ollamaModels && ollamaModels[apiConfiguration.ollamaModelId!]

			const adjustedInfo =
				info?.contextWindow &&
				apiConfiguration?.ollamaNumCtx &&
				apiConfiguration.ollamaNumCtx < info.contextWindow
					? { ...info, contextWindow: apiConfiguration.ollamaNumCtx }
					: info

			return {
				id,
				info: adjustedInfo || undefined,
			}
		}
		case "lmstudio": {
			const id = apiConfiguration.lmStudioModelId ?? ""
			const modelInfo = lmStudioModels && lmStudioModels[apiConfiguration.lmStudioModelId!]
			return {
				id,
				info: modelInfo ? { ...lMStudioDefaultModelInfo, ...modelInfo } : undefined,
			}
		}
		case "vscode-lm": {
			const id = apiConfiguration?.vsCodeLmModelSelector
				? `${apiConfiguration.vsCodeLmModelSelector.vendor}/${apiConfiguration.vsCodeLmModelSelector.family}`
				: vscodeLlmDefaultModelId
			const modelFamily = apiConfiguration?.vsCodeLmModelSelector?.family ?? vscodeLlmDefaultModelId
			const info = vscodeLlmModels[modelFamily as keyof typeof vscodeLlmModels]
			return { id, info: { ...openAiModelInfoSaneDefaults, ...info, supportsImages: false } } // VSCode LM API currently doesn't support images.
		}
		case "sambanova": {
			return resolveDynamicFirst(routerModels, "sambanova", sambaNovaModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "fireworks": {
			return resolveDynamicFirst(routerModels, "fireworks", fireworksModels, apiConfiguration.apiModelId, defaultModelId)
		}
		case "roo": {
			const id = getValidatedModelId(apiConfiguration.apiModelId, routerModels.roo, defaultModelId)
			const info = routerModels.roo?.[id]
			return { id, info }
		}
		case "qwen-code": {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = qwenCodeModels[id as keyof typeof qwenCodeModels]
			return { id, info }
		}
		case "qwen": {
			return resolveDynamicFirst(routerModels, "qwen", qwenModels, apiConfiguration.apiModelId, defaultModelId, {
				...openAiModelInfoSaneDefaults,
				maxTokens: 8_192,
				contextWindow: 131_072,
				supportsImages: true,
				description: "Custom Qwen model id",
			} satisfies ModelInfo)
		}
		case "doubao": {
			return resolveDynamicFirst(routerModels, "doubao", doubaoModels, apiConfiguration.apiModelId, defaultModelId, {
				...openAiModelInfoSaneDefaults,
				maxTokens: 32_768,
				contextWindow: 262_144,
				supportsImages: true,
				description: "Custom Volcengine Ark model id (console or ep-)",
			} satisfies ModelInfo)
		}
		case "glm": {
			return resolveDynamicFirst(routerModels, "glm", glmModels, apiConfiguration.apiModelId, defaultModelId, {
				...openAiModelInfoSaneDefaults,
				maxTokens: 16_384,
				contextWindow: 131_072,
				supportsImages: true,
				description: "Custom GLM model id",
			} satisfies ModelInfo)
		}
		case "mimo": {
			return resolveDynamicFirst(routerModels, "mimo", mimoModels, apiConfiguration.apiModelId, defaultModelId, {
				...openAiModelInfoSaneDefaults,
				maxTokens: 128_000,
				contextWindow: 1_000_000,
				supportsImages: false,
				description: "Custom MiMo model id",
			} satisfies ModelInfo)
		}
		case "mimo-token-plan": {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = mimoTokenPlanModels[id as keyof typeof mimoTokenPlanModels]
			return { id, info }
		}
		case "openai-codex": {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = openAiCodexModels[id as keyof typeof openAiCodexModels]
			return { id, info }
		}
		case "vercel-ai-gateway": {
			const id = getValidatedModelId(
				apiConfiguration.vercelAiGatewayModelId,
				routerModels["vercel-ai-gateway"],
				defaultModelId,
			)
			const info = routerModels["vercel-ai-gateway"]?.[id]
			return { id, info }
		}
		case "anthropic": {
			const resolved = resolveDynamicFirst(routerModels, "anthropic", anthropicModels, apiConfiguration.apiModelId, defaultModelId)
			let info = resolved.info

			if (
				(resolved.id === "claude-sonnet-4-20250514" ||
					resolved.id === "claude-sonnet-4-5" ||
					resolved.id === "claude-sonnet-4-6" ||
					resolved.id === "claude-opus-4-6") &&
				apiConfiguration.anthropicBeta1MContext &&
				info
			) {
				const modelWithTiers = info as typeof info & {
					tiers?: Array<{
						contextWindow: number
						inputPrice?: number
						outputPrice?: number
						cacheWritesPrice?: number
						cacheReadsPrice?: number
					}>
				}
				const tier = modelWithTiers.tiers?.[0]
				if (tier) {
					info = {
						...info,
						contextWindow: tier.contextWindow,
						inputPrice: tier.inputPrice ?? info.inputPrice,
						outputPrice: tier.outputPrice ?? info.outputPrice,
						cacheWritesPrice: tier.cacheWritesPrice ?? info.cacheWritesPrice,
						cacheReadsPrice: tier.cacheReadsPrice ?? info.cacheReadsPrice,
					}
				}
			}

			return { id: resolved.id, info }
		}
		// case "gemini-cli":
		// case "fake-ai":
		default: {
			provider satisfies "gemini-cli" | "fake-ai"
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = anthropicModels[id as keyof typeof anthropicModels]

			return { id, info: baseInfo }
		}
	}
}
