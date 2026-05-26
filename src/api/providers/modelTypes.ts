import type { ModelInfo } from "@njust-ai-cj/types"

export type ModelSource =
	| "api"
	| "disk-cache"
	| "stale-disk-cache"
	| "hardcoded-fallback"

export interface DynamicModelInfo extends ModelInfo {
	source: ModelSource
}

export type DynamicModelRecord = Record<string, DynamicModelInfo>

export interface ListModelsOptions {
	apiKey?: string
	baseUrl?: string
	forceRefresh?: boolean
}

export type FetcherKind =
	| "openai-compatible"
	| "anthropic"
	| "gemini"
	| "existing"
	| "fallback-only"

export type ModelFetcher = (
	options: ListModelsOptions,
) => Promise<DynamicModelRecord>
