import { type SambaNovaModelId, sambaNovaDefaultModelId, sambaNovaModels } from "@njust-ai-cj/core/providers"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export class SambaNovaHandler extends BaseOpenAiCompatibleProvider<SambaNovaModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "SambaNova",
			baseURL: "https://api.sambanova.ai/v1",
			apiKey: options.sambaNovaApiKey,
			defaultProviderModelId: sambaNovaDefaultModelId,
			providerModels: sambaNovaModels,
			defaultTemperature: 0.7,
		})
	}
}
