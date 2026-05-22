import { config } from "@njust-ai-cj/config-eslint/base"

export default [
	...config,
	{
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
]
