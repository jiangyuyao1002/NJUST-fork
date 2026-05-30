import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		environment: "jsdom",
		pool: "forks",
		include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
		onConsoleLog,
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../coverage/webview-ui",
			include: ["src/**"],
			exclude: [
				"src/**/*.spec.ts",
				"src/**/*.spec.tsx",
				"src/__mocks__/**",
				"src/i18n/__mocks__/**",
				"src/utils/test-utils.tsx",
			],
			thresholds: {
				lines: 60,
				functions: 46,
				branches: 71,
				statements: 60,
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@src": path.resolve(__dirname, "./src"),
			"@shared": path.resolve(__dirname, "../src/shared"),
			// Mock the vscode module for tests since it's not available outside
			// VS Code extension context.
			vscode: path.resolve(__dirname, "./src/__mocks__/vscode.ts"),
		},
	},
})
