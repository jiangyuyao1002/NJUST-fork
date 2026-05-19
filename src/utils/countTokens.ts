import { Anthropic } from "@anthropic-ai/sdk"
import workerpool from "workerpool"

import { logger } from "../shared/logger"
import { countTokensResultSchema } from "../workers/types"
import { tiktoken } from "./tiktoken"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

let pool: workerpool.Pool | null | undefined = undefined

export type CountTokensOptions = {
	useWorker?: boolean
}

export interface TokenCountResult {
	total: number
	input?: number
	output?: number
	cacheRead?: number
	cacheCreation?: number
	strategy: "native" | "tiktoken" | "estimated"
}

export async function countTokens(
	content: Anthropic.Messages.ContentBlockParam[],
	{ useWorker = true }: CountTokensOptions = {},
): Promise<number> {
	const result = await countTokensDetailed(content, { useWorker })
	return result.total
}

export async function countTokensDetailed(
	content: Anthropic.Messages.ContentBlockParam[],
	{ useWorker = true }: CountTokensOptions = {},
): Promise<TokenCountResult> {
	if (content.length === 0) {
		return { total: 0, strategy: "tiktoken" }
	}

	// Lazily create the worker pool if it doesn't exist.
	if (useWorker && typeof pool === "undefined") {
		pool = workerpool.pool(__dirname + "/workers/countTokens.js", {
			maxWorkers: 1,
			maxQueueSize: 10,
		})
	}

	// If the worker pool doesn't exist or the caller doesn't want to use it
	// then, use the non-worker implementation.
	if (!useWorker || !pool) {
		return { total: await tiktoken(content), strategy: "tiktoken" }
	}

	try {
		const data = await pool.exec("countTokens", [content])
		const result = countTokensResultSchema.parse(data)

		if (!result.success) {
			throw new Error(result.error)
		}

		return { total: result.count, strategy: "tiktoken" }
	} catch (error) {
		pool = null
		logger.error("CountTokens", String(error))
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
		return { total: await tiktoken(content), strategy: "tiktoken" }
	}
}
