import type { UnsafeAny } from "@njust-ai-cj/types"
import { logger } from "./logger.js"
import type { ModelInfo } from "@njust-ai-cj/types"
import type { ServiceTier } from "@njust-ai-cj/types"

/**
 * Normalize OpenAI-style usage numbers before billing.
 *
 * - `input_tokens` / `prompt_tokens` are usually **total** prompt tokens including cache reads/writes,
 *   but some responses only report the non-cached slice while still emitting `cache_read_input_tokens`.
 * - When `input_tokens_details` / `prompt_tokens_details` expose `cache_miss_tokens` + `cached_tokens`,
 *   we prefer that breakdown for the non-cached slice (avoids mis-pricing when totals are inconsistent).
 */
export function resolveOpenAiUsageForCost(args: {
	inputTokensReported: number
	cacheWriteTokens: number
	cacheReadTokens: number
	cacheMissTokensFromDetails?: number
	cachedTokensFromDetails?: number
}): {
	totalInputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	nonCachedInputTokens: number
} {
	const cw = Math.max(0, args.cacheWriteTokens || 0)
	let cr = Math.max(0, args.cacheReadTokens || 0)
	let total = Math.max(0, args.inputTokensReported || 0)

	const miss = args.cacheMissTokensFromDetails
	const cachedD = args.cachedTokensFromDetails

	if (typeof miss === "number" && typeof cachedD === "number") {
		cr = Math.max(cr, cachedD)
		const sumParts = miss + cachedD + cw
		if (sumParts > 0) {
			const tolerance = Math.max(1, Math.ceil(sumParts * 0.005))
			if (total === 0 || Math.abs(total - sumParts) <= tolerance) {
				total = sumParts
			} else if (total < sumParts - tolerance) {
				logger.warn("Cost", `Token mismatch beyond tolerance: reported=${total}, sumParts=${sumParts} (miss=${miss}, cached=${cachedD}, writes=${cw}), tolerance=${tolerance}`)
				// Total likely excludes cached portion; reconstruct billable prompt size
				total = sumParts
			}
		}
		return {
			totalInputTokens: total,
			cacheWriteTokens: cw,
			cacheReadTokens: cr,
			nonCachedInputTokens: Math.max(0, miss),
		}
	}

	// If prompt total is smaller than cache rows alone, input is almost certainly non-cached-only â€?	// expand so base+discount math stays consistent with OpenAI billing.
	const minTotal = cw + cr
	if (total < minTotal) {
		total = minTotal
	}

	const nonCached = Math.max(0, total - cw - cr)
	return {
		totalInputTokens: total,
		cacheWriteTokens: cw,
		cacheReadTokens: cr,
		nonCachedInputTokens: nonCached,
	}
}

export interface ApiCostResult {
	totalInputTokens: number
	totalOutputTokens: number
	totalCost: number
}

function applyLongContextPricing(modelInfo: ModelInfo, totalInputTokens: number, serviceTier?: ServiceTier): ModelInfo {
	const pricing = modelInfo.longContextPricing
	if (!pricing || totalInputTokens <= pricing.thresholdTokens) {
		return modelInfo
	}

	const effectiveServiceTier = serviceTier ?? "default"
	if (pricing.appliesToServiceTiers && !pricing.appliesToServiceTiers.includes(effectiveServiceTier)) {
		return modelInfo
	}

	return {
		...modelInfo,
		inputPrice:
			modelInfo.inputPrice !== undefined && pricing.inputPriceMultiplier !== undefined
				? modelInfo.inputPrice * pricing.inputPriceMultiplier
				: modelInfo.inputPrice,
		outputPrice:
			modelInfo.outputPrice !== undefined && pricing.outputPriceMultiplier !== undefined
				? modelInfo.outputPrice * pricing.outputPriceMultiplier
				: modelInfo.outputPrice,
		cacheWritesPrice:
			modelInfo.cacheWritesPrice !== undefined && pricing.cacheWritesPriceMultiplier !== undefined
				? modelInfo.cacheWritesPrice * pricing.cacheWritesPriceMultiplier
				: modelInfo.cacheWritesPrice,
		cacheReadsPrice:
			modelInfo.cacheReadsPrice !== undefined && pricing.cacheReadsPriceMultiplier !== undefined
				? modelInfo.cacheReadsPrice * pricing.cacheReadsPriceMultiplier
				: modelInfo.cacheReadsPrice,
	}
}

