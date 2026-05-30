import { type ModelInfo, type ReasoningEffortExtended, type ServiceTier } from "@njust-ai/types"
import { type OpenAiNativeModel } from "./base"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ReasoningMixin<T extends abstract new (...args: any[]) => any>(Base: T) {
	abstract class ReasoningBase extends Base {
		abstract getReasoningEffort(model: OpenAiNativeModel): ReasoningEffortExtended | undefined
		abstract getPromptCacheRetention(model: OpenAiNativeModel): "24h" | undefined
		abstract applyServiceTierPricing(info: ModelInfo, tier?: ServiceTier): ModelInfo
	}

	class ReasoningImpl extends ReasoningBase {
		getReasoningEffort(model: OpenAiNativeModel): ReasoningEffortExtended | undefined {
			const selected = this.options.reasoningEffort ?? model.info.reasoningEffort
			return selected && selected !== ("disable" as string) ? selected : undefined
		}

		getPromptCacheRetention(model: OpenAiNativeModel): "24h" | undefined {
			if (!model.info.supportsPromptCache) return undefined
			if (model.info.promptCacheRetention === "24h") {
				return "24h"
			}
			return undefined
		}

		applyServiceTierPricing(info: ModelInfo, tier?: ServiceTier): ModelInfo {
			if (!tier || tier === "default") return info
			const tierInfo = info.tiers?.find((t) => t.name === tier)
			if (!tierInfo) return info
			return {
				...info,
				inputPrice: tierInfo.inputPrice ?? info.inputPrice,
				outputPrice: tierInfo.outputPrice ?? info.outputPrice,
				cacheReadsPrice: tierInfo.cacheReadsPrice ?? info.cacheReadsPrice,
				cacheWritesPrice: tierInfo.cacheWritesPrice ?? info.cacheWritesPrice,
			}
		}
	}

	return ReasoningImpl as unknown as (new (...args: ConstructorParameters<T>) => InstanceType<T> & {
		getReasoningEffort(model: OpenAiNativeModel): ReasoningEffortExtended | undefined
		getPromptCacheRetention(model: OpenAiNativeModel): "24h" | undefined
		applyServiceTierPricing(info: ModelInfo, tier?: ServiceTier): ModelInfo
	}) & { prototype: InstanceType<T> }
}
