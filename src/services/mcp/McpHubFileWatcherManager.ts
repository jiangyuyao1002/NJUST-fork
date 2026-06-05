import type { FSWatcher } from "chokidar"
import chokidar from "chokidar"
import type { z } from "zod"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { logger } from "../../shared/logger"
import type { ServerConfigSchema } from "./McpHubConfigSchema"

/**
 * Manages chokidar file watchers for individual MCP server restarts.
 * Watches server code files (build/index.js, custom watchPaths) and
 * triggers server restart on changes.
 */
export class McpHubFileWatcherManager {
	private fileWatchers: Map<string, FSWatcher[]> = new Map()

	/**
	 * Setup file watchers for a server's code files.
	 * Only applies to stdio-type servers with watchPaths or build/index.js in args.
	 */
	setupFileWatcher(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project",
		restartConnection: (serverName: string, source: "global" | "project") => Promise<void>,
	): void {
		// Initialize an empty array for this server if it doesn't exist
		if (!this.fileWatchers.has(name)) {
			this.fileWatchers.set(name, [])
		}

		const watchers = this.fileWatchers.get(name) || []

		// Only stdio type has args
		if (config.type === "stdio") {
			// Setup watchers for custom watchPaths if defined
			if (config.watchPaths && config.watchPaths.length > 0) {
				const watchPathsWatcher = chokidar.watch(config.watchPaths, {
					ignoreInitial: true,
					awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
				})

				watchPathsWatcher.on("change", async (changedPath) => {
					try {
						await restartConnection(name, source)
					} catch (error) {
						logger.error("McpHub", `Failed to restart server ${name} after change in ${changedPath}:`, error)
						TelemetryService.reportError(error, TelemetryEventName.MCP_ERROR)
					}
				})

				watchers.push(watchPathsWatcher)
			}

			// Also setup the fallback build/index.js watcher if applicable
			const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
			if (filePath) {
				const indexJsWatcher = chokidar.watch(filePath, {
					ignoreInitial: true,
					awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
				})

				indexJsWatcher.on("change", async () => {
					try {
						await restartConnection(name, source)
					} catch (error) {
						logger.error("McpHub", `Failed to restart server ${name} after change in ${filePath}:`, error)
						TelemetryService.reportError(error, TelemetryEventName.MCP_ERROR)
					}
				})

				watchers.push(indexJsWatcher)
			}

			// Update the fileWatchers map with all watchers for this server
			if (watchers.length > 0) {
				this.fileWatchers.set(name, watchers)
			}
		}
	}

	/** Close and remove all file watchers. */
	removeAll(): void {
		this.fileWatchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.fileWatchers.clear()
	}

	/** Close and remove file watchers for a specific server. */
	removeForServer(serverName: string): void {
		const watchers = this.fileWatchers.get(serverName)
		if (watchers) {
			watchers.forEach((watcher) => watcher.close())
			this.fileWatchers.delete(serverName)
		}
	}
}
