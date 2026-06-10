/**
 * Unified Cangjie source scanner for comment/string/literal state tracking.
 *
 * Pre-scans the entire source to build position→state lookups (indexed by
 * character offset), then exposes O(1) queries for "is this position in code?"
 * and "is this position in a string?".
 *
 * Replaces the six independent implementations previously scattered across
 * cangjieParser.ts, CangjieSymbolIndex.ts, and CangjieEnhancedRenameProvider.ts.
 */

export interface ScannerState {
	inString: boolean
	inChar: boolean
	inLineComment: boolean
	inBlock: number // > 0 means inside block comment
}

export class CangjieSourceScanner {
	private states: ScannerState[]
	private content: string

	constructor(content: string) {
		this.content = content
		this.states = this.scan(content)
	}

	/** Build state array indexed by character offset. */
	private scan(content: string): ScannerState[] {
		const states: ScannerState[] = new Array(content.length)
		let inString = false
		let inChar = false
		let inLineComment = false
		let inBlock = 0

		for (let i = 0; i < content.length; i++) {
			const ch = content[i]
			const next = i + 1 < content.length ? content[i + 1] : ""

			// Line comments end at newline
			if (inLineComment) {
				if (ch === "\n") inLineComment = false
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}

			// Block comments end at */
			if (inBlock > 0) {
				if (ch === "*" && next === "/") {
					inBlock--
					states[i] = { inString, inChar, inLineComment, inBlock }
					i++
					continue
				}
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}

			// String literals
			if (inString) {
				if (ch === "\\") {
					states[i] = { inString, inChar, inLineComment, inBlock }
					i++
					continue
				}
				if (ch === '"') inString = false
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}

			// Char literals
			if (inChar) {
				if (ch === "\\") {
					states[i] = { inString, inChar, inLineComment, inBlock }
					i++
					continue
				}
				if (ch === "'") inChar = false
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}

			// Comment starts
			if (ch === "/" && next === "/") {
				inLineComment = true
				i++
				continue
			}
			if (ch === "/" && next === "*") {
				inBlock++
				i++
				continue
			}
			if (ch === '"') {
				inString = true
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}
			if (ch === "'") {
				inChar = true
				states[i] = { inString, inChar, inLineComment, inBlock }
				continue
			}

			states[i] = { inString, inChar, inLineComment, inBlock }
		}
		return states
	}

	/** Is this character offset inside executable code (not comment or string)? */
	isInCode(offset: number): boolean {
		if (offset < 0 || offset >= this.states.length) return false
		const s = this.states[offset]!
		return !s.inString && !s.inChar && !s.inLineComment && s.inBlock === 0
	}

	/** Is this character offset inside a string literal? */
	isInString(offset: number): boolean {
		if (offset < 0 || offset >= this.states.length) return false
		return this.states[offset]!.inString
	}

	/** Is this character offset inside a comment (line or block)? */
	isInComment(offset: number): boolean {
		if (offset < 0 || offset >= this.states.length) return false
		const s = this.states[offset]!
		return s.inLineComment || s.inBlock > 0
	}

	getStateAt(offset: number): ScannerState | undefined {
		if (offset < 0 || offset >= this.states.length) return undefined
		return this.states[offset]
	}
}
