/**
 * Tool-Prompt Consistency Checker
 *
 * Validates that the set of tools actually available to the model matches
 * what the system prompt describes. Mismatches — a tool mentioned in the
 * prompt but filtered out, or vice versa — confuse the model and reduce
 * accuracy of tool calls.
 *
 * Called once per request build and logs warnings rather than throwing,
 * so it never blocks a request.
 */

import type OpenAI from "openai"

export interface ConsistencyCheckResult {
	ok: boolean
	mentionedButUnavailable: string[]
	availableButUnmentioned: string[]
}

const TOOL_PROMPT_KEYWORDS: Record<string, RegExp> = {
	codebase_search: /codebase_search/,
	read_file: /read_file/,
	search_files: /search_files/,
	list_files: /list_files/,
	apply_diff: /apply_diff/,
	use_mcp_tool: /use_mcp_tool/,
	ask_followup_question: /ask_followup_question/,
	attempt_completion: /attempt_completion/,
}

/**
 * Compare the tool names in the assembled prompt with the actual tool
 * definitions that will be sent to the model.
 *
 * @param systemPrompt Full system prompt text
 * @param tools Tool definitions that will be included in the API call
 * @returns Consistency report; `ok` is true when no mismatches
 */
export function checkToolPromptConsistency(
	systemPrompt: string,
	tools: OpenAI.Chat.ChatCompletionTool[],
): ConsistencyCheckResult {
	const availableNames = new Set(
		tools.map((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function.name),
	)

	const mentionedButUnavailable: string[] = []
	const availableButUnmentioned: string[] = []

	for (const [toolName, pattern] of Object.entries(TOOL_PROMPT_KEYWORDS)) {
		const mentionedInPrompt = pattern.test(systemPrompt)
		const isAvailable = availableNames.has(toolName)

		if (mentionedInPrompt && !isAvailable) {
			mentionedButUnavailable.push(toolName)
		}
		if (isAvailable && !mentionedInPrompt) {
			availableButUnmentioned.push(toolName)
		}
	}

	const ok = mentionedButUnavailable.length === 0 && availableButUnmentioned.length === 0

	if (!ok) {
		if (mentionedButUnavailable.length > 0) {
			console.warn(
				`[ToolPromptConsistency] Tools mentioned in system prompt but NOT in tool list: ${mentionedButUnavailable.join(", ")}. ` +
				`The model may attempt to call these and fail.`,
			)
		}
		if (availableButUnmentioned.length > 0) {
			console.warn(
				`[ToolPromptConsistency] Tools in tool list but NOT mentioned in system prompt: ${availableButUnmentioned.join(", ")}. ` +
				`The model may not know to use these.`,
			)
		}
	}

	return { ok, mentionedButUnavailable, availableButUnmentioned }
}
