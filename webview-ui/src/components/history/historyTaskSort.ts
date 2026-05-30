import type { HistoryItem } from "@njust-ai/types"

export type HistorySortOption = "newest" | "oldest" | "mostExpensive" | "mostTokens" | "mostRelevant"

function historyTs(item: HistoryItem): number {
	const n = Number(item.ts)
	return Number.isFinite(n) ? n : 0
}

function totalTokens(item: HistoryItem): number {
	return (
		(item.tokensIn || 0) +
		(item.tokensOut || 0) +
		(item.cacheWrites || 0) +
		(item.cacheReads || 0)
	)
}

/**
 * Compare two history rows for list / tree ordering.
 * When `searchActive` is true and sort is `mostRelevant`, returns 0 so a stable sort preserves Fzf relevance order.
 */
export function compareHistoryTasksForSort(
	a: HistoryItem,
	b: HistoryItem,
	sortOption: HistorySortOption,
	searchActive: boolean,
): number {
	switch (sortOption) {
		case "oldest":
			return historyTs(a) - historyTs(b)
		case "mostExpensive":
			return (b.totalCost || 0) - (a.totalCost || 0)
		case "mostTokens":
			return totalTokens(b) - totalTokens(a)
		case "mostRelevant":
			return searchActive ? 0 : historyTs(b) - historyTs(a)
		case "newest":
		default:
			return historyTs(b) - historyTs(a)
	}
}
