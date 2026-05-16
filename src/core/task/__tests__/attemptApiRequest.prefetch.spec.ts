import { readFile } from "fs/promises"
import { describe, expect, it } from "vitest"

describe("attemptApiRequest prefetch", () => {
	it("keeps prefetch path wired", async () => {
		const source = await readFile(new URL("../Task.ts", import.meta.url), "utf8")

		expect(source).toContain('import { startAllPrefetch } from "../prefetch"')
		expect(source).toContain("startAllPrefetch({")
		expect(source).toContain("public async *attemptApiRequest(")
		expect(source).toContain("yield* this.executor.attemptApiRequest(retryAttempt, options)")
	})
})
