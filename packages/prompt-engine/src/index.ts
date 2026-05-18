export const DEFAULT_PROMPT_BOUNDARY = "\n\n====\n\nSYSTEM_PROMPT_DYNAMIC_BOUNDARY\n\n====\n\n"

export interface PromptSection {
	name: string
	text: string
	priority?: number
	required?: boolean
}

export interface RenderPromptOptions {
	staticSections: readonly PromptSection[]
	dynamicSections: readonly PromptSection[]
	boundary?: string
	maxPromptTokens?: number
}

export interface RenderedPrompt {
	staticPart: string
	dynamicPart: string
	fullPrompt: string
	retainedSectionNames: Set<string>
}

export function estimatePromptTokens(text: string): number {
	if (!text) return 0

	let cjk = 0
	let other = 0
	for (const ch of text) {
		const cp = ch.codePointAt(0)!
		if (
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x3040 && cp <= 0x30ff) ||
			(cp >= 0xac00 && cp <= 0xd7af)
		) {
			cjk++
		} else {
			other++
		}
	}
	return Math.ceil(cjk * 0.6 + other / 3.5)
}

function normalizeSections(sections: readonly PromptSection[]): PromptSection[] {
	return sections
		.map((section) => ({ ...section, text: section.text.trim() }))
		.filter((section) => section.text.length > 0)
}

function joinSections(sections: readonly PromptSection[]): string {
	return sections.map((section) => section.text).filter(Boolean).join("\n\n")
}

function trimToTokenBudget(text: string, maxTokens: number): string {
	const maxChars = Math.max(0, Math.floor(maxTokens * 3.5))
	if (text.length <= maxChars) return text
	const head = text.slice(0, Math.max(0, maxChars - 64)).trimEnd()
	return `${head}\n\n[Prompt section truncated due to token budget]`
}

export function applyPromptBudget(
	staticPart: string,
	dynamicPart: string | readonly string[],
	maxPromptTokens?: number,
): {
	staticPart: string
	dynamicPart: string
} {
	const dynamicCombined =
		typeof dynamicPart === "string"
			? dynamicPart
			: dynamicPart.map((part) => part.trim()).filter(Boolean).join("\n\n")

	if (!maxPromptTokens || maxPromptTokens <= 0) {
		return { staticPart, dynamicPart: dynamicCombined }
	}

	const total = estimatePromptTokens(staticPart) + estimatePromptTokens(dynamicCombined)
	if (total <= maxPromptTokens) {
		return { staticPart, dynamicPart: dynamicCombined }
	}

	const staticTokens = estimatePromptTokens(staticPart)
	if (staticTokens >= maxPromptTokens) {
		return {
			staticPart: trimToTokenBudget(staticPart, maxPromptTokens),
			dynamicPart: "[Dynamic prompt omitted due to token budget]",
		}
	}

	const allowedDynamic = Math.max(1, maxPromptTokens - staticTokens)
	return {
		staticPart,
		dynamicPart: trimToTokenBudget(dynamicCombined, allowedDynamic),
	}
}

function retainSectionsByBudget(sections: PromptSection[], maxPromptTokens?: number): Set<string> {
	const retained = new Set(sections.map((section) => section.name))
	if (!maxPromptTokens || maxPromptTokens <= 0) return retained

	let currentTokens = sections.reduce((sum, section) => sum + estimatePromptTokens(section.text), 0)
	if (currentTokens <= maxPromptTokens) return retained

	const optionalSections = [...sections]
		.filter((section) => !section.required)
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

	for (const section of optionalSections) {
		if (currentTokens <= maxPromptTokens) break
		retained.delete(section.name)
		currentTokens -= estimatePromptTokens(section.text)
	}

	return retained
}

export function renderPrompt(options: RenderPromptOptions): RenderedPrompt {
	const boundary = options.boundary ?? DEFAULT_PROMPT_BOUNDARY
	const sections = [...normalizeSections(options.staticSections), ...normalizeSections(options.dynamicSections)]
	const retainedSectionNames = retainSectionsByBudget(sections, options.maxPromptTokens)

	const staticSections = normalizeSections(options.staticSections).filter((section) =>
		retainedSectionNames.has(section.name),
	)
	const dynamicSections = normalizeSections(options.dynamicSections).filter((section) =>
		retainedSectionNames.has(section.name),
	)

	const staticPart = joinSections(staticSections)
	const dynamicPart = joinSections(dynamicSections)
	const budgeted = applyPromptBudget(staticPart, dynamicPart, options.maxPromptTokens)

	return {
		staticPart: budgeted.staticPart,
		dynamicPart: budgeted.dynamicPart,
		fullPrompt: `${budgeted.staticPart}${boundary}${budgeted.dynamicPart}`,
		retainedSectionNames,
	}
}
