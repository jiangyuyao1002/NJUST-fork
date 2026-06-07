/**
 * MemRL dedicated embedder factory.
 *
 * Builds an OpenAI-compatible embedder for the memory system that is INDEPENDENT
 * of the user's code-index embedder configuration. This lets memory always embed
 * with a known model, even if the user has code-index set to Ollama / disabled.
 *
 * Configuration is resolved at RUNTIME with precedence:
 *   1. VSCode setting   (njust-ai.memrl.embedding*)   — production, user-editable
 *   2. Environment var  (MEMRL_EMBED_*)                  — dev (launch.json) / CI / build inject
 *   3. Code default     (siliconflow + bge-m3)
 *
 * Returns undefined when no API key is resolved, so the caller can fall back to a
 * caller-supplied embedder or a no-op stub.
 */

import * as vscode from "vscode"
import type { IEmbedder } from "../../code-index/interfaces/embedder"
import { OpenAICompatibleEmbedder } from "../../code-index/embedders/openai-compatible"
import { logger } from "../../../shared/logger"
import { Package } from "../../../shared/package"
import {
	MEMORY_EMBED_SETTING_BASE_URL,
	MEMORY_EMBED_SETTING_API_KEY,
	MEMORY_EMBED_SETTING_MODEL,
	MEMORY_EMBED_ENV_BASE_URL,
	MEMORY_EMBED_ENV_KEY,
	MEMORY_EMBED_ENV_MODEL,
	MEMORY_EMBED_DEFAULT_BASE_URL,
	MEMORY_EMBED_DEFAULT_MODEL,
} from "./constants"

/**
 * Resolve a single value: VSCode setting → env var → default.
 * Reads are wrapped so a missing/mocked vscode API can't throw.
 */
function resolveSetting(settingKey: string, envKey: string, def: string): string {
	try {
		const fromConfig = vscode.workspace.getConfiguration(Package.name).get<string>(settingKey)
		if (fromConfig?.trim()) return fromConfig.trim()
	} catch {
		/* vscode API unavailable (e.g. unit test without mock) — fall through */
	}
	const fromEnv = process.env[envKey]
	if (fromEnv?.trim()) return fromEnv.trim()
	return def
}

function resolveBaseUrl(): string {
	return resolveSetting(MEMORY_EMBED_SETTING_BASE_URL, MEMORY_EMBED_ENV_BASE_URL, MEMORY_EMBED_DEFAULT_BASE_URL)
}

function resolveApiKey(): string {
	return resolveSetting(MEMORY_EMBED_SETTING_API_KEY, MEMORY_EMBED_ENV_KEY, "")
}

function resolveModel(): string {
	return resolveSetting(MEMORY_EMBED_SETTING_MODEL, MEMORY_EMBED_ENV_MODEL, MEMORY_EMBED_DEFAULT_MODEL)
}

export function createMemoryEmbedder(): IEmbedder | undefined {
	const baseUrl = resolveBaseUrl()
	const apiKey = resolveApiKey()
	const model = resolveModel()

	if (!baseUrl || !apiKey) {
		logger.warn(
			"MemRL",
			"memory embedder not configured (set njust-ai.memrl.embeddingApiKey or MEMRL_EMBED_API_KEY) — retrieval disabled",
		)
		return undefined
	}
	try {
		return new OpenAICompatibleEmbedder(baseUrl, apiKey, model)
	} catch (err) {
		logger.warn("MemRL", "failed to create memory embedder", err)
		return undefined
	}
}

/**
 * Fingerprint of the embedding model used to write vectors. Persisted alongside
 * the memory store so that, when the model changes, incompatible old vectors can
 * be auto-discarded instead of silently failing cosine similarity.
 *
 * Granularity = model id. Two providers hosting the SAME open-source model
 * (e.g. bge-m3) produce compatible vectors, so we key on model, not base URL.
 */
export function currentEmbedFingerprint(): string {
	return resolveModel()
}
