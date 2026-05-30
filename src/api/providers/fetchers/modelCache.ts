import * as path from "path"
import fs from "fs/promises"
import * as fsSync from "fs"

import NodeCache from "node-cache"
import { z } from "zod"

import type { ProviderName, ModelRecord } from "@njust-ai/types"
import { modelInfoSchema } from "@njust-ai/types"

import { logger } from "../../../shared/logger"
import { safeWriteJson } from "../../../utils/safeWriteJson"

import { ContextProxy } from "../../../core/config/ContextProxy"
import { getCacheDirectoryPath } from "../../../utils/storage"
import type { RouterName } from "../../../shared/api"
import { fileExistsAtPath } from "../../../utils/fs"

import { getOpenRouterModels } from "./openrouter"
import { getVercelAiGatewayModels } from "./vercel-ai-gateway"
import { getRequestyModels } from "./requesty"
import { getUnboundModels } from "./unbound"
import { getLiteLLMModels } from "./litellm"
import { GetModelsOptions } from "../../../shared/api"
import { getOllamaModels } from "./ollama"
import { getLMStudioModels } from "./lmstudio"
import { getRooModels } from "./njust-ai"
import { TIMING } from "../../../shared/constants"

import type { DynamicModelInfo, DynamicModelRecord, ListModelsOptions, FetcherKind } from "../modelTypes"
import { providerFetcherMap } from "../providerFetcherMap"
import { fallbackModels } from "../fallbackModels"
import { fetchOpenAICompatibleModels } from "./openai-compatible"
import { fetchAnthropicModels } from "./anthropic"
import { fetchGeminiModels } from "./gemini"

const memoryCache = new NodeCache({ stdTTL: TIMING.MODEL_CACHE_TTL_S, checkperiod: TIMING.MODEL_CACHE_TTL_S })

// Zod schema for validating ModelRecord structure from disk cache
const modelRecordSchema = z.record(z.string(), modelInfoSchema)

const diskCacheEntrySchema = z.object({
	timestamp: z.number(),
	models: z.record(z.string(), modelInfoSchema),
})

// Track in-flight refresh requests to prevent concurrent API calls for the same provider
// This prevents race conditions where multiple calls might overwrite each other's results
const inFlightRefresh = new Map<RouterName, Promise<ModelRecord>>()

async function writeModels(router: RouterName, data: ModelRecord) {
	const filename = `${router}_models.json`
	const cacheDir = await getCacheDirectoryPath(ContextProxy.instance.globalStorageUri.fsPath)
	await safeWriteJson(path.join(cacheDir, filename), data)
}

async function _readModels(router: RouterName): Promise<ModelRecord | undefined> {
	const filename = `${router}_models.json`
	const cacheDir = await getCacheDirectoryPath(ContextProxy.instance.globalStorageUri.fsPath)
	const filePath = path.join(cacheDir, filename)
	const exists = await fileExistsAtPath(filePath)
	if (!exists) {
		return undefined
	}

	return modelRecordSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")))
}

/**
 * Fetch models from the provider API.
 * Extracted to avoid duplication between getModels() and refreshModels().
 *
 * @param options - Provider options for fetching models
 * @returns Fresh models from the provider API
 */
async function fetchModelsFromProvider(options: GetModelsOptions): Promise<ModelRecord> {
	const { provider } = options

	let models: ModelRecord

	switch (provider) {
		case "openrouter":
			models = await getOpenRouterModels()
			break
		case "requesty":
			// Requesty models endpoint requires an API key for per-user custom policies.
			models = await getRequestyModels(options.baseUrl, options.apiKey)
			break
		case "unbound":
			models = await getUnboundModels(options.apiKey)
			break
		case "litellm":
			// Type safety ensures apiKey and baseUrl are always provided for LiteLLM.
			models = await getLiteLLMModels(options.apiKey, options.baseUrl)
			break
		case "ollama":
			models = await getOllamaModels(options.baseUrl, options.apiKey)
			break
		case "lmstudio":
			models = await getLMStudioModels(options.baseUrl)
			break
		case "vercel-ai-gateway":
			models = await getVercelAiGatewayModels()
			break
		case "njust-ai": {
			const rooBaseUrl = options.baseUrl ?? process.env.NJUST_AI_PROVIDER_URL ?? ""
			if (!rooBaseUrl) {
				return {}
			}
			models = await getRooModels(rooBaseUrl, options.apiKey)
			break
		}
		default: {
			throw new Error(`fetchModelsFromProvider does not support provider: ${provider as string}`)
		}
	}

	return models
}

