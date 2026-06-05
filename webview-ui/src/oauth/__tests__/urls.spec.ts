import { vi, describe, it, expect } from "vitest"
import { getCallbackUrl, getOpenRouterAuthUrl, getRequestyAuthUrl } from "../urls"

// Mock the Package dependency so the test doesn't depend on root package.json
vi.mock("@shared/package", () => ({
	Package: {
		publisher: "njust-ai",
		name: "roo-code",
	},
}))

describe("urls", () => {
	describe("getCallbackUrl", () => {
		it("generates correct callback url with default uriScheme", () => {
			const result = getCallbackUrl("test-provider")
			expect(decodeURIComponent(result)).toBe("vscode://njust-ai.roo-code/test-provider")
		})

		it("generates correct callback url with custom uriScheme", () => {
			const result = getCallbackUrl("test-provider", "vscode-insiders")
			expect(decodeURIComponent(result)).toBe("vscode-insiders://njust-ai.roo-code/test-provider")
		})
	})

	describe("getOpenRouterAuthUrl", () => {
		it("generates correct OpenRouter auth URL with default scheme", async () => {
			const result = await getOpenRouterAuthUrl()
			expect(decodeURIComponent(result.url)).toContain(
				"https://openrouter.ai/auth?callback_url=vscode://njust-ai.roo-code/openrouter",
			)
			expect(result.state).toBeTruthy()
			expect(result.state.length).toBeGreaterThanOrEqual(16)
		})

		it("generates correct OpenRouter auth URL with custom scheme", async () => {
			const result = await getOpenRouterAuthUrl("vscode-insiders")
			expect(decodeURIComponent(result.url)).toContain(
				"https://openrouter.ai/auth?callback_url=vscode-insiders://njust-ai.roo-code/openrouter",
			)
			expect(result.state).toBeTruthy()
		})

		it("includes state parameter in callback URL", async () => {
			const result = await getOpenRouterAuthUrl()
			expect(decodeURIComponent(result.url)).toContain(`state=${result.state}`)
		})
	})

	describe("getRequestyAuthUrl", () => {
		it("generates correct Requesty auth URL with default scheme", () => {
			const result = getRequestyAuthUrl()
			expect(decodeURIComponent(result)).toContain(
				"https://app.requesty.ai/oauth/authorize?callback_url=vscode://njust-ai.roo-code/requesty",
			)
		})

		it("generates correct Requesty auth URL with custom scheme", () => {
			const result = getRequestyAuthUrl("vscode-insiders")
			expect(decodeURIComponent(result)).toContain(
				"https://app.requesty.ai/oauth/authorize?callback_url=vscode-insiders://njust-ai.roo-code/requesty",
			)
		})
	})
})
