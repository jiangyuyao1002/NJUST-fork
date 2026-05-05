import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: [path.resolve(__dirname, "./vitest.setup.ts")],
		watch: false,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
		coverage: {
			provider: "v8",
			reportsDirectory: "../coverage/src",
			include: [
				"core/context-management/**",
				"core/condense/**",
				"core/tools/**",
				"core/task/CloudAgentOrchestrator.ts",
				"api/retry/**",
				"services/cloud-agent/**",
			],
			thresholds: {
				lines: 40,
				functions: 40,
				branches: 30,
				statements: 40,
			},
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
