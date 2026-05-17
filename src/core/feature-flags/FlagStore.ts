/**
 * FlagStore — Lightweight feature flag evaluation.
 *
 * Supports three tiers (highest priority wins):
 *   1. Kill switch (force-on / force-off via settings.json)
 *   2. Percentage-based gradual rollout (0–100)
 *   3. Default value (hard-coded fallback)
 *
 * Usage:
 *   const store = new FlagStore(userFlags, { userId: "abc" })
 *   store.isEnabled("imageGeneration") // true | false
 */

export interface FlagDefinition {
	defaultValue: boolean
	description?: string
	rolloutPercent?: number // 0–100
}

export interface FlagContext {
	userId?: string
	workspaceId?: string
}

export type FlagOverrides = Record<string, boolean | undefined> // force on/off

export class FlagStore {
	private flags: Map<string, FlagDefinition>
	private overrides: FlagOverrides
	private context: FlagContext

	constructor(
		flags: Record<string, FlagDefinition>,
		overrides: FlagOverrides = {},
		context: FlagContext = {},
	) {
		this.flags = new Map(Object.entries(flags))
		this.overrides = overrides
		this.context = context
	}

	isEnabled(flagName: string): boolean {
		// 1. Kill switch (highest priority)
		const override = this.overrides[flagName]
		if (override !== undefined) return override

		// 2. Local override file
		const localOverride = this.loadLocalOverride(flagName)
		if (localOverride !== undefined) return localOverride

		// 3. Percentage rollout
		const flag = this.flags.get(flagName)
		if (!flag) return false
		if (flag.rolloutPercent !== undefined && flag.rolloutPercent < 100) {
			const hash = this.hashFlag(flagName)
			if (hash >= flag.rolloutPercent / 100) return false
		}

		// 4. Default
		return flag.defaultValue
	}

	getRolloutPercent(flagName: string): number {
		return this.flags.get(flagName)?.rolloutPercent ?? 100
	}

	getAllFlags(): Record<string, { enabled: boolean; defaultValue: boolean; rolloutPercent?: number }> {
		const result: Record<string, UnsafeAny> = {}
		for (const [name, def] of this.flags) {
			result[name] = {
				enabled: this.isEnabled(name),
				defaultValue: def.defaultValue,
				rolloutPercent: def.rolloutPercent,
			}
		}
		return result
	}

	/**
	 * Deterministic hash of flag name + user ID for consistent rollout assignment.
	 * Returns 0.0–1.0.
	 */
	private hashFlag(flagName: string): number {
		const seed = this.context.userId ?? flagName
		let hash = 0
		for (let i = 0; i < seed.length; i++) {
			hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
		}
		return Math.abs(hash % 10000) / 10000
	}

	private loadLocalOverride(flagName: string): boolean | undefined {
		// Intentionally synchronous — called frequently, must be fast.
		// Checks environment variable: FLAG_<NAME> = "1" | "0" | "true" | "false"
		const envKey = `FLAG_${flagName.replace(/([A-Z])/g, "_$1").toUpperCase()}`
		const envVal = typeof process !== "undefined" ? process.env?.[envKey] : undefined
		if (envVal === "1" || envVal?.toLowerCase() === "true") return true
		if (envVal === "0" || envVal?.toLowerCase() === "false") return false
		return undefined
	}
}