/**
 * Get models from the cache or fetch them from the provider and cache them.
 * There are two caches:
 * 1. Memory cache - This is a simple in-memory cache that is used to store models for a short period of time.
 * 2. File cache - This is a file-based cache that is used to store models for a longer period of time.
 *
 * @param router - The router to fetch models from.
 * @param apiKey - Optional API key for the provider.
 * @param baseUrl - Optional base URL for the provider (currently used only for LiteLLM).
 * @returns The models from the cache or the fetched models.
 */
export const getModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
	const { provider } = options

	let models = getModelsFromCache(provider)

	if (models) {
		return models
	}

	try {
		models = await fetchModelsFromProvider(options)
		const modelCount = Object.keys(models).length

		// Only cache non-empty results to prevent persisting failed API responses
		// Empty results could indicate API failure rather than "no models exist"
		if (modelCount > 0) {
			memoryCache.set(provider, models)

			await writeModels(provider, models).catch((err) =>
				logger.error("ModelCache", `Error writing ${provider} models to file cache:`, err),
			)
		} else {
			// Empty results - do nothing
		}

		return models
	} catch (error) {
		// Log the error and re-throw it so the caller can handle it (e.g., show a UI message).
		logger.error("ModelCache", `Failed to fetch models in modelCache for ${provider}:`, error)

		throw error // Re-throw the original error to be handled by the caller.
	}
}

/**
 * Force-refresh models from API, bypassing cache.
 * Uses atomic writes so cache remains available during refresh.
 * This function also prevents concurrent API calls for the same provider using
 * in-flight request tracking to avoid race conditions.
 *
 * @param options - Provider options for fetching models
 * @returns Fresh models from API, or existing cache if refresh yields worse data
 */
export const refreshModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
	const { provider } = options

	// Check if there's already an in-flight refresh for this provider
	// This prevents race conditions where multiple concurrent refreshes might
	// overwrite each other's results
	const existingRequest = inFlightRefresh.get(provider)
	if (existingRequest) {
		return existingRequest
	}

	// Create the refresh promise and track it
	const refreshPromise = (async (): Promise<ModelRecord> => {
		try {
			// Force fresh API fetch - skip getModelsFromCache() check
			const models = await fetchModelsFromProvider(options)
			const modelCount = Object.keys(models).length

			// Get existing cached data for comparison
			const existingCache = getModelsFromCache(provider)
			const existingCount = existingCache ? Object.keys(existingCache).length : 0

			if (modelCount === 0) {
				if (existingCount > 0) {
					return existingCache!
				} else {
					return {}
				}
			}

			// Update memory cache first
			memoryCache.set(provider, models)

			// Atomically write to disk (safeWriteJson handles atomic writes)
			await writeModels(provider, models).catch((err) =>
				logger.error("ModelCache", `Error writing ${provider} models to disk:`, err),
			)

			return models
		} catch (error) {
			// Log the error for debugging, then return existing cache if available (graceful degradation)
			logger.error("ModelCache", `Failed to refresh ${provider} models:`, error)
			return getModelsFromCache(provider) || {}
		} finally {
			// Always clean up the in-flight tracking
			inFlightRefresh.delete(provider)
		}
	})()

	// Track the in-flight request
	inFlightRefresh.set(provider, refreshPromise)

	return refreshPromise
}

/**
 * Initialize background model cache refresh.
 * Refreshes public provider caches without blocking or requiring auth.
 * Should be called once during extension activation.
 */
