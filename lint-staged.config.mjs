export default {
	// ESLint 9 flat config: --config 指向各包自己的配置，解决根目录无 eslint.config 的问题
	"src/**/*.{ts,tsx,mjs}": ["eslint --fix --config src/eslint.config.mjs --no-warn-ignored"],
	"webview-ui/**/*.{ts,tsx,mjs}": ["eslint --fix --config webview-ui/eslint.config.mjs --no-warn-ignored"],
	"apps/cli/**/*.{ts,tsx,mjs}": ["eslint --fix --config apps/cli/eslint.config.mjs --no-warn-ignored"],
	"apps/web-njust-ai/**/*.{ts,tsx,mjs}": [
		"eslint --fix --config apps/web-njust-ai/eslint.config.mjs --no-warn-ignored",
	],
	"apps/web-evals/**/*.{ts,tsx,mjs}": ["eslint --fix --config apps/web-evals/eslint.config.mjs --no-warn-ignored"],
	"apps/vscode-e2e/**/*.{ts,tsx,mjs}": ["eslint --fix --config apps/vscode-e2e/eslint.config.mjs --no-warn-ignored"],
	"packages/build/**/*.{ts,tsx,mjs}": ["eslint --fix --config packages/build/eslint.config.mjs --no-warn-ignored"],
	"packages/core/**/*.{ts,tsx,mjs}": ["eslint --fix --config packages/core/eslint.config.mjs --no-warn-ignored"],
	"packages/evals/**/*.{ts,tsx,mjs}": ["eslint --fix --config packages/evals/eslint.config.mjs --no-warn-ignored"],
	"packages/ipc/**/*.{ts,tsx,mjs}": ["eslint --fix --config packages/ipc/eslint.config.mjs --no-warn-ignored"],
	"packages/mock-api-server/**/*.{ts,tsx,mjs}": [
		"eslint --fix --config packages/mock-api-server/eslint.config.mjs --no-warn-ignored",
	],
	"packages/prompt-engine/**/*.{ts,tsx,mjs}": [
		"eslint --fix --config packages/prompt-engine/eslint.config.mjs --no-warn-ignored",
	],
	"packages/telemetry/**/*.{ts,tsx,mjs}": [
		"eslint --fix --config packages/telemetry/eslint.config.mjs --no-warn-ignored",
	],
	"packages/types/**/*.{ts,tsx,mjs}": ["eslint --fix --config packages/types/eslint.config.mjs --no-warn-ignored"],
	"packages/vscode-shim/**/*.{ts,tsx,mjs}": [
		"eslint --fix --config packages/vscode-shim/eslint.config.mjs --no-warn-ignored",
	],
	// Prettier as global rule — avoids conflict with eslint --fix
	"**/*.{ts,tsx,mjs,js,cjs,json,css,md}": ["prettier --write"],
	// TypeScript 文件触发 typecheck(函数形式 → 只跑一次,无论几个 .ts 文件)
	"**/*.{ts,tsx}": () => ["pnpm check-types"],
	// 所有文件触发 secrets scan(函数形式 → 只跑一次)
	"*": () => ["pnpm check-secrets"],
}
