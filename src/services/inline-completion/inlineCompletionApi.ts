import { buildApiHandler, type ApiHandler } from "../../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { getErrorMessage } from "../../shared/error-utils"

let loggedMissingApiProfile = false

/**
 * Prefer the active task's API handler; otherwise build from the current provider profile (same as chat).
 */
export async function resolveInlineCompletionApiHandler(
	provider: ClineProvider,
	log?: (message: string) => void,
): Promise<ApiHandler | undefined> {
	const task = provider.getCurrentTask()
	if (task) {
		return task.api
	}
	try {
		const { apiConfiguration } = await provider.getState()
		if (!apiConfiguration?.apiProvider) {
			if (log && !loggedMissingApiProfile) {
				loggedMissingApiProfile = true
				log(
					"[InlineCompletion] No API profile yet — configure a provider in NJUST_AI settings, or start a chat task (inline completion reuses the same API as the sidebar).",
				)
			}
			return undefined
		}
		loggedMissingApiProfile = false
		return buildApiHandler(apiConfiguration)
	} catch (error) {
		log?.(
			`[InlineCompletion] Could not build API handler: ${getErrorMessage(error)}`,
		)
		return undefined
	}
}
