import * as path from "path"
import fs from "fs/promises"

import NodeCache from "node-cache"
import sanitize from "sanitize-filename"
import { z } from "zod"

import { modelInfoSchema, type ModelRecord } from "@njust-ai/types"

import { RouterName } from "../../../shared/api"
import { getCacheDirectoryPath } from "../../../utils/storage"
import { fileExistsAtPath } from "../../../utils/fs"
import { logger } from "../../../shared/logger"
import { safeWriteJson } from "../../../utils/safeWriteJson"

import { getModelCacheStore } from "./modelCacheStore"
import { getOpenRouterModelEndpoints } from "./openrouter"
import { getModels } from "./modelCache"

const memoryCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 5 * 60 })
const modelRecordSchema = z.record(z.string(), modelInfoSchema)

const getCacheKey = (router: RouterName, modelId: string) => sanitize(`${router}_${modelId}`)

async function writeModelEndpoints(key: string, data: ModelRecord) {
	const basePath = getModelCacheStore()?.globalStorageUri.fsPath
	if (!basePath) {
		logger.debug("ModelEndpointCache", `Skipping ${key} endpoint write: cacheStore not initialized`)
		return
	}
	const filename = `${key}_endpoints.json`
	const cacheDir = await getCacheDirectoryPath(basePath)
	await safeWriteJson(path.join(cacheDir, filename), data)
}

async function readModelEndpoints(key: string): Promise<ModelRecord | undefined> {
	const basePath = getModelCacheStore()?.globalStorageUri.fsPath
	if (!basePath) {
		return undefined
	}
	const filename = `${key}_endpoints.json`
	const cacheDir = await getCacheDirectoryPath(basePath)
	const filePath = path.join(cacheDir, filename)
	const exists = await fileExistsAtPath(filePath)
	if (!exists) {
		return undefined
	}
	return modelRecordSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")))
}

export const getModelEndpoints = async ({
	router,
	modelId,
	endpoint,
}: {
	router: RouterName
	modelId?: string
	endpoint?: string
}): Promise<ModelRecord> => {
	// OpenRouter is the only provider that supports model endpoints, but you
	// can see how we'd extend this to other providers in the future.
	if (router !== "openrouter" || !modelId || !endpoint) {
		return {}
	}

	const key = getCacheKey(router, modelId)
	let modelProviders = memoryCache.get<ModelRecord>(key)

	if (modelProviders) {
		return modelProviders
	}

	modelProviders = await getOpenRouterModelEndpoints(modelId)

	// Copy model-level capabilities from the parent model to each endpoint
	// These are capabilities that don't vary by provider (tools, reasoning, etc.)
	if (Object.keys(modelProviders).length > 0) {
		const parentModels = await getModels({ provider: "openrouter" })
		const parentModel = parentModels[modelId]

		if (parentModel) {
			// Copy model-level capabilities to all endpoints
			// Clone arrays to avoid shared mutable references
			for (const endpointKey of Object.keys(modelProviders)) {
				modelProviders[endpointKey]!.supportsReasoningEffort = parentModel.supportsReasoningEffort
				modelProviders[endpointKey]!.supportedParameters = parentModel.supportedParameters
					? [...parentModel.supportedParameters]
					: undefined
			}
		}
	}

	if (Object.keys(modelProviders).length > 0) {
		memoryCache.set(key, modelProviders)

		try {
			await writeModelEndpoints(key, modelProviders)
		} catch (error) {
			logger.error("ModelEndpointCache", `Error writing ${key} endpoints to file cache`, error)
		}

		return modelProviders
	}

	try {
		modelProviders = await readModelEndpoints(router)
	} catch (error) {
		logger.error("ModelEndpointCache", `Error reading ${key} endpoints from file cache`, error)
	}

	return modelProviders ?? {}
}

export const flushModelProviders = (router: RouterName, modelId: string) =>
	memoryCache.del(getCacheKey(router, modelId))
