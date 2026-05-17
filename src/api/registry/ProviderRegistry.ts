import { isRetiredProvider, type ProviderSettings } from "@njust-ai-cj/types"

import type { ApiHandler } from "../index"
import type { ApiHandlerOptions } from "../../shared/api"
import { defaultToolCallParser } from "../../core/assistant-message/ToolCallParserImpl"

export type ProviderId = NonNullable<ProviderSettings["apiProvider"]>

export type TokenCountingStrategy = "native" | "tiktoken" | "estimated"

export type ProviderFactory = (options: ApiHandlerOptions) => ApiHandler

export interface ProviderRegistration {
	factory: ProviderFactory
	tokenCountingStrategy: TokenCountingStrategy
}

export type ProviderRegistrationOptions = {
	tokenCountingStrategy?: TokenCountingStrategy
	override?: boolean
}

/**
 * Central registry for API handler construction (report D.1).
 *
 * Supports self-registration: individual provider modules can call
 * `providerRegistry.register(id, factory)` at import time. Unknown providers
 * fail fast instead of bypassing the registry with a hidden fallback.
 */
export class ProviderRegistry {
	private readonly factories = new Map<ProviderId, ProviderFactory>()
	private readonly strategies = new Map<ProviderId, TokenCountingStrategy>()

	constructor() {
		// Provider auto-registration is handled via import of register-all
		// at the extension entry point (see src/api/index.ts)
	}

	/**
	 * Register (or override) a handler factory for a provider ID.
	 * Providers can call this at module load time for self-registration.
	 */
	register(id: ProviderId, factory: ProviderFactory, strategyOrOptions?: TokenCountingStrategy | ProviderRegistrationOptions): void {
		const options =
			typeof strategyOrOptions === "string"
				? { tokenCountingStrategy: strategyOrOptions }
				: (strategyOrOptions ?? {})

		if (this.factories.has(id) && !options.override) {
			throw new Error(`Provider "${id}" is already registered`)
		}

		this.factories.set(id, factory)
		this.strategies.set(id, options.tokenCountingStrategy ?? "tiktoken")
	}

	/** List all currently registered provider IDs. */
	getRegisteredIds(): ProviderId[] {
		return [...this.factories.keys()]
	}

	has(id: ProviderId): boolean {
		return this.factories.has(id)
	}

	get(id: ProviderId): ProviderRegistration | undefined {
		const factory = this.factories.get(id)
		if (!factory) {
			return undefined
		}
		return {
			factory,
			tokenCountingStrategy: this.getTokenCountingStrategy(id),
		}
	}

	size(): number {
		return this.factories.size
	}

	getTokenCountingStrategy(id: ProviderId): TokenCountingStrategy {
		return this.strategies.get(id) ?? "tiktoken"
	}

	createHandler(configuration: ProviderSettings): ApiHandler {
		const { apiProvider, ...optionsBase } = configuration
		const options: ApiHandlerOptions = {
			...optionsBase,
			toolCallParser: defaultToolCallParser,
		}

		if (apiProvider && isRetiredProvider(apiProvider)) {
			throw new Error(
				`Sorry, this provider is no longer supported. We saw very few Roo users actually using it and we need to reduce the surface area of our codebase so we can keep shipping fast and serving our community well in this space. It was a really hard decision but it lets us focus on what matters most to you. It sucks, we know.\n\nPlease select a different provider in your API profile settings.`,
			)
		}

		const id = apiProvider ?? "anthropic"
		const factory = this.factories.get(id as ProviderId)
		if (!factory) {
			throw new Error(`API provider "${id}" is not registered`)
		}
		return factory(options)
	}
}

export const providerRegistry = new ProviderRegistry()
