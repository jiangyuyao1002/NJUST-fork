import { describe, expect, it } from "vitest"
import { classifyBashCommand } from "../bashClassifier.js"

describe("classifyBashCommand", () => {
	it("marks safe commands", () => {
		expect(classifyBashCommand("git status")).toBe("safe")
	})
	it("marks dangerous commands", () => {
		expect(classifyBashCommand("rm -rf /tmp/x")).toBe("dangerous")
	})
})
