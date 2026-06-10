import { describe, it, expect } from "vitest"

import { getCapabilitiesSection } from "../capabilities"

describe("getCapabilitiesSection", () => {
	it("should include CAPABILITIES heading and cwd in output", () => {
		const result = getCapabilitiesSection("/home/user/project")

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("/home/user/project")
	})

	it("should not include MCP section when mcpHub is not provided", () => {
		const result = getCapabilitiesSection("/workspace")

		expect(result).not.toContain("MCP servers")
	})

	it("should include MCP section when mcpHub is provided", () => {
		const fakeHub = {} as any
		const result = getCapabilitiesSection("/workspace", fakeHub)

		expect(result).toContain("MCP servers")
	})
})
