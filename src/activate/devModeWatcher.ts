import * as vscode from "vscode"
import * as path from "path"
import { logger } from "../shared/logger"

/**
 * Watch core files and automatically reload the extension host during development.
 * Only active when NODE_ENV=development.
 */
export function setupDevModeWatcher(context: vscode.ExtensionContext): void {
	if (process.env.NODE_ENV !== "development") return

	const watchPaths = [
		{ path: context.extensionPath, pattern: "**/*.ts" },
		{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
	]

	logger.info(
		"Extension",
		`Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
	)

	// Create a debounced reload function to prevent excessive reloads
	let reloadTimeout: NodeJS.Timeout | undefined
	const DEBOUNCE_DELAY = 1_000

	const debouncedReload = (uri: vscode.Uri) => {
		if (reloadTimeout) {
			clearTimeout(reloadTimeout)
		}
		logger.info("Extension", `${uri.fsPath} changed; scheduling reload...`)
		reloadTimeout = setTimeout(() => {
			logger.info("Extension", "Reloading host after debounce delay...")
			vscode.commands.executeCommand("workbench.action.reloadWindow")
		}, DEBOUNCE_DELAY)
	}

	watchPaths.forEach(({ path: watchPath, pattern }) => {
		const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
		const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)
		// Listen to all change types to ensure symlinked file updates trigger reloads.
		watcher.onDidChange(debouncedReload)
		watcher.onDidCreate(debouncedReload)
		watcher.onDidDelete(debouncedReload)
		context.subscriptions.push(watcher)
	})

	// Clean up the timeout on deactivation
	context.subscriptions.push({
		dispose: () => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}
		},
	})
}
