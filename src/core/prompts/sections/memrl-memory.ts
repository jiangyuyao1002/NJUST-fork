export function getMemrlMemorySection(episodicHints: string, ltmRules: string): string {
	const parts: string[] = []
	if (episodicHints) parts.push(episodicHints)
	if (ltmRules) parts.push(ltmRules)
	if (!parts.length) return ""
	return (
		`\n\n## MemRL Adaptive Memory\n\nThe following memory was retrieved from past task experience:\n\n` +
		parts.join("\n\n")
	)
}
