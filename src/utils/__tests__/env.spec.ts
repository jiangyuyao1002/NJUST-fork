import { describe, it, expect, vi, beforeEach } from "vitest"

const { loggerWarnMock } = vi.hoisted(() => ({
	loggerWarnMock: vi.fn(),
}))

vi.mock("../../shared/logger", () => ({
	logger: {
		warn: loggerWarnMock,
	},
}))

import { mergeSafeEnv, DANGEROUS_ENV_KEYS } from "../env"

describe("mergeSafeEnv", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("merges normal variables without modification", () => {
		const defaults = { HOME: "/home/user", PATH: "/usr/bin" }
		const user = { MY_CUSTOM_VAR: "hello" }
		const result = mergeSafeEnv(defaults, user)

		expect(result).toMatchObject({
			HOME: "/home/user",
			PATH: "/usr/bin",
			MY_CUSTOM_VAR: "hello",
		})
		expect(loggerWarnMock).not.toHaveBeenCalled()
	})

	it("filters dangerous env variables and logs a warning", () => {
		const defaults = { PATH: "/usr/bin" }
		const user = { LD_PRELOAD: "/tmp/evil.so", MY_VAR: "ok" }
		const result = mergeSafeEnv(defaults, user, "test-server")

		expect(result.LD_PRELOAD).toBeUndefined()
		expect(result.MY_VAR).toBe("ok")
		expect(loggerWarnMock).toHaveBeenCalledWith(
			"StdioTransport",
			"[test-server] Blocked dangerous env variable: LD_PRELOAD",
		)
	})

	it("blocks all known dangerous keys", () => {
		const defaults: Record<string, string> = {}
		const user: Record<string, string> = {}
		DANGEROUS_ENV_KEYS.forEach((key) => {
			user[key] = "injected"
		})

		const result = mergeSafeEnv(defaults, user)

		Object.keys(user).forEach((key) => {
			expect(result[key]).toBeUndefined()
		})
		expect(loggerWarnMock).toHaveBeenCalledTimes(DANGEROUS_ENV_KEYS.size)
	})

	it("appends PATH instead of overwriting", () => {
		const defaults = { PATH: "/usr/bin:/bin" }
		const user = { PATH: "/custom/bin" }
		const delimiter = process.platform === "win32" ? ";" : ":"
		const result = mergeSafeEnv(defaults, user)

		expect(result.PATH).toBe(`/custom/bin${delimiter}/usr/bin:/bin`)
	})

	it("appends PATHEXT instead of overwriting", () => {
		const defaults = { PATHEXT: ".COM;.EXE;.BAT" }
		const user = { PATHEXT: ".PY" }
		const delimiter = process.platform === "win32" ? ";" : ":"
		const result = mergeSafeEnv(defaults, user)

		expect(result.PATHEXT).toBe(`.PY${delimiter}.COM;.EXE;.BAT`)
	})

	it("overwrites non-PATH variables", () => {
		const defaults = { HOME: "/home/user" }
		const user = { HOME: "/tmp/other" }
		const result = mergeSafeEnv(defaults, user)

		expect(result.HOME).toBe("/tmp/other")
	})

	it("ignores undefined values in user env", () => {
		const defaults = { FOO: "bar" }
		const user = { FOO: undefined }
		const result = mergeSafeEnv(defaults, user)

		expect(result.FOO).toBeUndefined()
	})

	it("appends Windows-style Path to defaults PATH without creating duplicate keys", () => {
		const defaults = { PATH: "/usr/bin" }
		const user = { Path: "/custom/bin" }
		const delimiter = process.platform === "win32" ? ";" : ":"
		const result = mergeSafeEnv(defaults, user)

		expect(result.Path).toBeUndefined()
		expect(result.PATH).toBe(`/custom/bin${delimiter}/usr/bin`)
		expect(Object.keys(result).filter((k) => k.toUpperCase() === "PATH").length).toBe(1)
	})

	it("appends user PATH to defaults Path on Windows", () => {
		const defaults = { Path: "/usr/bin" }
		const user = { PATH: "/custom/bin" }
		const delimiter = process.platform === "win32" ? ";" : ":"
		const result = mergeSafeEnv(defaults, user)

		expect(result.PATH).toBeUndefined()
		expect(result.Path).toBe(`/custom/bin${delimiter}/usr/bin`)
		expect(Object.keys(result).filter((k) => k.toUpperCase() === "PATH").length).toBe(1)
	})

	it("does not prepend delimiter when defaults PATH is empty string", () => {
		const defaults = { PATH: "" }
		const user = { PATH: "/custom/bin" }
		const result = mergeSafeEnv(defaults, user)

		expect(result.PATH).toBe("/custom/bin")
	})

	it("blocks NODE_PATH as dangerous", () => {
		const defaults = { PATH: "/usr/bin" }
		const user = { NODE_PATH: "/tmp/evil" }
		const result = mergeSafeEnv(defaults, user, "test")

		expect(result.NODE_PATH).toBeUndefined()
		expect(loggerWarnMock).toHaveBeenCalledWith(
			"StdioTransport",
			"[test] Blocked dangerous env variable: NODE_PATH",
		)
	})

	it("blocks PYTHONSTARTUP as dangerous", () => {
		const defaults = { PATH: "/usr/bin" }
		const user = { PYTHONSTARTUP: "/tmp/evil.py" }
		const result = mergeSafeEnv(defaults, user, "test")

		expect(result.PYTHONSTARTUP).toBeUndefined()
		expect(loggerWarnMock).toHaveBeenCalledWith(
			"StdioTransport",
			"[test] Blocked dangerous env variable: PYTHONSTARTUP",
		)
	})
})
