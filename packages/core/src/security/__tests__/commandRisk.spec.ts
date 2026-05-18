import { describe, it, expect } from "vitest"
import { assessCommandRisk } from "../commandRisk.js"

describe("assessCommandRisk", () => {
	it("returns high risk for empty command", () => {
		const r = assessCommandRisk("")
		expect(r.level).toBe("high")
	})

	it("returns high risk for rm -rf", () => {
		const r = assessCommandRisk("rm -rf /")
		expect(r.level).toBe("high")
	})

	it("returns high risk for git reset --hard", () => {
		const r = assessCommandRisk("git reset --hard HEAD~1")
		expect(r.level).toBe("high")
	})

	it("returns high risk for del on Windows", () => {
		// eslint-disable-next-line no-useless-escape
		const r = assessCommandRisk("del /f /q C:\temp\*")
		expect(r.level).toBe("high")
	})

	it("detects shell chaining with pipes", () => {
		const r = assessCommandRisk("cat file | grep foo")
		expect(r.level).toBe("medium")
	})

	it("detects shell chaining with &&", () => {
		const r = assessCommandRisk("npm test && npm run build")
		expect(r.level).toBe("medium")
	})

	it("returns medium for npm install", () => {
		const r = assessCommandRisk("npm install express")
		expect(r.level).toBe("medium")
	})

	it("returns low for git status", () => {
		const r = assessCommandRisk("git status")
		expect(r.level).toBe("low")
	})

	it("returns low for ls", () => {
		const r = assessCommandRisk("ls -la")
		expect(r.level).toBe("low")
	})

	it("returns medium for unknown command", () => {
		const r = assessCommandRisk("some-unknown-command --flag")
		expect(r.level).toBe("medium")
	})

	it("handles PowerShell Remove-Item as high risk", () => {
		// eslint-disable-next-line no-useless-escape
		const r = assessCommandRisk("Remove-Item -Recurse -Force C:\data")
		expect(r.level).toBe("high")
	})

	it("handles taskkill as high risk", () => {
		const r = assessCommandRisk("taskkill /F /IM node.exe")
		expect(r.level).toBe("high")
	})
})
