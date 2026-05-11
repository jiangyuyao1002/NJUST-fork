// npx vitest run src/services/cangjie-lsp/__tests__/CangjieLspClient.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("vscode", () => ({
	CancellationError: class CancellationError extends Error {
		constructor() {
			super("Cancelled")
			this.name = "CancellationError"
		}
	},
}))

vi.mock("vscode-languageclient/node", () => ({
	LanguageClient: class {},
	// Re-export stubs for the types used in CangjieLspClient
}))

import * as vscode from "vscode"
import { debounceMiddleware } from "../CangjieLspClient"

describe("debounceMiddleware", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("should reject old request with CancellationError when new request arrives", async () => {
		const middleware = debounceMiddleware<string>(100)

		let callCount = 0
		const nextFactory = () => {
			const n = ++callCount
			return () => `result-${n}` as unknown as vscode.ProviderResult<string>
		}

		// First request
		const firstPromise = middleware(nextFactory())

		// Before the timer fires, send a second request (cancels the first)
		const secondPromise = middleware(nextFactory())

		// Advance timer to trigger the second request's callback
		vi.advanceTimersByTime(150)

		// Second request should resolve with fresh data
		await expect(secondPromise).resolves.toBe("result-2")

		// First request should be rejected with CancellationError, not resolved with stale data
		await expect(firstPromise).rejects.toThrow("Cancelled")
	})

	it("should resolve with fresh data when only one request is made", async () => {
		const middleware = debounceMiddleware<string>(100)

		const firstPromise = middleware(() => "fresh-result" as unknown as vscode.ProviderResult<string>)

		vi.advanceTimersByTime(150)

		await expect(firstPromise).resolves.toBe("fresh-result")
	})
})