export function initializeModelCacheRefresh(): void {
	// Wait for extension to fully activate before refreshing
	setTimeout(async () => {
		// Providers that work without API keys
		const publicProviders: Array<{ provider: RouterName; options: GetModelsOptions }> = [
			{ provider: "openrouter", options: { provider: "openrouter" } },
			{ provider: "vercel-ai-gateway", options: { provider: "vercel-ai-gateway" } },
		]

		// Refresh each provider in background (fire and forget)
		for (const { options } of publicProviders) {
			refreshModels(options).catch(() => {
				// Silent fail - old cache remains available
			})

			// Small delay between refreshes to avoid API rate limits
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
	}, 2000)
}

/**
 * Flush models memory cache for a specific router.
 *
 * @param options - The options for fetching models, including provider, apiKey, and baseUrl
 * @param refresh - If true, immediately fetch fresh data from API
 */
export const flushModels = async (options: GetModelsOptions, refresh: boolean = false): Promise<void> => {
	const { provider } = options
	if (refresh) {
		// Don't delete memory cache - let refreshModels atomically replace it
		// This prevents a race condition where getModels() might be called
		// before refresh completes, avoiding a gap in cache availability
		// Await the refresh to ensure the cache is updated before returning
		await refreshModels(options)
	} else {
		// Only delete memory cache when not refreshing
		memoryCache.del(provider)
	}
}

/**
 * Get models from cache, checking memory first, then disk.
 * This ensures providers always have access to last known good data,
 * preventing fallback to hardcoded defaults on startup.
 *
 * @param provider - The provider to get models for.
 * @returns Models from memory cache, disk cache, or undefined if not cached.
 */
export function getModelsFromCache(provider: ProviderName): ModelRecord | undefined {
	// Check memory cache first (fast)
	const memoryModels = memoryCache.get<ModelRecord>(provider)
	if (memoryModels) {
		return memoryModels
	}

	// Memory cache miss - try to load from disk synchronously
	// This is acceptable because it only happens on cold start or after cache expiry
	try {
		const filename = `${provider}_models.json`
		const cacheDir = getCacheDirectoryPathSync()
		if (!cacheDir) {
			return undefined
		}

		const filePath = path.join(cacheDir, filename)

		// Use synchronous fs to avoid async complexity in getModel() callers
		if (fsSync.existsSync(filePath)) {
			const data = fsSync.readFileSync(filePath, "utf8")
			const models = JSON.parse(data)

			// Validate the disk cache data structure using Zod schema
			// This ensures the data conforms to ModelRecord = Record<string, ModelInfo>
			const validation = modelRecordSchema.safeParse(models)
			if (!validation.success) {
				logger.error("ModelCache", `Invalid disk cache data structure for ${provider}:`, validation.error.format())
				return undefined
			}

			// Populate memory cache for future fast access
			memoryCache.set(provider, validation.data)

			return validation.data
		}
	} catch (error) {
		logger.error("ModelCache", `Error loading ${provider} models from disk:`, error)
	}

	return undefined
}

/**
 * Synchronous version of getCacheDirectoryPath for use in getModelsFromCache.
 * Returns the cache directory path without async operations.
 */
function getCacheDirectoryPathSync(): string | undefined {
	try {
		const globalStoragePath = ContextProxy.instance?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			return undefined
		}
		const cachePath = path.join(globalStoragePath, "cache")
		return cachePath
	} catch (error) {
		logger.error("ModelCache", "Error getting cache directory path:", error)
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Dynamic model fetching (Step 1-7: core module)
// ---------------------------------------------------------------------------

const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

const dynamicMemoryCache = new NodeCache({
	stdTTL: TIMING.MODEL_CACHE_TTL_S,
	checkperiod: TIMING.MODEL_CACHE_TTL_S,
})

const dynamicInFlight = new Map<ProviderName, Promise<DynamicModelRecord>>()

function getDynamicDiskCachePath(provider: ProviderName): string | undefined {
	const cacheDir = getCacheDirectoryPathSync()
	if (!cacheDir) return undefined
	return path.join(cacheDir, `dynamic_${provider}_models.json`)
}

interface DiskCacheEntry {
	timestamp: number
	models: DynamicModelRecord
}

function readDynamicDiskCache(provider: ProviderName): DiskCacheEntry | undefined {
	const filePath = getDynamicDiskCachePath(provider)
	if (!filePath) return undefined
	const exists = fsSync.existsSync(filePath)
	if (!exists) return undefined

	try {
		const raw = fsSync.readFileSync(filePath, "utf8")
		const parsed = JSON.parse(raw)
		const validation = diskCacheEntrySchema.safeParse(parsed)
		if (!validation.success) {
			logger.error("ModelCache", `Invalid dynamic disk cache for ${provider}:`, validation.error.format())
			return undefined
		}
		const entry: DiskCacheEntry = { timestamp: validation.data.timestamp, models: validation.data.models as DynamicModelRecord }
		return entry
	} catch (error) {
		logger.error("ModelCache", `Error reading dynamic disk cache for ${provider}:`, error)
		return undefined
	}
}

async function writeDynamicDiskCache(provider: ProviderName, models: DynamicModelRecord): Promise<void> {
	const cacheDir = getCacheDirectoryPathSync()
	if (!cacheDir) return

	const filePath = path.join(cacheDir, `dynamic_${provider}_models.json`)
	const entry: DiskCacheEntry = { timestamp: Date.now(), models }

	await safeWriteJson(filePath, entry).catch((err) =>
		logger.error("ModelCache", `Error writing dynamic disk cache for ${provider}:`, err),
	)
}

function isCacheFresh(timestamp: number): boolean {
	return Date.now() - timestamp < DISK_CACHE_TTL_MS
}

function tagWithSource(models: DynamicModelRecord, source: DynamicModelInfo["source"]): DynamicModelRecord {
	const tagged: DynamicModelRecord = {}
	for (const [id, info] of Object.entries(models)) {
		tagged[id] = { ...info, source }
	}
	return tagged
}

async function fetchDynamicModels(
	provider: ProviderName,
	options: ListModelsOptions,
): Promise<DynamicModelRecord> {
	const kind: FetcherKind | undefined = providerFetcherMap[provider]

	switch (kind) {
		case "openai-compatible":
			return fetchOpenAICompatibleModels(provider, options)
		case "anthropic":
			return fetchAnthropicModels(options)
		case "gemini":
			return fetchGeminiModels(options)
		default:
			throw new Error(`No dynamic fetcher for provider: ${provider} (kind: ${kind})`)
	}
}

export async function listProviderModels(
	provider: ProviderName,
	options: ListModelsOptions = {},
): Promise<DynamicModelRecord> {
	const kind: FetcherKind | undefined = providerFetcherMap[provider]

	if (kind === "fallback-only" || !kind) {
		return fallbackModels[provider] ?? {}
	}

	if (kind === "existing") {
		return {}
	}

	if (!options.forceRefresh) {
		const mem = dynamicMemoryCache.get<DynamicModelRecord>(provider)
		if (mem) return mem

		const disk = readDynamicDiskCache(provider)
		if (disk && isCacheFresh(disk.timestamp)) {
			const tagged = tagWithSource(disk.models, "disk-cache")
			dynamicMemoryCache.set(provider, tagged)
			return tagged
		}
	}

	const existing = dynamicInFlight.get(provider)
	if (existing) return existing

	const promise = (async (): Promise<DynamicModelRecord> => {
		try {
			const fetched = await fetchDynamicModels(provider, options)
			const count = Object.keys(fetched).length

			if (count === 0) {
				const disk = readDynamicDiskCache(provider)
				if (disk) {
					const source = isCacheFresh(disk.timestamp) ? "disk-cache" : "stale-disk-cache"
					const tagged = tagWithSource(disk.models, source)
					return tagged
				}
				return fallbackModels[provider] ?? {}
			}

			const tagged = tagWithSource(fetched, "api")
			dynamicMemoryCache.set(provider, tagged)

			await writeDynamicDiskCache(provider, tagged).catch(() => {})

			return tagged
		} catch (error) {
			logger.error("ModelCache", `Dynamic fetch failed for ${provider}:`, error)

			const disk = readDynamicDiskCache(provider)
			if (disk) {
				const tagged = tagWithSource(disk.models, "stale-disk-cache")
				return tagged
			}

			return fallbackModels[provider] ?? {}
		} finally {
			dynamicInFlight.delete(provider)
		}
	})()

	dynamicInFlight.set(provider, promise)
	return promise
}
