import { config } from "@njust-ai-cj/config-eslint/base-strict"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		rules: {
			"no-regex-spaces": "warn",
			"no-useless-escape": "warn",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"prefer-const": "error",
			// 存量告警较多时：先 warn，分批清零后再改为 error（与 P0-1 决策矩阵一致）。
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrors: "none",
				},
			],
			"@typescript-eslint/no-explicit-any": ["warn", { ignoreRestArgs: true }],
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/ban-ts-comment": "off",
		},
	},
	{
		files: ["core/assistant-message/presentAssistantMessage.ts", "core/webview/webviewMessageHandler.ts"],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		files: ["__mocks__/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			globals: {
				process: "readonly",
				console: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				URL: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
			},
		},
	},
	{
		ignores: ["webview-ui", "out"],
	},
]
