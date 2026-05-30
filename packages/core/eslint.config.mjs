import { config } from "@njust-ai/config-eslint/base-strict"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		files: ["**/*.ts"],
		rules: {
			"no-console": "error",
		},
	},
	{
		files: ["**/__tests__/**", "**/*.spec.ts", "**/*.test.ts", "**/__mocks__/**", "**/shared/logger.ts"],
		rules: {
			"no-console": "off",
		},
	},
]
