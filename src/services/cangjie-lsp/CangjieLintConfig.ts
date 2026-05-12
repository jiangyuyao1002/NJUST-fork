import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

// ---------------------------------------------------------------------------
// .cjlintrc configuration file support
// ---------------------------------------------------------------------------

export type LintSeverity = "error" | "warning" | "info" | "off"

export interface LintRuleOverride {
	severity: LintSeverity
	message?: string
}

export interface CustomLintRule {
	id: string
	pattern: string
	severity: LintSeverity
	message: string
}

export interface CjlintRcConfig {
	/** Rule ID overrides: enable/disable or change severity */
	rules: Record<string, LintRuleOverride>
	/** Custom regex-based lint rules */
	custom: CustomLintRule[]
	/** Glob patterns for files to exclude from linting */
	exclude: string[]
}

const DEFAULT_CONFIG: CjlintRcConfig = {
	rules: {},
	custom: [],
	exclude: [],
}

const CONFIG_FILENAMES = [".cjlintrc", ".cjlintrc.json"]

/**
 * Manages project-specific lint configurations from `.cjlintrc` / `.cjlintrc.json`.
 */
export class CangjieLintConfig implements vscode.Disposable {
	private config: CjlintRcConfig = { ...DEFAULT_CONFIG }
	private configPath: string | undefined
	private watcher: vscode.FileSystemWatcher | undefined
	private disposables: vscode.Disposable[] = []
	private customDiagnostics: vscode.DiagnosticCollection

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.customDiagnostics = vscode.languages.createDiagnosticCollection("cjlint-custom")
		this.disposables.push(this.customDiagnostics)
	}

	/**
	 * Initialize: find and load .cjlintrc, set up file watcher.
	 */
	async initialize(): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
		if (!workspaceFolder) return

		const root = workspaceFolder.uri.fsPath
		for (const name of CONFIG_FILENAMES) {
			const candidate = path.join(root, name)
			if (fs.existsSync(candidate)) {
				this.configPath = candidate
				break
			}
		}

		this.loadConfig()

		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(root, ".cjlintrc{,.json}"),
		)
		this.disposables.push(this.watcher)
		this.watcher.onDidChange(() => this.loadConfig())
		this.watcher.onDidCreate((uri) => {
			this.configPath = uri.fsPath
			this.loadConfig()
		})
		this.watcher.onDidDelete(() => {
			this.config = { ...DEFAULT_CONFIG }
			this.configPath = undefined
			this.customDiagnostics.clear()
		})

		// Run custom rules on save
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) {
					this.runCustomRules(doc)
				}
			}),
		)
	}

	private loadConfig(): void {
		if (!this.configPath || !fs.existsSync(this.configPath)) {
			this.config = { ...DEFAULT_CONFIG }
			return
		}

		try {
			const raw = fs.readFileSync(this.configPath, "utf-8")
			const parsed = JSON.parse(raw) as Partial<CjlintRcConfig>
			this.config = {
				rules: parsed.rules ?? {},
				custom: Array.isArray(parsed.custom) ? parsed.custom : [],
				exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
			}
			this.outputChannel.appendLine(
				`[LintConfig] Loaded ${this.configPath}: ${Object.keys(this.config.rules).length} rule overrides, ${this.config.custom.length} custom rules`,
			)
		} catch (err) {
			this.outputChannel.appendLine(`[LintConfig] Failed to parse ${this.configPath}: ${err}`)
			this.config = { ...DEFAULT_CONFIG }
		}
	}

	/**
	 * Check if a rule should be suppressed (severity = "off").
	 */
	isRuleSuppressed(ruleId: string): boolean {
		const override = this.config.rules[ruleId]
		return override?.severity === "off"
	}

	/**
	 * Get the effective severity for a rule, if overridden.
	 */
	getEffectiveSeverity(ruleId: string): vscode.DiagnosticSeverity | undefined {
		const override = this.config.rules[ruleId]
		if (!override) return undefined
		return this.mapSeverity(override.severity)
	}

	/**
	 * Check if a file path should be excluded from linting.
	 */
	isFileExcluded(filePath: string): boolean {
		if (this.config.exclude.length === 0) return false
		const relPath = vscode.workspace.asRelativePath(filePath).replace(/\\/g, "/")
		return this.config.exclude.some((pattern) => {
			if (pattern.includes("*")) {
				// Convert glob to a safe regex: only allow * and ? metacharacters,
				// escape everything else, and anchor to avoid ReDoS.
				const escaped = pattern
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, "[^/]*")
					.replace(/\?/g, "[^/]")
				try {
					return new RegExp("^" + escaped + "$").test(relPath)
				} catch {
					return false
				}
			}
			return relPath.startsWith(pattern)
		})
	}

	/**
	 * Filter and adjust diagnostics from cjlint based on .cjlintrc rules.
	 */
	filterDiagnostics(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
		return diagnostics
			.filter((d) => {
				const ruleId = this.extractRuleId(d.message)
				return !ruleId || !this.isRuleSuppressed(ruleId)
			})
			.map((d) => {
				const ruleId = this.extractRuleId(d.message)
				if (ruleId) {
					const severity = this.getEffectiveSeverity(ruleId)
					if (severity !== undefined) {
						return new vscode.Diagnostic(d.range, d.message, severity)
					}
				}
				return d
			})
	}

	/**
	 * Run custom regex-based lint rules against a document.
	 */
	runCustomRules(document: vscode.TextDocument): void {
		if (this.config.custom.length === 0) {
			this.customDiagnostics.delete(document.uri)
			return
		}

		if (this.isFileExcluded(document.fileName)) {
			this.customDiagnostics.delete(document.uri)
			return
		}

		const diagnostics: vscode.Diagnostic[] = []
		const text = document.getText()
		const lines = text.split("\n")

		for (const rule of this.config.custom) {
			try {
				const regex = new RegExp(rule.pattern, "g")
				for (let i = 0; i < lines.length; i++) {
					regex.lastIndex = 0
					let match: RegExpExecArray | null
					while ((match = regex.exec(lines[i])) !== null) {
						const range = new vscode.Range(i, match.index, i, match.index + match[0].length)
						const severity = this.mapSeverity(rule.severity)
						if (severity === undefined) continue
						const diag = new vscode.Diagnostic(
							range,
							`[${rule.id}] ${rule.message}`,
							severity,
						)
						diag.source = "cjlint-custom"
						diagnostics.push(diag)
					}
				}
			} catch {
				// Skip invalid regex patterns
			}
		}

		this.customDiagnostics.set(document.uri, diagnostics)
	}

	private extractRuleId(message: string): string | undefined {
		const m = message.match(/^\[(\w+(?:\.\w+)*)\]/)
		return m ? m[1] : undefined
	}

	private mapSeverity(severity: LintSeverity): vscode.DiagnosticSeverity | undefined {
		switch (severity) {
			case "error": return vscode.DiagnosticSeverity.Error
			case "warning": return vscode.DiagnosticSeverity.Warning
			case "info": return vscode.DiagnosticSeverity.Information
			case "off": return undefined
			default: return vscode.DiagnosticSeverity.Warning
		}
	}

	get currentConfig(): Readonly<CjlintRcConfig> {
		return this.config
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose())
	}
}
