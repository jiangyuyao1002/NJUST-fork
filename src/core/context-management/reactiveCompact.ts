import type { ApiMessage } from "../task-persistence/apiMessages"
import { microcompactMessages } from "./microcompact"
import { snipCompactMessages } from "./snipCompact"

/**
 * Aggressive compact path used only after API hard failures (e.g. prompt too long).
 */
export function reactiveCompactMessages(messages: ApiMessage[], contextPercent: number): ApiMessage[] {
	const micro = microcompactMessages(messages)
	const snip = snipCompactMessages(micro, {
		contextPercent: Math.max(85, contextPercent),
		triggerPercent: 0,
		keepRecentMessages: 6,
	})
	if (snip.length <= 12) return snip
	const keep = Math.max(8, Math.floor(snip.length * 0.6))
	return [snip[0]!, ...snip.slice(-keep + 1)]
}
