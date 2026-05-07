/**
 * Debug-log helper that only emits when the extension debug setting is enabled.
 * Use as a drop-in replacement for console.debug to avoid shipping debug logs
 * in production.
 */
import * as vscode from "vscode"
import { Package } from "../shared/package"

import { logger } from "../shared/logger"

let _debugEnabled: boolean | undefined

function isDebugEnabled(): boolean {
	if (_debugEnabled === undefined) {
		_debugEnabled = vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false)
	}
	return _debugEnabled
}

/** Invalidate cached debug setting (call on configuration change). */
export function invalidateDebugCache(): void {
	_debugEnabled = undefined
}

export function debugLog(...args: unknown[]): void {
	if (isDebugEnabled()) {
		if (args.length === 0) return
		const message = String(args[0])
		const rest = args.slice(1)
		logger.debug("DebugLog", message, ...rest)
	}
}
