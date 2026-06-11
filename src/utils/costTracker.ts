/**
 * Real-time Cost Tracker
 *
 * Calculates API costs based on token usage and model pricing.
 * Supports Anthropic prompt caching pricing (cached tokens cost 1/10).
 *
 * Tracks token usage and estimated costs per model across API calls.
 * Provides detailed breakdowns including prompt cache utilization.
 */

/** Per-million-token pricing for common models */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
	"claude-3-opus-20240229": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
	// Default fallback
	default: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
}

export interface CostRecord {
	timestamp: number
	model: string
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	cost: number // in USD
}

export interface CostStats {
	totalCost: number
	totalInputTokens: number
	totalOutputTokens: number
	totalCacheReadTokens: number
	totalCacheWriteTokens: number
	requestCount: number
	costSavedByCache: number // estimated savings from caching
	records: CostRecord[]
}

export interface ModelUsage {
	inputTokens: number
	outputTokens: number
	cacheReadInputTokens: number
	cacheCreationInputTokens: number
	totalRequests: number
	costUSD: number
}

export interface UsageUpdate {
	inputTokens?: number
	outputTokens?: number
	cacheReadInputTokens?: number
	cacheCreationInputTokens?: number
	costUSD?: number
	noCacheCostUSD?: number
}

const MAX_COST_RECORDS = 1000

export class CostTracker {
	private usageByModel: Map<string, ModelUsage> = new Map()
	private costRecords: CostRecord[] = []

	/**
	 * Record an API call's token usage and calculate cost automatically.
	 */
	recordApiCall(params: {
		model: string
		inputTokens: number
		outputTokens: number
		cacheReadTokens?: number
		cacheWriteTokens?: number
	}): CostRecord {
		const pricing = this.getModelPricing(params.model)
		const cacheRead = params.cacheReadTokens || 0
		const cacheWrite = params.cacheWriteTokens || 0

		// inputTokens may include cached tokens; split to avoid double-charging.
		const nonCachedInput = Math.max(0, params.inputTokens - cacheRead)

		const cost = parseFloat(
			(
				(nonCachedInput / 1_000_000) * pricing.input +
				(params.outputTokens / 1_000_000) * pricing.output +
				(cacheRead / 1_000_000) * pricing.cacheRead +
				(cacheWrite / 1_000_000) * pricing.cacheWrite
			).toFixed(6),
		)

		const record: CostRecord = {
			timestamp: Date.now(),
			model: params.model,
			inputTokens: params.inputTokens,
			outputTokens: params.outputTokens,
			cacheReadTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
			cost,
		}

		this.costRecords.push(record)
		if (this.costRecords.length > MAX_COST_RECORDS) {
			this.costRecords = this.costRecords.slice(-MAX_COST_RECORDS)
		}

		// Also update the per-model aggregate
		this.recordUsage(params.model, {
			inputTokens: params.inputTokens,
			outputTokens: params.outputTokens,
			cacheReadInputTokens: cacheRead,
			cacheCreationInputTokens: cacheWrite,
			costUSD: cost,
		})

		return record
	}

	/**
	 * Get cost statistics.
	 */
	getStats(): CostStats {
		const totals = this.getTotalTokens()
		let totalCacheWrite = 0
		for (const usage of this.usageByModel.values()) {
			totalCacheWrite += usage.cacheCreationInputTokens
		}
		return {
			totalCost: parseFloat(this.getTotalCost().toFixed(6)),
			totalInputTokens: totals.input,
			totalOutputTokens: totals.output,
			totalCacheReadTokens: totals.cached,
			totalCacheWriteTokens: totalCacheWrite,
			requestCount: this.costRecords.length || this.getTotalRequests(),
			costSavedByCache: parseFloat(this.getCacheSavings().toFixed(6)),
			records: [...this.costRecords],
		}
	}

