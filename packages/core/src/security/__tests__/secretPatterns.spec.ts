import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { SECRET_PATTERNS, detectSecretsInContent, type SecretPattern } from "../secretPatterns.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

describe("secretPatterns sync with check-secrets.mjs", () => {
	it("check-secrets.mjs patterns must match secretPatterns.ts", () => {
		const mjsPath = join(__dirname, "..", "..", "..", "..", "..", "scripts", "check-secrets.mjs")
		const mjsContent = readFileSync(mjsPath, "utf-8")

		// Extract regex sources from pattern: /.../ lines
		const regexSources: string[] = []
		const patternLine = /pattern:\s*\/(.+?)\/([gimsuy]*)/g
		let match: RegExpExecArray | null
		while ((match = patternLine.exec(mjsContent)) !== null) {
			if (match[1] !== undefined) {
				regexSources.push(match[1])
			}
		}

		const tsSources = SECRET_PATTERNS.map((p: SecretPattern) => p.pattern.source)

		expect(regexSources.length).toBe(tsSources.length)

		for (const tsSrc of tsSources) {
			expect(regexSources).toContain(tsSrc)
		}
	})
})

describe("detectSecretsInContent", () => {
	it("detects AWS access key", () => {
		const result = detectSecretsInContent("const key = 'AKIAIOSFODNN7EXAMPLE'")
		expect(result.found).toBe(true)
		expect(result.reasons).toContain("AWS Access Key ID detected")
	})

	it("detects GitHub PAT", () => {
		const result = detectSecretsInContent("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")
		expect(result.found).toBe(true)
		expect(result.reasons).toContain("GitHub personal access token detected")
	})

	it("returns no findings for clean content", () => {
		const result = detectSecretsInContent("const x = 42; console.log('hello world');")
		expect(result.found).toBe(false)
		expect(result.reasons).toHaveLength(0)
	})
})
