import { defineConfig, defaultExclude } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: [path.resolve(__dirname, "./vitest.setup.ts")],
		exclude: [...defaultExclude, "webview-ui/**", "apps/**", "packages/**", "**/out/**"],
		watch: false,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../coverage/src",
			include: [
				"src/core/**",
				"src/api/**",
				"src/services/**",
			],
			exclude: [
				"**/__tests__/**",
				"**/__mocks__/**",
				"**/cangjie-context.ts",
			],
			thresholds: {
				lines: 60,
				functions: 50,
				branches: 40,
				statements: 60,
			},
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
