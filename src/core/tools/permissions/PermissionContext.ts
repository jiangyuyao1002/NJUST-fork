import { logger } from "../../../shared/logger"
/**
 * Permission Context with One-Shot Resolution
 *
 * Ensures permission decisions are resolved exactly once, even when multiple
 * decision sources race (UI click, hook response, auto-approval, remote bridge).
 * The first resolver wins; all subsequent resolves are silently ignored.
 *
 * Inspired by Claude Code's PermissionContext / createResolveOnce pattern.
 */

export type PermissionDecision = "allow" | "deny" | "abort"

export interface PermissionResolveResult {
	decision: PermissionDecision
	message?: string
	source: "ui" | "hook" | "auto_approval" | "classifier" | "remote"
}

/**
 * A one-shot permission context. Multiple sources can attempt to resolve it,
 * but only the first resolution takes effect. This prevents race conditions
 * where both the user clicking "Allow" and a hook auto-approving could
 * produce conflicting outcomes.
 */
export class PermissionContext {
	private _resolved: PermissionResolveResult | null = null
	private _resolveCallbacks: Array<(result: PermissionResolveResult) => void> = []
	private _rejectCallbacks: Array<(error: Error) => void> = []

	/** Whether this context has already been resolved */
	get isResolved(): boolean {
		return this._resolved !== null
	}

	/** Get the resolved result (null if not yet resolved) */
	get result(): PermissionResolveResult | null {
		return this._resolved
	}

	/**
	 * Attempt to resolve the permission. Only the first call succeeds;
	 * subsequent calls are silently ignored.
	 */
	resolve(result: PermissionResolveResult): boolean {
		if (this._resolved !== null) return false
		this._resolved = result
		for (const cb of this._resolveCallbacks) {
			try {
				cb(result)
			} catch (error) {
				logger.debug("PermissionContext", "permission callback error", error)
				// ignore callback errors
			}
		}
		this._resolveCallbacks = []
		this._rejectCallbacks = []
		return true
	}

	/** Shorthand: allow with source */
	allow(source: PermissionResolveResult["source"] = "ui", message?: string): boolean {
		return this.resolve({ decision: "allow", source, message })
	}

	/** Shorthand: deny with source */
	deny(source: PermissionResolveResult["source"] = "ui", message?: string): boolean {
		return this.resolve({ decision: "deny", source, message })
	}

	/** Shorthand: abort with source */
	abort(source: PermissionResolveResult["source"] = "ui", message?: string): boolean {
		return this.resolve({ decision: "abort", source, message })
	}

	/**
	 * Return a Promise that resolves when a decision is made.
	 * If already resolved, resolves immediately.
	 */
	waitForDecision(): Promise<PermissionResolveResult> {
		if (this._resolved) {
			return Promise.resolve(this._resolved)
		}
		return new Promise<PermissionResolveResult>((resolve, reject) => {
			this._resolveCallbacks.push(resolve)
			this._rejectCallbacks.push(reject)
		})
	}

	/** Timeout-aware wait: rejects if no decision within `timeoutMs` */
	async waitForDecisionWithTimeout(
		timeoutMs: number,
		defaultDecision: PermissionDecision = "deny",
	): Promise<PermissionResolveResult> {
		if (this._resolved) return this._resolved

		const timeout = new Promise<PermissionResolveResult>((resolve) => {
			setTimeout(() => {
				this.resolve({
					decision: defaultDecision,
					source: "auto_approval",
					message: `Permission timed out after ${timeoutMs}ms`,
				})
				resolve(this._resolved!)
			}, timeoutMs)
		})

		return Promise.race([this.waitForDecision(), timeout])
	}

	/** Discard all pending callbacks (cleanup on abort) */
	dispose(): void {
		this._resolveCallbacks = []
		this._rejectCallbacks = []
	}
}
