import { describe, expect, it, vi } from "vitest"

import {
	ApiErrorCategory,
	analyzeErrorForRetry,
	classifyHttpStatus,
	getRetryAfterSecondsFromError,
	redactErrorForTelemetry,
} from "../ApiErrorClassifier"

vi.mock("../../../utils/redactApiSecrets", () => ({
	redactApiSecrets: (s: string) => s.replace(/sk-\w+/g, "[REDACTED]"),
}))

describe("classifyHttpStatus", () => {
	it("undefined → Unknown", () => {
		expect(classifyHttpStatus(undefined)).toBe(ApiErrorCategory.Unknown)
	})

	it("429 → RateLimited", () => {
		expect(classifyHttpStatus(429)).toBe(ApiErrorCategory.RateLimited)
	})

	it("500 → ServerError", () => {
		expect(classifyHttpStatus(500)).toBe(ApiErrorCategory.ServerError)
	})

	it("502 → ServerError", () => {
		expect(classifyHttpStatus(502)).toBe(ApiErrorCategory.ServerError)
	})

	it("503 → ServerError", () => {
		expect(classifyHttpStatus(503)).toBe(ApiErrorCategory.ServerError)
	})

	it("400 → ClientError", () => {
		expect(classifyHttpStatus(400)).toBe(ApiErrorCategory.ClientError)
	})

	it("404 → ClientError", () => {
		expect(classifyHttpStatus(404)).toBe(ApiErrorCategory.ClientError)
	})

	it("200 → Unknown", () => {
		expect(classifyHttpStatus(200)).toBe(ApiErrorCategory.Unknown)
	})

	it("301 → Unknown", () => {
		expect(classifyHttpStatus(301)).toBe(ApiErrorCategory.Unknown)
	})
})

describe("analyzeErrorForRetry", () => {
	it("401 → no retry, ClientError", () => {
		const result = analyzeErrorForRetry({ status: 401 })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})

	it("403 → no retry, ClientError", () => {
		const result = analyzeErrorForRetry({ status: 403 })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})

	it("429 → retry, RateLimited", () => {
		const result = analyzeErrorForRetry({ status: 429 })
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.RateLimited)
	})

	it("429 with Retry-After passes retryAfterSeconds", () => {
		const result = analyzeErrorForRetry({ status: 429, retryAfter: 10 })
		expect(result.shouldRetry).toBe(true)
		expect(result.retryAfterSeconds).toBe(10)
	})

	it("502 → retry, ServerError", () => {
		const result = analyzeErrorForRetry({ status: 502 })
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.ServerError)
	})

	it("400 → no retry, ClientError", () => {
		const result = analyzeErrorForRetry({ status: 400 })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})

	it("no status → retry, RetryableNetwork", () => {
		const result = analyzeErrorForRetry({})
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.RetryableNetwork)
	})

	it("error with response.status", () => {
		const result = analyzeErrorForRetry({ response: { status: 500 } })
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.ServerError)
	})

	it("error.status takes precedence over response.status", () => {
		const result = analyzeErrorForRetry({ status: 401, response: { status: 500 } })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})

	it("core classifier stale connection kind maps to retryable network", () => {
		const result = analyzeErrorForRetry({ message: "socket hang up" })
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.RetryableNetwork)
	})

	it("core classifier timeout kind maps to retryable network", () => {
		const result = analyzeErrorForRetry({ code: "ETIMEDOUT", message: "request timeout" })
		expect(result.shouldRetry).toBe(true)
		expect(result.category).toBe(ApiErrorCategory.RetryableNetwork)
	})

	it("core classifier auth kind maps to non-retryable client error", () => {
		const result = analyzeErrorForRetry({ message: "invalid api key" })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})

	it("core classifier content policy kind maps to non-retryable client error", () => {
		const result = analyzeErrorForRetry({ message: "blocked by content policy" })
		expect(result.shouldRetry).toBe(false)
		expect(result.category).toBe(ApiErrorCategory.ClientError)
	})
})

describe("getRetryAfterSecondsFromError", () => {
	it("returns retryAfter number from error object", () => {
		expect(getRetryAfterSecondsFromError({ retryAfter: 5 })).toBe(5)
	})

	it("returns undefined for non-finite retryAfter", () => {
		expect(getRetryAfterSecondsFromError({ retryAfter: Infinity })).toBeUndefined()
	})

	it("returns numeric value from headers.get('retry-after')", () => {
		const error = { headers: { get: (n: string) => (n === "retry-after" ? "10" : null) } }
		expect(getRetryAfterSecondsFromError(error)).toBe(10)
	})

	it("returns undefined when no retry-after header", () => {
		const error = { headers: { get: () => null } }
		expect(getRetryAfterSecondsFromError(error)).toBeUndefined()
	})

	it("returns undefined for empty retry-after header", () => {
		const error = { headers: { get: () => "" } }
		expect(getRetryAfterSecondsFromError(error)).toBeUndefined()
	})

	it("parses HTTP-date retry-after with min 1s", () => {
		const future = new Date(Date.now() + 5000).toUTCString()
		const result = getRetryAfterSecondsFromError({ headers: { get: () => future } })
		expect(result).toBeGreaterThanOrEqual(1)
		expect(result).toBeLessThanOrEqual(6)
	})

	it("reads from response.headers", () => {
		const headers = new Map([["retry-after", "3"]])
		const error = { response: { headers } }
		expect(getRetryAfterSecondsFromError(error)).toBe(3)
	})

	it("returns undefined for null error", () => {
		expect(getRetryAfterSecondsFromError(null)).toBeUndefined()
	})

	it("returns undefined for undefined error", () => {
		expect(getRetryAfterSecondsFromError(undefined)).toBeUndefined()
	})
})

describe("redactErrorForTelemetry", () => {
	it("redacts Error with secrets", () => {
		const error = new Error("key=sk-abc123secret")
		const result = redactErrorForTelemetry(error)
		expect(result).not.toContain("sk-abc123secret")
		expect(result).toContain("[REDACTED]")
	})

	it("handles non-Error input", () => {
		expect(redactErrorForTelemetry("string error")).toBe("string error")
	})

	it("handles number input", () => {
		expect(redactErrorForTelemetry(42)).toBe("42")
	})
})
