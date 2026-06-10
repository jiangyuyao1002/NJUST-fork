import { defineConfig, defaultExclude } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: [path.resolve(__dirname, "./vitest.setup.ts")],
		exclude: [
			...defaultExclude,
			".claude/**",
			"**/.claude/**",
			"webview-ui/**",
			"apps/**",
			"packages/**",
			"**/out/**",
		],
		watch: false,
		reporters,
		silent,
		maxWorkers: process.env.CI ? 1 : undefined,
		testTimeout: 30_000,
		hookTimeout: 30_000,
		retry: 2,
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../coverage/src",
			include: [
				"src/core/**",
				"src/api/**",
				"src/services/**",
				"src/chat/**",
				"src/utils/**",
				"src/integrations/**",
				"src/activate/**",
				"src/shared/**",
				"src/i18n/**",
			],
			exclude: [
				"**/__tests__/**",
				"**/__mocks__/**",
				"src/services/cangjie-corpus/**",
				"src/core/task/interfaces/**",
				"**/ClassifierStrategy.ts",
			],
			thresholds: {
				lines: 69,
				functions: 69,
				branches: 60,
				statements: 68,
			},
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
