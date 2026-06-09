import { defineConfig, defaultExclude } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { reporters, onConsoleLog } = resolveVerbosity()

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
		silent: false,
		maxWorkers: process.env.CI ? 1 : undefined,
		testTimeout: 30_000,
		hookTimeout: 30_000,
		onConsoleLog,
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../coverage/src",
			include: ["src/core/**", "src/api/**", "src/services/**", "src/chat/**"],
			exclude: [
				"**/__tests__/**",
				"**/__mocks__/**",
				"src/services/cangjie-corpus/**",
				"src/core/task/interfaces/**",
				"**/ClassifierStrategy.ts",
			],
			thresholds: {
				lines: 69,
				functions: 70,
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
