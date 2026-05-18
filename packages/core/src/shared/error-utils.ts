/**
 * Type-safe helpers for working with `unknown` errors.
 *
 * Replace `catch (e: any)` / `e.message` patterns with these utilities
 * to avoid `any` while keeping error-handling code concise.
 */

/**
 * Extract a human-readable message from a thrown value.
 *
 * ```ts
 * catch (e: unknown) { logger.error(getErrorMessage(e)) }
 * ```
 */
export function getErrorMessage(e: unknown): string {
	if (e instanceof Error) {
		return e.message
	}
	if (typeof e === "string") {
		return e
	}
	return String(e)
}

/**
 * Extract the stack trace from a thrown value, if available.
 */
export function getErrorStack(e: unknown): string | undefined {
	return e instanceof Error ? e.stack : undefined
}

/**
 * Wrap an unknown thrown value as a proper `Error` instance.
 *
 * Useful for `catch` blocks that need to re-throw:
 * ```ts
 * catch (e: unknown) { throw wrapAsError(e, "Failed to save config") }
 * ```
 */
export function wrapAsError(e: unknown, prefix?: string): Error {
	if (e instanceof Error) {
		if (prefix) {
			const wrapped = new Error(`${prefix}: ${e.message}`)
			wrapped.stack = e.stack
			wrapped.cause = e.cause
			return wrapped
		}
		return e
	}
	const msg = typeof e === "string" ? e : String(e)
	return prefix ? new Error(`${prefix}: ${msg}`) : new Error(msg)
}

/**
 * Type-guard that checks whether a value has a `.message` property (string).
 * Narrower than `instanceof Error` – works with cross-realm errors and
 * plain objects that conform to the shape.
 */
export function hasMessage(e: unknown): e is { message: string } {
	return typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string"
}
