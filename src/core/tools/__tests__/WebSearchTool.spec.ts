import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	createSearchProviderMock,
	formatSearchResultsMock,
	searchProviderSearchMock,
	toolResultCacheGetMock,
	toolResultCacheSetMock,
	toolResultCacheMakeKeyMock,
} = vi.hoisted(() => ({
	createSearchProviderMock: vi.fn(),
	formatSearchResultsMock: vi.fn(),
	searchProviderSearchMock: vi.fn(),
	toolResultCacheGetMock: vi.fn(),
	toolResultCacheSetMock: vi.fn(),
	toolResultCacheMakeKeyMock: vi.fn().mockReturnValue("cache-key"),
}))

vi.mock("../../../services/web-search/WebSearchProvider", () => ({
	createSearchProvider: createSearchProviderMock,
	formatSearchResults: formatSearchResultsMock,
	getSearchProviderInfo: () => ({
		"baidu-free": { label: "Baidu (Free)", keyHint: "No key needed", noKey: true },
		serpapi: { label: "SerpAPI", keyHint: "Get from serpapi.com", noKey: false },
		tavily: { label: "Tavily", keyHint: "Get from tavily.com", noKey: false },
	}),
}))

vi.mock("../helpers/ToolResultCache", () => ({
	toolResultCache: {
		get: toolResultCacheGetMock,
		set: toolResultCacheSetMock,
		makeKey: toolResultCacheMakeKeyMock,
	},
}))

import { webSearchTool } from "../WebSearchTool"

function createTask(overrides: Record<string, unknown> = {}) {
	const provider = {
		getState: vi.fn().mockResolvedValue({
			webSearchApiKey: "test-api-key",
			webSearchProvider: "serpapi",
			serpApiEngine: "bing",
		}),
	}
	return {
		cwd: "/workspace",
		providerRef: { deref: () => provider },
		...overrides,
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		reportProgress: vi.fn(),
	}
}

describe("WebSearchTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		toolResultCacheGetMock.mockReturnValue(undefined)
		searchProviderSearchMock.mockResolvedValue([
			{ title: "Result 1", url: "https://example.com/1", snippet: "First result" },
		])
		createSearchProviderMock.mockReturnValue({
			search: searchProviderSearchMock,
		})
		formatSearchResultsMock.mockReturnValue("Formatted: Result 1 - https://example.com/1")
	})

	describe("metadata", () => {
		it("is concurrency safe", () => {
			expect(webSearchTool.isConcurrencySafe()).toBe(true)
		})

		it("is eager execution", () => {
			expect(webSearchTool.getEagerExecutionDecision()).toBe("eager")
		})

		it("has stable partial args when search_query is non-empty", () => {
			expect(webSearchTool.isPartialArgsStable({ search_query: "test" })).toBe(true)
			expect(webSearchTool.isPartialArgsStable({ search_query: "" })).toBe(false)
			expect(webSearchTool.isPartialArgsStable({})).toBe(false)
		})
	})

	describe("execute", () => {
		it("returns cached result if available", async () => {
			toolResultCacheGetMock.mockReturnValue("cached search result")
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("cached search result")
			expect(createSearchProviderMock).not.toHaveBeenCalled()
		})

		it("returns error when API key is not configured", async () => {
			const provider = {
				getState: vi.fn().mockResolvedValue({
					webSearchApiKey: "",
					webSearchProvider: "serpapi",
					serpApiEngine: "bing",
				}),
			}
			const task = createTask({ providerRef: { deref: () => provider } })
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, task, callbacks as any)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("API key is not configured"))
		})

		it("skips API key check for no-key providers", async () => {
			const provider = {
				getState: vi.fn().mockResolvedValue({
					webSearchApiKey: "",
					webSearchProvider: "baidu-free",
					serpApiEngine: "bing",
				}),
			}
			const task = createTask({ providerRef: { deref: () => provider } })
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, task, callbacks as any)

			expect(callbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("API key"))
			expect(createSearchProviderMock).toHaveBeenCalled()
		})

		it("does not search when approval is denied", async () => {
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValue(false)

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(searchProviderSearchMock).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not approved"))
		})

		it("performs search and formats results", async () => {
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "vitest mocking" }, createTask(), callbacks as any)

			expect(createSearchProviderMock).toHaveBeenCalledWith("serpapi", "test-api-key", "bing")
			expect(searchProviderSearchMock).toHaveBeenCalledWith("vitest mocking", 5)
			expect(formatSearchResultsMock).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Formatted: Result 1 - https://example.com/1")
		})

		it("uses custom count when provided", async () => {
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test", count: 10 }, createTask(), callbacks as any)

			expect(searchProviderSearchMock).toHaveBeenCalledWith("test", 10)
		})

		it("defaults count to 5 when not provided", async () => {
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(searchProviderSearchMock).toHaveBeenCalledWith("test", 5)
		})

		it("caches successful search results", async () => {
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(toolResultCacheSetMock).toHaveBeenCalledWith(
				"cache-key",
				"Formatted: Result 1 - https://example.com/1",
			)
		})

		it("reports progress during execution", async () => {
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(callbacks.reportProgress).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Validating web search request" }),
			)
			expect(callbacks.reportProgress).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Executing web search" }),
			)
		})

		it("delegates search errors to handleError", async () => {
			searchProviderSearchMock.mockRejectedValue(new Error("rate limit exceeded"))
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"web search",
				expect.objectContaining({ message: "rate limit exceeded" }),
			)
		})

		it("wraps non-Error throws in handleError", async () => {
			searchProviderSearchMock.mockRejectedValue("string error")
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, createTask(), callbacks as any)

			expect(callbacks.handleError).toHaveBeenCalledWith("web search", expect.any(Error))
		})

		it("returns error when provider reference is lost", async () => {
			const task = createTask({
				providerRef: { deref: () => undefined },
			})
			const callbacks = createCallbacks()

			await webSearchTool.execute({ search_query: "test" }, task, callbacks as any)

			// When provider is undefined, getState won't be called,
			// apiKey will be undefined, and it should report missing key
			expect(callbacks.pushToolResult).toHaveBeenCalled()
		})
	})
})
