import { describe, expect, it } from "vitest"

import { classifyToolError, type ToolErrorCategory } from "../ToolErrorClassifier"

describe("classifyToolError", () => {
	it.each<{
		name: string
		error: unknown
		category: ToolErrorCategory
		retryable: boolean
		code?: string
	}>([
		{
			name: "missing files",
			error: Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			category: "filesystem",
			retryable: false,
			code: "ENOENT",
		},
		{
			name: "permission denied files",
			error: Object.assign(new Error("permission denied"), { code: "EACCES" }),
			category: "filesystem",
			retryable: false,
			code: "EACCES",
		},
		{
			name: "connection refused",
			error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
			category: "network",
			retryable: true,
			code: "ECONNREFUSED",
		},
		{
			name: "timeouts",
			error: Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" }),
			category: "timeout",
			retryable: true,
			code: "ETIMEDOUT",
		},
		{
			name: "tool permission denial",
			error: new Error("permission denied for tool execute_command"),
			category: "permission",
			retryable: false,
		},
		{
			name: "tool permission denial with EACCES code",
			error: Object.assign(new Error("permission denied for tool write_to_file"), { code: "EACCES" }),
			category: "permission",
			retryable: false,
		},
		{
			name: "blocked by hook",
			error: new Error("blocked by hook: disallowed command"),
			category: "permission",
			retryable: false,
		},
		{
			name: "EPERM filesystem error",
			error: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
			category: "filesystem",
			retryable: false,
			code: "EPERM",
		},
		{
			name: "plain EACCES without tool keywords",
			error: Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), { code: "EACCES" }),
			category: "filesystem",
			retryable: false,
			code: "EACCES",
		},
		{
			name: "validation failures",
			error: new Error("missing required param path"),
			category: "validation",
			retryable: false,
		},
		{
			name: "quota errors",
			error: new Error("429 rate limit exceeded"),
			category: "quota",
			retryable: true,
		},
	])("classifies $name", ({ error, category, retryable, code }) => {
		const result = classifyToolError(error)

		expect(result.category).toBe(category)
		expect(result.retryable).toBe(retryable)
		expect(result.telemetrySafe).toBe(true)
		if (code) {
			expect(result.code).toBe(code)
		}
	})

	it("sanitizes unknown errors instead of echoing the original message", () => {
		const result = classifyToolError(new Error("secret token abc123 leaked"))

		expect(result).toMatchObject({
			category: "unknown",
			retryable: false,
			telemetrySafe: false,
			sanitizedMessage: "Unexpected error",
		})
		expect(result.sanitizedMessage).not.toContain("abc123")
	})
})
