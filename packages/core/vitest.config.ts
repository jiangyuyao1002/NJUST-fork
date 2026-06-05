import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		watch: false,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/**/__tests__/**", "src/**/__mocks__/**"],
			reporter: ["json", "text-summary"],
			reportsDirectory: "../../coverage/packages-core",
			thresholds: {
				lines: 50,
				functions: 45,
				branches: 35,
				statements: 50,
			},
		},
	},
})
