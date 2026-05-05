import { config } from "@njust-ai-cj/config-eslint/base"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		ignores: [
			// Build artifacts co-located with source (js, d.ts, maps)
			"src/**/*.js",
			"src/**/*.d.ts",
			"src/**/*.d.ts.map",
			"src/**/*.js.map",
		],
	},
]