function calculateApiCostInternal(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens: number,
	cacheReadInputTokens: number,
	totalInputTokens: number,
	totalOutputTokens: number,
): ApiCostResult {
	const cacheWritesCost = ((modelInfo.cacheWritesPrice || 0) / 1_000_000) * cacheCreationInputTokens
	const cacheReadsCost = ((modelInfo.cacheReadsPrice || 0) / 1_000_000) * cacheReadInputTokens
	const baseInputCost = ((modelInfo.inputPrice || 0) / 1_000_000) * inputTokens
	const outputCost = ((modelInfo.outputPrice || 0) / 1_000_000) * outputTokens
	const totalCost = cacheWritesCost + cacheReadsCost + baseInputCost + outputCost

	return {
		totalInputTokens,
		totalOutputTokens,
		totalCost,
	}
}

// For Anthropic compliant usage, the input tokens count does NOT include the
// cached tokens.
export function calculateApiCostAnthropic(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens?: number,
	cacheReadInputTokens?: number,
): ApiCostResult {
	const cacheCreation = cacheCreationInputTokens || 0
	const cacheRead = cacheReadInputTokens || 0

	// For Anthropic: inputTokens does NOT include cached tokens
	// Total input = base input + cache creation + cache reads
	const totalInputTokens = inputTokens + cacheCreation + cacheRead

	return calculateApiCostInternal(
		modelInfo,
		inputTokens,
		outputTokens,
		cacheCreation,
		cacheRead,
		totalInputTokens,
		outputTokens,
	)
}

/** Optional refinement for OpenAI-style usage (see {@link resolveOpenAiUsageForCost}). */
export type OpenAiCostOptions = {
	serviceTier?: ServiceTier
	/** When set, refines non-cached vs cache breakdown (prompt_tokens_details / input_tokens_details). */
	inputTokenDetails?: { cache_miss_tokens?: number; cached_tokens?: number }
}

function normalizeOpenAiCostOptions(
	sixth?: ServiceTier | OpenAiCostOptions,
): OpenAiCostOptions {
	if (sixth === undefined) {
		return {}
	}
	if (typeof sixth === "object" && sixth !== null) {
		return sixth as OpenAiCostOptions
	}
	return { serviceTier: sixth as ServiceTier }
}

// For OpenAI compliant usage, the input tokens count usually INCLUDES cached tokens;
// some responses only report non-cached totals â€?see resolveOpenAiUsageForCost.
export function calculateApiCostOpenAI(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheCreationInputTokens?: number,
	cacheReadInputTokens?: number,
	sixth?: ServiceTier | OpenAiCostOptions,
): ApiCostResult {
	const opt = normalizeOpenAiCostOptions(sixth)
	const resolved = resolveOpenAiUsageForCost({
		inputTokensReported: inputTokens,
		cacheWriteTokens: cacheCreationInputTokens || 0,
		cacheReadTokens: cacheReadInputTokens || 0,
		cacheMissTokensFromDetails: opt.inputTokenDetails?.cache_miss_tokens,
		cachedTokensFromDetails: opt.inputTokenDetails?.cached_tokens,
	})
	const effectiveModelInfo = applyLongContextPricing(modelInfo, resolved.totalInputTokens, opt.serviceTier)

	return calculateApiCostInternal(
		effectiveModelInfo,
		resolved.nonCachedInputTokens,
		outputTokens,
		resolved.cacheWriteTokens,
		resolved.cacheReadTokens,
		resolved.totalInputTokens,
		outputTokens,
	)
}

export const parseApiPrice = (price: UnsafeAny) => (price ? parseFloat(price) * 1_000_000 : undefined)
