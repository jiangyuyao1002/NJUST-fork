import { ApiMessage } from "../task-persistence/apiMessages"

export type ContextCollapseResult = {
	messages: ApiMessage[]
	collapsed: boolean
}

/**
 * Zero-cost coarse collapse for old conversation ranges.
 * Keeps the first message + recent tail, replacing middle with one summary marker.
 */
export function contextCollapseMessages(
	messages: ApiMessage[],
	options: { contextPercent: number; triggerPercent?: number; keepRecentMessages?: number },
): ContextCollapseResult {
	const trigger = options.triggerPercent ?? 70
	if (messages.length < 18 || options.contextPercent < trigger) {
		return { messages, collapsed: false }
	}

	const keepRecent = Math.max(8, options.keepRecentMessages ?? 14)
	const head = messages[0]!
	let tail = messages.slice(Math.max(1, messages.length - keepRecent))
	// Choose marker role to avoid consecutive same-role messages with both head
	// and tail[0]. The API requires alternating user/assistant roles. If the
	// marker would conflict with tail[0], shift one more message into the
	// collapsed section.
	// Ensure head and tail[0] share the same role so the marker can take
	// the opposite role. With only user/assistant roles available, you
	// cannot safely insert a marker between two different-role messages.
	while (tail[0] && tail[0].role !== head.role && tail.length > 1) {
		tail = tail.slice(1)
	}
	const markerRole: "user" | "assistant" = head.role === "user" ? "assistant" : "user"
	const collapsedRounds = Math.max(0, messages.length - 1 - tail.length)
	const marker: ApiMessage = {
		role: markerRole,
		content: `[Context collapsed: archived ${collapsedRounds} earlier messages to preserve context budget. Keep using latest state and continue.]`,
		ts: Date.now(),
	}
	return { messages: [head, marker, ...tail], collapsed: true }
}
