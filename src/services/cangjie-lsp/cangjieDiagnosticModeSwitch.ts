/**
 * Clears extension-owned Cangjie diagnostics (cjlint, cjpm compile) when leaving cangjie mode.
 * Does not touch the language server diagnostic collection.
 */
export const cangjieDiagnosticModeSwitch = {
	clearCjlint: undefined as (() => void) | undefined,
	clearCjpm: undefined as (() => void) | undefined,

	clearExtensionCangjieDiagnostics(): void {
		try {
			this.clearCjlint?.()
		} catch {
			// intentionally ignored: diagnostic cleanup may fail if provider disposed
		}
		try {
			this.clearCjpm?.()
		} catch {
			// intentionally ignored: diagnostic cleanup may fail if provider disposed
		}
	},
}
