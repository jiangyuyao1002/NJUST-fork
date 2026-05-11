import { logger } from "../../shared/logger"

export type PromptTokenBudget = {
	systemPromptMaxTokens: number
	toolDefinitionMaxTokens: number
	dialogHistoryMinTokens: number
}

const MIN_SYSTEM_PROMPT_TOKENS = 1200
const SYSTEM_PROMPT_BUDGET_RATIO = 0.15
const TOOL_DEFINITION_BUDGET_RATIO = 0.10
const DIALOG_HISTORY_BUDGET_RATIO = 0.50

export function estimatePromptTokens(text: string): number {
	if (!text) return 0
	// Count CJK characters which use ~1.5-2 tokens each vs ~3.5 chars/token for Latin script
	let cjk = 0
	let other = 0
	for (const ch of text) {
		const cp = ch.codePointAt(0)!
		if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) {
			cjk++
		} else {
			other++
		}
	}
	return Math.ceil(cjk * 0.6 + other / 3.5)
}

export function derivePromptTokenBudget(contextWindow?: number): PromptTokenBudget | null {
	if (!contextWindow || contextWindow <= 0) return null
	const systemPromptMaxTokens = Math.max(MIN_SYSTEM_PROMPT_TOKENS, Math.floor(contextWindow * SYSTEM_PROMPT_BUDGET_RATIO))
	const toolDefinitionMaxTokens = Math.max(600, Math.floor(contextWindow * TOOL_DEFINITION_BUDGET_RATIO))
	const dialogHistoryMinTokens = Math.max(2000, Math.floor(contextWindow * DIALOG_HISTORY_BUDGET_RATIO))
	return {
		systemPromptMaxTokens,
		toolDefinitionMaxTokens,
		dialogHistoryMinTokens,
	}
}

function trimToTokenBudget(text: string, maxTokens: number): string {
	const maxChars = Math.max(0, Math.floor(maxTokens * 3.5))
	if (text.length <= maxChars) return text
	const head = text.slice(0, Math.max(0, maxChars - 64)).trimEnd()
	return `${head}\n\n[Prompt section truncated due to token budget]`
}

/**
 * Fill dynamic prompt from ordered segments: first segments get tokens first (highest priority).
 * Use this so mode instructions and objective are not dropped when the tail of a single string would be truncated.
 */
export function mergeDynamicPromptSegmentsByTokenBudget(segments: readonly string[], maxTokens: number): string {
	const parts: string[] = []
	let remaining = Math.max(0, maxTokens)
	for (const seg of segments) {
		const t = seg?.trim()
		if (!t) continue
		const need = estimatePromptTokens(t)
		if (need <= remaining) {
			parts.push(t)
			remaining -= need
		} else {
			if (remaining > 80) {
				parts.push(trimToTokenBudget(t, remaining))
			}
			break
		}
	}
	return parts.join("\n\n")
}

export type SectionBudget = {
	name: string
	priority: number
	estimatedTokens: number
	required: boolean
}

/**
 * 当段落总 token 超过预算时，按优先级裁剪非必需段落。
 * 返回需要保留的段落名称集合。
 */
export function trimSectionsByBudget(sections: SectionBudget[], maxTokens: number): Set<string> {
	const allNames = new Set(sections.map((s) => s.name))
	const totalTokens = sections.reduce((sum, s) => sum + s.estimatedTokens, 0)
	if (totalTokens <= maxTokens) {
		return allNames
	}

	// Sort non-required sections by priority ascending (lowest priority trimmed first)
	const nonRequired = sections.filter((s) => !s.required).sort((a, b) => a.priority - b.priority)
	const retained = new Set(allNames)
	let currentTokens = totalTokens

	for (const section of nonRequired) {
		if (currentTokens <= maxTokens) break
		retained.delete(section.name)
		currentTokens -= section.estimatedTokens
		logger.warn("TokenBudget", `[tokenBudget] Trimmed section "${section.name}" (${section.estimatedTokens} tokens) to fit budget`)
	}

	return retained
}

export function applySystemPromptBudget(
	staticPart: string,
	dynamicPart: string | readonly string[],
	contextWindow?: number,
): {
	staticPart: string
	dynamicPart: string
} {
	const budget = derivePromptTokenBudget(contextWindow)
	let dynamicCombined: string
	if (Array.isArray(dynamicPart)) {
		dynamicCombined = mergeDynamicPromptSegmentsByTokenBudget(dynamicPart, Infinity)
	} else {
		dynamicCombined = dynamicPart as string
	}
	if (!budget) return { staticPart, dynamicPart: dynamicCombined }

	const total = estimatePromptTokens(staticPart) + estimatePromptTokens(dynamicCombined)
	if (total <= budget.systemPromptMaxTokens) {
		return { staticPart, dynamicPart: dynamicCombined }
	}

	const staticTokens = estimatePromptTokens(staticPart)

	// Static itself exceeds budget: trim static first, keep minimal dynamic marker.
	if (staticTokens >= budget.systemPromptMaxTokens) {
		return {
			staticPart: trimToTokenBudget(staticPart, budget.systemPromptMaxTokens),
			dynamicPart: "[Dynamic prompt omitted due to token budget]",
		}
	}

	const allowedDynamic = Math.max(200, budget.systemPromptMaxTokens - staticTokens)
	const trimmedDynamic = Array.isArray(dynamicPart)
		? mergeDynamicPromptSegmentsByTokenBudget(dynamicPart, allowedDynamic)
		: trimToTokenBudget(dynamicPart as string, allowedDynamic)
	return {
		staticPart,
		dynamicPart: trimmedDynamic,
	}
}
