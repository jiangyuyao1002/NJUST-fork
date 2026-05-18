import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		watch: false,
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../../coverage/prompt-engine",
			include: ["src/**/*.ts"],
			exclude: ["src/**/__tests__/**"],
			thresholds: {
				lines: 85,
				functions: 85,
				branches: 85,
				statements: 85,
			},
		},
	},
})
