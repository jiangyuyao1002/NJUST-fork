import { Anthropic } from "@anthropic-ai/sdk"

import { type ProviderSettings, type ModelInfo } from "@njust-ai/types"

import { ApiStream } from "./transform/stream"
import { ModelFallbackManager, type FallbackConfig } from "../core/task/ModelFallback"
import { defaultToolCallParser } from "../core/assistant-message/ToolCallParserImpl"

import { providerRegistry } from "./registry/ProviderRegistry"
import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "./types"

// Auto-register all built-in providers (side-effect import)
import "./providers/register-all"

export type { ApiHandler, ApiHandlerCreateMessageMetadata, SingleCompletionHandler } from "./types"

export interface FallbackProviderConfig {
	/** Fallback provider settings (used when primary provider fails) */
	fallbackProvider?: ProviderSettings
	/** Fallback behavior configuration */
	fallbackConfig?: Partial<FallbackConfig>
}

export interface ApiHandlerDependencies {
	/** Callback to persist secrets to VS Code SecretStorage. */
	storeSecret?: (key: string, value: string) => Promise<void>
}

export function buildApiHandler(
	configuration: ProviderSettings,
	fallbackOptions?: FallbackProviderConfig,
	dependencies?: ApiHandlerDependencies,
): ApiHandler {
	const handler = createHandler(configuration, dependencies)

	if (fallbackOptions?.fallbackProvider) {
		const fallbackHandler = createHandler(fallbackOptions.fallbackProvider, dependencies)
		const primaryModelId = handler.getModel().id
		const fallbackModelId = fallbackHandler.getModel().id

		const fallbackManager = new ModelFallbackManager(primaryModelId, {
			...fallbackOptions.fallbackConfig,
			fallbackModels: [fallbackModelId, ...(fallbackOptions.fallbackConfig?.fallbackModels ?? [])],
		})

		return new FallbackApiHandler(handler, fallbackHandler, fallbackManager)
	}

	return handler
}

function createHandler(configuration: ProviderSettings, dependencies?: ApiHandlerDependencies): ApiHandler {
	return providerRegistry.createHandler(configuration, {
		toolCallParser: defaultToolCallParser,
		storeSecret: dependencies?.storeSecret,
	})
}

/**
 * Wrapper handler that delegates to a fallback handler when the primary handler
 * is in fallback mode. The fallback manager tracks failure/success state.
 */
class FallbackApiHandler implements ApiHandler {
	public readonly fallbackManager: ModelFallbackManager

	constructor(
		private primaryHandler: ApiHandler,
		private fallbackHandler: ApiHandler,
		fallbackManager: ModelFallbackManager,
	) {
		this.fallbackManager = fallbackManager
	}

	private get activeHandler(): ApiHandler {
		return this.fallbackManager.isInFallbackMode() ? this.fallbackHandler : this.primaryHandler
	}

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		return this.activeHandler.createMessage(systemPrompt, messages, metadata)
	}

	getModel(): { id: string; info: ModelInfo } {
		return this.activeHandler.getModel()
	}

	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		return this.activeHandler.countTokens(content)
	}
}
