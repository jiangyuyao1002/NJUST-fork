import { describe, expect, it } from "vitest"
import { ToolError, ValidationError, PermissionError, RetryableError, AbortError } from "../errors"

describe("Tool Error Hierarchy", () => {
	describe("ToolError", () => {
		it("stores toolName and message", () => {
			const err = new ToolError("read_file", "something went wrong")
			expect(err.toolName).toBe("read_file")
			expect(err.message).toBe("something went wrong")
			expect(err.name).toBe("ToolError")
		})

		it("supports telemetrySafe message", () => {
			const err = new ToolError("read_file", "secret path /etc/shadow", "file read error")
			expect(err.telemetrySafe).toBe("file read error")
		})

		it("is an instance of Error", () => {
			expect(new ToolError("x", "y")).toBeInstanceOf(Error)
		})
	})

	describe("ValidationError", () => {
		it("extends ToolError", () => {
			const err = new ValidationError("edit", "missing file_path")
			expect(err).toBeInstanceOf(ToolError)
			expect(err).toBeInstanceOf(ValidationError)
			expect(err.name).toBe("ValidationError")
		})

		it("provides default telemetrySafe message", () => {
			const err = new ValidationError("edit", "missing file_path")
			expect(err.telemetrySafe).toBe("Validation failed for tool 'edit'")
		})
	})

	describe("PermissionError", () => {
		it("extends ToolError with default message", () => {
			const err = new PermissionError("execute_command")
			expect(err).toBeInstanceOf(ToolError)
			expect(err.message).toBe("Permission denied for tool 'execute_command'")
			expect(err.name).toBe("PermissionError")
		})
	})

	describe("AbortError", () => {
		it("extends ToolError", () => {
			const err = new AbortError("web_fetch")
			expect(err).toBeInstanceOf(ToolError)
			expect(err.message).toContain("aborted")
			expect(err.name).toBe("AbortError")
		})
	})

	describe("RetryableError", () => {
		it("extends ToolError", () => {
			const err = new RetryableError("web_search", "timeout")
			expect(err).toBeInstanceOf(ToolError)
			expect(err.name).toBe("RetryableError")
		})

		it("preserves original error", () => {
			const original = new Error("connection reset")
			const err = new RetryableError("web_fetch", "timeout", original)
			expect(err.originalError).toBe(original)
		})

		describe("isRetryable()", () => {
			it("returns false for non-Error values", () => {
				expect(RetryableError.isRetryable("string")).toBe(false)
				expect(RetryableError.isRetryable(null)).toBe(false)
				expect(RetryableError.isRetryable(42)).toBe(false)
			})

			it("detects retryable HTTP status codes", () => {
				for (const status of [408, 429, 500, 502, 503, 504]) {
					const err = Object.assign(new Error("http error"), { status })
					expect(RetryableError.isRetryable(err)).toBe(true)
				}
			})

			it("returns false for non-retryable HTTP status", () => {
				const err = Object.assign(new Error("not found"), { status: 404 })
				expect(RetryableError.isRetryable(err)).toBe(false)
			})

			it("detects retryable network error codes", () => {
				for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]) {
					const err = Object.assign(new Error("network"), { code })
					expect(RetryableError.isRetryable(err)).toBe(true)
				}
			})

			it("detects timeout messages", () => {
				expect(RetryableError.isRetryable(new Error("Connection timed out"))).toBe(true)
				expect(RetryableError.isRetryable(new Error("request timeout"))).toBe(true)
			})

			it("detects rate limit messages", () => {
				expect(RetryableError.isRetryable(new Error("rate limit exceeded"))).toBe(true)
				expect(RetryableError.isRetryable(new Error("error 429"))).toBe(true)
			})

			it("detects fetch failed messages", () => {
				expect(RetryableError.isRetryable(new Error("fetch failed"))).toBe(true)
			})

			it("checks cause chain", () => {
				const err = new Error("outer")
				;(err as any).cause = { code: "ECONNRESET" }
				expect(RetryableError.isRetryable(err)).toBe(true)
			})

			it("returns false for normal errors", () => {
				expect(RetryableError.isRetryable(new Error("file not found"))).toBe(false)
				expect(RetryableError.isRetryable(new Error("syntax error"))).toBe(false)
			})
		})
	})
})
