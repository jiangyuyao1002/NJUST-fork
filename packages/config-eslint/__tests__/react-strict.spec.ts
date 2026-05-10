import { describe, it, expect } from "vitest"

describe("react-strict ESLint config", () => {
	it("does not include onlyWarn plugin in any config block", async () => {
		const { reactStrictConfig } = await import("../react-strict.js")

		const configs = Array.isArray(reactStrictConfig) ? reactStrictConfig : [reactStrictConfig]

		for (const block of configs) {
			if (block && typeof block === "object" && "plugins" in block) {
				const plugins = (block as any).plugins
				if (plugins && typeof plugins === "object") {
					expect(plugins).not.toHaveProperty("only-warn")
					expect(plugins).not.toHaveProperty("onlyWarn")
				}
			}
		}
	})

	it("includes TypeScript ESLint recommended rules", async () => {
		const { reactStrictConfig } = await import("../react-strict.js")

		const configs = Array.isArray(reactStrictConfig) ? reactStrictConfig : [reactStrictConfig]
		const allRules = configs
			.filter((block: any) => block?.rules && typeof block.rules === "object")
			.flatMap((block: any) => Object.keys(block.rules))

		const hasTsRules = allRules.some((key: string) => key.startsWith("@typescript-eslint/"))
		expect(hasTsRules).toBe(true)
	})

	it("includes React recommended config", async () => {
		const { reactStrictConfig } = await import("../react-strict.js")

		const configs = Array.isArray(reactStrictConfig) ? reactStrictConfig : [reactStrictConfig]
		const allRules = configs
			.filter((block: any) => block?.rules && typeof block.rules === "object")
			.flatMap((block: any) => Object.keys(block.rules))

		const hasReactRules = allRules.some((key: string) => key.startsWith("react/"))
		expect(hasReactRules).toBe(true)
	})
})
