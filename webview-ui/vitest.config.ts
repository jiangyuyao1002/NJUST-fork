import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters } = resolveVerbosity()

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
		coverage: {
			provider: "v8",
			reporter: ["json", "html", "text-summary"],
			reportsDirectory: "../coverage/webview-ui",
			include: ["src/**"],
			exclude: [
				"src/**/*.spec.ts",
				"src/**/*.spec.tsx",
				"src/**/*.test.ts",
				"src/**/*.test.tsx",
				"src/**/__tests__/**",
				"src/**/__mocks__/**",
				"src/__mocks__/**",
				"src/i18n/__mocks__/**",
				"src/utils/test-utils.tsx",
				"src/vite-plugins/**",
				"src/index.tsx",
				"src/utils/sourceMapInitializer.ts",
			],
			thresholds: {
				lines: 55,
				functions: 40,
				branches: 45,
				statements: 55,
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
