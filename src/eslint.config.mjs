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
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": ["warn", { ignoreRestArgs: true }],
			"@typescript-eslint/no-require-imports": "warn",
			"@typescript-eslint/ban-ts-comment": ["warn", { "ts-expect-error": false, "ts-ignore": true, "ts-nocheck": true }],
			"no-console": ["warn", { allow: ["error", "warn"] }],
			// NOTE: The following rules require type information (parserOptions.project)
			// They are disabled until parserOptions are properly configured
			// "@typescript-eslint/no-floating-promises": "error",
			// "@typescript-eslint/require-await": "warn",
			// "@typescript-eslint/prefer-optional-chain": "warn",
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