	/**
	 * Get cost saved by prompt caching.
	 * Savings = cacheReadTokens * (normalInputPrice - cacheReadPrice) per million tokens.
	 */
	getCacheSavings(): number {
		let savings = 0
		for (const [modelId, usage] of this.usageByModel.entries()) {
			const pricing = this.getModelPricing(modelId)
			savings += (usage.cacheReadInputTokens / 1_000_000) * (pricing.input - pricing.cacheRead)
		}
		return parseFloat(savings.toFixed(6))
	}

	/**
	 * Get pricing for a model (with fallback to default).
	 */
	private getModelPricing(model: string): (typeof MODEL_PRICING)[string] {
		return MODEL_PRICING[model] ?? MODEL_PRICING["default"]!
	}

	/**
	 * Get total request count across all models.
	 */
	private getTotalRequests(): number {
		let total = 0
		for (const usage of this.usageByModel.values()) {
			total += usage.totalRequests
		}
		return total
	}

	/**
	 * Record usage from a single API call (legacy method, kept for backward compatibility).
	 */
	recordUsage(modelId: string, usage: UsageUpdate): void {
		const existing = this.usageByModel.get(modelId) || {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalRequests: 0,
			costUSD: 0,
		}

		existing.inputTokens += usage.inputTokens || 0
		existing.outputTokens += usage.outputTokens || 0
		existing.cacheReadInputTokens += usage.cacheReadInputTokens || 0
		existing.cacheCreationInputTokens += usage.cacheCreationInputTokens || 0
		existing.totalRequests += 1
		existing.costUSD += usage.costUSD || 0

		this.usageByModel.set(modelId, existing)
	}

	/**
	 * Get total cost across all models in USD.
	 */
	getTotalCost(): number {
		let total = 0
		for (const usage of this.usageByModel.values()) {
			total += usage.costUSD
		}
		return total
	}

	/**
	 * Get total tokens used across all models.
	 */
	getTotalTokens(): { input: number; output: number; cached: number } {
		let input = 0,
			output = 0,
			cached = 0
		for (const usage of this.usageByModel.values()) {
			input += usage.inputTokens
			output += usage.outputTokens
			cached += usage.cacheReadInputTokens
		}
		return { input, output, cached }
	}

	/**
	 * Get usage for a specific model.
	 */
	getModelUsage(modelId: string): ModelUsage | undefined {
		const usage = this.usageByModel.get(modelId)
		return usage ? { ...usage } : undefined
	}

	/**
	 * Get all model IDs that have recorded usage.
	 */
	getModelIds(): string[] {
		return Array.from(this.usageByModel.keys())
	}

	/**
	 * Format a human-readable usage summary.
	 */
	formatSummary(): string {
		if (this.usageByModel.size === 0) return "No API usage recorded."

		const lines: string[] = ["API Usage Summary:"]

		for (const [model, usage] of this.usageByModel.entries()) {
			const cacheInfo =
				usage.cacheReadInputTokens > 0 ? ` (${usage.cacheReadInputTokens.toLocaleString()} cached)` : ""
			lines.push(
				`  ${model}: ${usage.inputTokens.toLocaleString()} input${cacheInfo}, ` +
					`${usage.outputTokens.toLocaleString()} output, ` +
					`${usage.totalRequests} requests` +
					(usage.costUSD > 0 ? `, $${usage.costUSD.toFixed(4)}` : ""),
			)
		}

		const totals = this.getTotalTokens()
		lines.push(`  Total: ${totals.input.toLocaleString()} input, ${totals.output.toLocaleString()} output`)

		if (this.getTotalCost() > 0) {
			lines.push(`  Total cost: $${this.getTotalCost().toFixed(4)}`)
		}

		return lines.join("\n")
	}

	/**
	 * Reset all tracked usage.
	 */
	reset(): void {
		this.usageByModel.clear()
		this.costRecords = []
	}
}

/** Singleton instance for global cost tracking */
export const globalCostTracker = new CostTracker()
