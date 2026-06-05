import { reactStrictConfig } from "@njust-ai/config-eslint/react-strict"

/** @type {import("eslint").Linter.Config} */
export default [
	...reactStrictConfig,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					args: "all",
					ignoreRestSiblings: true,
					varsIgnorePattern: "^_",
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "warn",
			"react/prop-types": "off",
			"react/display-name": "off",
		},
	},
	{
		files: ["src/components/chat/ChatRow.tsx", "src/components/settings/ModelInfoView.tsx"],
		rules: {
			"react/jsx-key": "off",
		},
	},
	{
		files: [
			"src/components/chat/ChatRow.tsx",
			"src/components/chat/ChatView.tsx",
			"src/components/chat/BrowserSessionRow.tsx",
			"src/components/history/useTaskSearch.ts",
		],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		files: ["src/__mocks__/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	// Test files: allow explicit any for mocks and test helpers
	{
		files: [
			"src/**/*.spec.ts",
			"src/**/*.spec.tsx",
			"src/**/__tests__/**/*.ts",
			"src/**/__tests__/**/*.tsx",
			"src/**/__mocks__/**/*.ts",
			"src/**/__mocks__/**/*.tsx",
		],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	// TSX components: no-explicit-any kept off due to 687+ existing usages in untyped
	// third-party integrations. Will be progressively tightened via dedicated PRs.
	{
		files: ["src/**/*.tsx"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	// Files integrating with untyped third-party libraries (Shiki, StackTrace.js)
	{
		files: [
			"src/utils/highlightDiff.ts",
			"src/utils/sourceMapUtils.ts",
			"src/utils/sourceMapInitializer.ts",
			"src/utils/parseUnifiedDiff.ts",
			"src/utils/textMateToHljs.ts",
			"src/components/settings/transforms.ts",
			"src/components/ui/hooks/useSelectedModel.ts",
			"src/components/marketplace/MarketplaceViewStateManager.ts",
		],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
]
