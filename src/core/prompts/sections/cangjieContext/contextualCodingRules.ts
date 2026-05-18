import * as vscode from "vscode"

import { matchCjcErrorPattern } from "../../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import {
	COMMON_ERROR_TABLE_TEMPLATE,
	CORE_PROJECT_TEMPLATE,
	DIAGNOSTIC_CODE_TEMPLATES,
	TEST_FILE_TEMPLATE,
} from "../CangjiePromptTemplates"
import type { CjpmProjectInfo } from "./cjpmProjectParser"

const CODING_RULES_MAX_CHARS = 3000

export function buildContextualCodingRules(
	imports: string[],
	projectInfo: CjpmProjectInfo | null,
	diagnostics: vscode.Diagnostic[],
	hasSpecificDiagnosticGuidance = false,
): string | null {
	const parts: string[] = []
	let budget = CODING_RULES_MAX_CHARS

	const hasActiveCangjieFile = vscode.window.visibleTextEditors.some(
		(e) => e.document.languageId === "cangjie" || e.document.fileName.endsWith(".cj"),
	)

	if (!hasActiveCangjieFile && !projectInfo) return null

	const hasTestFile = vscode.window.visibleTextEditors.some(
		(e) => e.document.fileName.endsWith("_test.cj"),
	)
	const hasSyncImport = imports.some((i) => i.startsWith("std.sync"))
	const diags = diagnostics
	const hasErrors = diags.some(
		(d) => d.severity === vscode.DiagnosticSeverity.Error,
	)
	const isWorkspace = projectInfo?.isWorkspace ?? false

	// Always inject the core project templates (compact)
	const coreTemplates = CORE_PROJECT_TEMPLATE
	if (budget >= coreTemplates.length) {
		parts.push(coreTemplates)
		budget -= coreTemplates.length
	}

	// Test templates when editing test files
	if (hasTestFile) {
		const testTemplate = TEST_FILE_TEMPLATE
		if (budget >= testTemplate.length) {
			parts.push(testTemplate)
			budget -= testTemplate.length
		}
	}

	// Error handling patterns when there are active errors.
	// If diagnostics/doc mappings are already injected in detail, keep this table compact.
	if (hasErrors && !hasSpecificDiagnosticGuidance) {
		const errorTable = COMMON_ERROR_TABLE_TEMPLATE
		if (budget >= errorTable.length) {
			parts.push(errorTable)
			budget -= errorTable.length
		}
	}

	// Diagnostic-driven targeted code templates based on actual error categories
	if (hasErrors && diags.length > 0) {
		const errorMessages = diags
			.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
			.map((d) => (typeof d.message === "string" ? d.message : ""))
			.filter(Boolean)
		const categoriesPresent = new Set<string>()
		for (const msg of errorMessages) {
			const pattern = matchCjcErrorPattern(msg)
			if (pattern) categoriesPresent.add(pattern.category)
		}

		const diagnosticTemplates = DIAGNOSTIC_CODE_TEMPLATES
		for (const dt of diagnosticTemplates) {
			if (dt.categories.some((c) => categoriesPresent.has(c))) {
				if (budget >= dt.template.length) {
					parts.push(dt.template)
					budget -= dt.template.length
				}
			}
		}
	}
	// Anti-patterns for let/var/mut when editing struct code
	if (hasActiveCangjieFile) {
		const antiPatterns =
			"### 常见反例\n" +
			"- ❌ `let c = Counter(); c.inc()` — let 绑定的 struct 不能调用 mut 方法 → ✅ `var c = Counter()`\n" +
			"- ❌ `struct Node { let next: Node }` — struct 不能自引用 → ✅ `class Node { let next: ?Node = None }`\n" +
			"- ❌ Option 直接 unwrap → ✅ 用 `??` 默认值或 match/if-let 安全解包\n"
		if (budget >= antiPatterns.length) {
			parts.push(antiPatterns)
			budget -= antiPatterns.length
		}
	}

	// Concurrency rules when using std.sync
	if (hasSyncImport) {
		const concurrencyRules =
			"### 并发注意事项\n" +
			"- spawn 块内不能直接捕获 `var` 变量\n" +
			"- 共享可变状态必须使用 Mutex/AtomicInt 保护\n" +
			"- 使用 `synchronized` 块或 `mutex.lock()/unlock()` 确保互斥\n"
		if (budget >= concurrencyRules.length) {
			parts.push(concurrencyRules)
			budget -= concurrencyRules.length
		}
	}

	// Workspace workflow when it's a multi-module project
	if (isWorkspace) {
		const wsWorkflow =
			"### Workspace 项目规则\n" +
			"- `[workspace]` 和 `[package]` 不能在同一 cjpm.toml\n" +
			"- 模块间依赖: `{ path = \"../module_name\" }` 写在子模块的 `[dependencies]`\n" +
			"- `cjpm run --name <模块>` 运行指定模块\n" +
			"- 每个模块需独立的 cjpm.toml 和 src/ 目录\n"
		if (budget >= wsWorkflow.length) {
			parts.push(wsWorkflow)
			budget -= wsWorkflow.length
		}
	}

	if (parts.length === 0) return null
	return parts.join("\n")
}
