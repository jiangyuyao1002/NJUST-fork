/**
 * Unified logger for NJUST_AI_CJ.
 * Provides scope-prefixed logging across four levels.
 * Zero external dependencies; does not depend on VS Code API.
 *
 * Usage:
 *   logger.error("Scope", "message", err)
 *   logger.warn("Scope", "message")
 *   logger.info("Scope", "message")
 *   logger.debug("Scope", "message")  // dev/debug only
 */

let _debugEnabled: boolean | undefined

function isDebugEnabled(): boolean {
	if (_debugEnabled === undefined) {
		_debugEnabled =
			process.env.NODE_ENV === "development" ||
			process.env.DEBUG !== undefined ||
			process.env.VSCODE_DEBUG_MODE === "true"
	}
	return _debugEnabled
}

/**
 * Invalidate cached debug flag.
 * Call if environment variables change at runtime.
 */
export function invalidateDebugCache(): void {
	_debugEnabled = undefined
}

function serializeArg(arg: unknown): string {
	if (arg === null) return "null"
	if (arg === undefined) return "undefined"
	if (typeof arg === "string") return arg
	if (arg instanceof Error) return `Error: ${arg.message}\n${arg.stack || ""}`
	try {
		return JSON.stringify(
			arg,
			(_key, value) => {
				if (typeof value === "bigint") return `BigInt(${value})`
				if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
				if (typeof value === "symbol") return value.toString()
				return value
			},
			2,
		)
	} catch {
		return `[Non-serializable: ${Object.prototype.toString.call(arg)}]`
	}
}

function formatMessage(scope: string, message: string, args: readonly unknown[]): string {
	const prefix = `[${scope}] ${message}`
	if (args.length === 0) return prefix
	const serialized = args.map(serializeArg).join(" ")
	return `${prefix} ${serialized}`
}

export const logger = {
	error(scope: string, message: string, ...args: unknown[]): void {
		console.error(formatMessage(scope, message, args))
	},

	warn(scope: string, message: string, ...args: unknown[]): void {
		console.warn(formatMessage(scope, message, args))
	},

	info(scope: string, message: string, ...args: unknown[]): void {
		console.log(formatMessage(scope, message, args))
	},

	debug(scope: string, message: string, ...args: unknown[]): void {
		if (!isDebugEnabled()) return
		console.debug(formatMessage(scope, message, args))
	},
}
