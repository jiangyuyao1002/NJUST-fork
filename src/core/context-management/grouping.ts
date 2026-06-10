import type { ApiMessage } from "../task-persistence/apiMessages"
import type { TypedBlock } from "../assistant-message/types"

/**
 * Group messages into atomic API-round units that must not be split by truncation.
 *
 * A boundary fires when a new user message that does NOT contain tool_results
 * appears (i.e., a genuine user prompt starts a new round). Tool results,
 * thinking blocks, and assistant messages within the same round form one
 * indivisible group.
 *
 * This ensures truncation never leaves orphan tool_results or splits
 * streaming assistant messages that share the same response.
 */
export function groupMessagesByApiTurn(messages: ApiMessage[]): ApiMessage[][] {
	const groups: ApiMessage[][] = []
	let current: ApiMessage[] = []

	for (const msg of messages) {
		// A user message without tool_results starts a new turn
		if (msg.role === "user" && !hasToolResults(msg) && current.length > 0) {
			groups.push(current)
			current = [msg]
		} else {
			current.push(msg)
		}
	}

	if (current.length > 0) {
		groups.push(current)
	}
	return groups
}

export function hasToolResults(msg: ApiMessage): boolean {
	if (!Array.isArray(msg.content)) return false
	return msg.content.some((block) => (block as unknown as TypedBlock).type === "tool_result")
}

/**
 * Given a set of indices to truncate, expand them to include paired
 * tool_use/tool_result messages that would be orphaned if left behind.
 *
 * If a user message with tool_results is being truncated, also truncate
 * the preceding assistant message(s) that contain the matching tool_use blocks.
 * If an assistant message with tool_use blocks is being truncated, also
 * truncate the following user message that contains the matching tool_results.
 *
 * Returns an expanded set of indices to truncate.
 */
export function expandTruncationToAtomicUnits(messages: ApiMessage[], indicesToTruncate: Set<number>): Set<number> {
	const expanded = new Set(indicesToTruncate)

	// Pre-build O(1) lookup maps in a single pass:
	// toolUseId → index of the user message containing matching tool_result
	const toolResultIndexByUseId = new Map<string, number>()
	// toolResultId → index of the assistant message containing matching tool_use
	const toolUseIndexByResultId = new Map<string, number>()

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result" && block.tool_use_id) {
					toolResultIndexByUseId.set(block.tool_use_id, i)
				}
			}
		}
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && block.id) {
					toolUseIndexByResultId.set(block.id, i)
				}
			}
		}
	}

	// Expand: for each truncated tool_use, also truncate its tool_result
	// and vice versa. O(n) lookups via pre-built maps.
	for (const idx of indicesToTruncate) {
		const msg = messages[idx]!
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && block.id) {
					const resultIdx = toolResultIndexByUseId.get(block.id)
					if (resultIdx !== undefined) expanded.add(resultIdx)
				}
			}
		}
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result" && block.tool_use_id) {
					const useIdx = toolUseIndexByResultId.get(block.tool_use_id)
					if (useIdx !== undefined) expanded.add(useIdx)
				}
			}
		}
	}

	return expanded
}
