import type { ExtensionMessage, HistoryItem } from "@njust-ai/types"

/**
 * Task → UI notifications (webview / history). Implemented by ClineProvider.
 * Keeps core/task free of webview concrete types once Task uses only this interface.
 */
export interface ITaskUINotifier {
	postMessageToWebview(message: ExtensionMessage): Promise<void>

	postStateToWebviewWithoutTaskHistory(): Promise<void>

	updateTaskHistory(item: HistoryItem, options?: { broadcast?: boolean }): Promise<HistoryItem[]>
}
