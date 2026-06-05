import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { Package } from "../shared/package"
import { getErrorMessage } from "../shared/error-utils"
import { logger } from "../shared/logger"
import { CangjieLspClient } from "../services/cangjie-lsp/CangjieLspClient"
import { CangjieLspStatusBar } from "../services/cangjie-lsp/CangjieLspStatusBar"
import { CjfmtFormatter } from "../services/cangjie-lsp/CjfmtFormatter"
import { CjlintDiagnostics } from "../services/cangjie-lsp/CjlintDiagnostics"
import { CjpmTaskProvider } from "../services/cangjie-lsp/CjpmTaskProvider"
import { registerCangjieCommands } from "../services/cangjie-lsp/cangjieCommands"
import { checkAndPromptSdkSetup } from "../services/cangjie-lsp/CangjieSdkSetup"
import { probeCangjieToolchain } from "../services/cangjie-lsp/cangjieToolUtils"
import { CangjieCodeActionProvider } from "../services/cangjie-lsp/CangjieCodeActionProvider"
import { CangjieDocumentSymbolProvider } from "../services/cangjie-lsp/CangjieDocumentSymbolProvider"
import { CangjieFoldingRangeProvider } from "../services/cangjie-lsp/CangjieFoldingRangeProvider"
import { CangjieHoverProvider } from "../services/cangjie-lsp/CangjieHoverProvider"
import { CangjieTestCodeLensProvider } from "../services/cangjie-lsp/CangjieTestCodeLensProvider"
import {
	CangjieDebugAdapterFactory,
	CangjieDebugConfigurationProvider,
} from "../services/cangjie-lsp/CangjieDebugAdapterFactory"
import { CangjieSymbolIndex } from "../services/cangjie-lsp/CangjieSymbolIndex"
import { CangjieDefinitionProvider } from "../services/cangjie-lsp/CangjieDefinitionProvider"
import { CangjieReferenceProvider } from "../services/cangjie-lsp/CangjieReferenceProvider"
import { CangjieEnhancedRenameProvider } from "../services/cangjie-lsp/CangjieEnhancedRenameProvider"
import {
	CangjieMacroCodeLensProvider,
	CangjieMacroHoverProvider,
	registerMacroCommands,
} from "../services/cangjie-lsp/CangjieMacroProvider"
import { CangjieSemanticTokensProvider } from "../services/cangjie-lsp/CangjieSemanticTokensProvider"
import { CangjieInlayHintsProvider } from "../services/cangjie-lsp/CangjieInlayHintsProvider"
import { CangjieCallHierarchyProvider } from "../services/cangjie-lsp/CangjieCallHierarchyProvider"
import { CangjieTypeHierarchyProvider } from "../services/cangjie-lsp/CangjieTypeHierarchyProvider"
import { CangjieWorkspaceSymbolProvider } from "../services/cangjie-lsp/CangjieWorkspaceSymbolProvider"
import { CangjieCompileGuard } from "../services/cangjie-lsp/CangjieCompileGuard"
import { invalidateCangjieToolEnvCache } from "../services/cangjie-lsp/cangjieToolUtils"
import { bumpCangjieL3TtlConfigCache, invalidateCangjieL3ContextCache } from "../core/prompts/sections/cangjie-context"
import { registerCangjieRulesHotReload } from "../services/cangjie-lsp/cangjieRulesHotReload"
import { cangjieDiagnosticModeSwitch } from "../services/cangjie-lsp/cangjieDiagnosticModeSwitch"
import { CangjieLintConfig } from "../services/cangjie-lsp/CangjieLintConfig"
import { CangjieMetricsCollector } from "../services/cangjie-lsp/CangjieMetricsCollector"

// Module-level state
let cangjieLspClient: CangjieLspClient | undefined
let cangjieLspStatusBar: CangjieLspStatusBar | undefined
let cjfmtFormatter: CjfmtFormatter | undefined
let cjlintDiagnostics: CjlintDiagnostics | undefined
let cjpmTaskProvider: CjpmTaskProvider | undefined
let cangjieSymbolIndex: CangjieSymbolIndex | undefined
let cangjieCompileGuard: CangjieCompileGuard | undefined
let cangjieDebugFactory: CangjieDebugAdapterFactory | undefined
let lastCangjieToolchainGapWarn = 0

function scheduleCangjieToolchainGapCheck(outputChannel: vscode.OutputChannel): void {
	void (async () => {
		if (Date.now() - lastCangjieToolchainGapWarn < 3_600_000) return
		if (!vscode.workspace.workspaceFolders?.some((f) => fs.existsSync(path.join(f.uri.fsPath, "cjpm.toml")))) {
			return
		}
		const probes = await probeCangjieToolchain()
		const bad = probes.filter((p) => !p.ok)
		if (bad.length === 0) return
		lastCangjieToolchainGapWarn = Date.now()
		const detail = bad.map((b) => b.label).join(", ")
		await vscode.window
			.showWarningMessage(`仓颉工具链不完整或不可运行：${detail}`, "验证 SDK", "打开工具设置")
			.then((c) => {
				if (c === "验证 SDK") void vscode.commands.executeCommand("njust-ai.cangjieVerifySdk")
				if (c === "打开工具设置") {
					void vscode.commands.executeCommand("workbench.action.openSettings", `${Package.name}.cangjieTools`)
				}
			})
	})().catch((err) => {
		outputChannel.appendLine(`[CangjieToolchain] Gap check failed: ${getErrorMessage(err)}`)
		TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
	})
}

export interface CangjieInitResult {
	/** Call after ClineProvider is created to wire up compileLocal */
	compileGuardAccessor: () => CangjieCompileGuard | undefined
}

/**
 * Initialize all Cangjie language support:
 * LSP client, debugger, status bar, formatter, linter, compile guard,
 * language providers, symbol index, commands, and test run/debug.
 */
export function initializeCangjieLanguage(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): CangjieInitResult {
	// Config watchers for Cangjie
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(Package.name)) {
				invalidateCangjieToolEnvCache()
				bumpCangjieL3TtlConfigCache()
			}
		}),
	)

	let l3InvalidateTimer: ReturnType<typeof setTimeout> | undefined
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) {
				invalidateCangjieL3ContextCache()
			}
		}),
	)
	context.subscriptions.push(
		vscode.languages.onDidChangeDiagnostics(() => {
			if (l3InvalidateTimer !== undefined) clearTimeout(l3InvalidateTimer)
			l3InvalidateTimer = setTimeout(() => {
				l3InvalidateTimer = undefined
				invalidateCangjieL3ContextCache()
			}, 800)
		}),
	)
	context.subscriptions.push({
		dispose() {
			if (l3InvalidateTimer !== undefined) clearTimeout(l3InvalidateTimer)
		},
	})

	registerCangjieRulesHotReload(context, outputChannel)

	// Lint config
	const cangjieLintConfig = new CangjieLintConfig(outputChannel)
	context.subscriptions.push(cangjieLintConfig)
	void cangjieLintConfig.initialize().catch((err) => {
		outputChannel.appendLine(`[CangjieLintConfig] Initialize failed: ${getErrorMessage(err)}`)
		TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
	})

	// Metrics collector
	let cangjieMetricsCollector: CangjieMetricsCollector | undefined
	const metricsCwd = vscode.workspace.workspaceFolders?.find((f) =>
		fs.existsSync(path.join(f.uri.fsPath, "cjpm.toml")),
	)?.uri.fsPath
	if (metricsCwd) {
		cangjieMetricsCollector = new CangjieMetricsCollector(metricsCwd, outputChannel)
		context.subscriptions.push(cangjieMetricsCollector)
	}

	// LSP client (lazy: defers until .cj file is opened)
	cangjieLspClient = new CangjieLspClient(outputChannel)
	context.subscriptions.push({ dispose: () => cangjieLspClient?.dispose() })

	// Debugger — register before onCangjieActivated so setCompileGuard always has a target
	cangjieDebugFactory = new CangjieDebugAdapterFactory(undefined, outputChannel)
	context.subscriptions.push(cangjieDebugFactory)
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("cangjie", cangjieDebugFactory))
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("cangjie", new CangjieDebugConfigurationProvider()),
	)

	// Status bar (must exist before onCangjieActivated)
	cangjieLspStatusBar = new CangjieLspStatusBar(cangjieLspClient, cangjieLspClient.lspOutputChannel, outputChannel)
	context.subscriptions.push(cangjieLspStatusBar)

	// Defer formatter and linter until a .cj file is actually opened
	cangjieLspClient.onCangjieActivated(() => {
		if (!cjfmtFormatter) {
			cjfmtFormatter = new CjfmtFormatter(outputChannel)
			context.subscriptions.push(cjfmtFormatter)
		}
		if (!cjlintDiagnostics) {
			cjlintDiagnostics = new CjlintDiagnostics(outputChannel, cangjieLintConfig)
			context.subscriptions.push(cjlintDiagnostics)
			cangjieDiagnosticModeSwitch.clearCjlint = () => cjlintDiagnostics?.clearAll()
		}
		if (!cangjieCompileGuard) {
			const cjpmDiag = vscode.languages.createDiagnosticCollection("cangjie-cjpm")
			context.subscriptions.push(cjpmDiag)
			cangjieDiagnosticModeSwitch.clearCjpm = () => cjpmDiag.clear()
			cangjieCompileGuard = new CangjieCompileGuard(
				outputChannel,
				cangjieMetricsCollector,
				cjpmDiag,
				({ docUri }) => {
					const cfg = vscode.workspace.getConfiguration(Package.name)
					if (cfg.get<boolean>("cangjieTools.runLintAfterBuild", true) !== true) return
					const uri =
						docUri ??
						(vscode.window.activeTextEditor?.document.languageId === "cangjie"
							? vscode.window.activeTextEditor.document.uri
							: undefined)
					if (uri?.fsPath.endsWith(".cj")) void cjlintDiagnostics?.lintSingleFile(uri)
				},
				({ cwd }) => {
					cangjieLspClient?.markCjpmBuildSuccess(cwd)
					cangjieLspClient?.clearPublishedDiagnostics({ cwd })
				},
			)
			cangjieCompileGuard.registerSaveHook()
			context.subscriptions.push(cangjieCompileGuard)
			cangjieLspStatusBar?.attachCompileGuard(cangjieCompileGuard)
			cangjieDebugFactory?.setCompileGuard(cangjieCompileGuard)
		}
	})

	// SDK setup prompt
	void checkAndPromptSdkSetup(context, outputChannel).catch((err: unknown) => {
		logger.warn("Extension", "checkAndPromptSdkSetup failed", err)
		TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
	})
	void scheduleCangjieToolchainGapCheck(outputChannel)

	// Start LSP client
	void cangjieLspClient.start().catch((error) => {
		outputChannel.appendLine(`[CangjieLSP] Error during startup: ${getErrorMessage(error)}`)
		TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
	})

	// cjpm tasks (always registered; user may run tasks before opening .cj files)
	cjpmTaskProvider = new CjpmTaskProvider(outputChannel)
	context.subscriptions.push(cjpmTaskProvider)

	// Register Cangjie language providers
	registerCangjieProviders(context)

	// Test run/debug commands
	registerCangjieTestCommands(context)

	// Symbol index + cross-file providers (need workspace folder)
	if (vscode.workspace.workspaceFolders?.length) {
		registerCangjieCrossFileProviders(context, outputChannel)
	}

	registerMacroCommands(context, outputChannel)

	return {
		compileGuardAccessor: () => cangjieCompileGuard,
	}
}

function registerCangjieProviders(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieCodeActionProvider(),
			{ providedCodeActionKinds: CangjieCodeActionProvider.providedCodeActionKinds },
		),
	)
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieDocumentSymbolProvider(),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerFoldingRangeProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieFoldingRangeProvider(),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerHoverProvider({ language: "cangjie", scheme: "file" }, new CangjieHoverProvider()),
	)
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieTestCodeLensProvider(),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieSemanticTokensProvider(),
			CangjieSemanticTokensProvider.legend,
		),
	)
	context.subscriptions.push(
		vscode.languages.registerInlayHintsProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieInlayHintsProvider(),
		),
	)
}

function registerCangjieTestCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieRunTest", (testName: string, fileUri?: vscode.Uri) => {
			const folder = fileUri
				? vscode.workspace.getWorkspaceFolder(fileUri)
				: vscode.workspace.workspaceFolders?.[0]
			const cwd = folder?.uri.fsPath
			const terminal = vscode.window.createTerminal({ name: "Cangjie Test", cwd })
			terminal.show()
			terminal.sendText(`cjpm test --filter "${testName}"`)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieDebugTest", (testName: string, fileUri?: vscode.Uri) => {
			const folder = fileUri ? vscode.workspace.getWorkspaceFolder(fileUri) : undefined
			vscode.debug.startDebugging(folder, {
				type: "cangjie",
				request: "launch",
				name: `调试测试: ${testName}`,
				program: "${workspaceFolder}/target/output",
				args: ["--test", "--filter", testName],
				cwd: "${workspaceFolder}",
				preLaunchTask: "cjpm: build",
			})
		}),
	)
}

function registerCangjieCrossFileProviders(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): void {
	cangjieSymbolIndex = new CangjieSymbolIndex(outputChannel)
	context.subscriptions.push(cangjieSymbolIndex)
	setTimeout(() => {
		void cangjieSymbolIndex?.initialize().catch((err) => {
			outputChannel.appendLine(`[SymbolIndex] Background initialization error: ${getErrorMessage(err)}`)
			TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
		})
	}, 1000)

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieDefinitionProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerReferenceProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieReferenceProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerRenameProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieEnhancedRenameProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieMacroCodeLensProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieMacroHoverProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerCallHierarchyProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieCallHierarchyProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerTypeHierarchyProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieTypeHierarchyProvider(cangjieSymbolIndex!),
		),
	)
	context.subscriptions.push(
		vscode.languages.registerWorkspaceSymbolProvider(
			new CangjieWorkspaceSymbolProvider(cangjieSymbolIndex!),
		),
	)
}

/**
 * Wire up Cangjie commands that depend on ClineProvider and CangjieSymbolIndex.
 * Must be called after both ClineProvider and Cangjie language are initialized.
 */
export function wireCangjieCommands(
	context: vscode.ExtensionContext,
	getCurrentTaskId: () => string | undefined,
): void {
	if (cangjieLspClient && cangjieSymbolIndex) {
		registerCangjieCommands(context, cangjieLspClient, cangjieSymbolIndex, getCurrentTaskId)
	}
}

/**
 * Dispose all Cangjie language resources.
 */
export async function disposeCangjieLanguage(): Promise<void> {
	cangjieLspStatusBar?.dispose()
	cangjieLspStatusBar = undefined

	if (cangjieLspClient) {
		await cangjieLspClient.stop()
		await cangjieLspClient.dispose()
		cangjieLspClient = undefined
	}

	cjfmtFormatter?.dispose()
	cjfmtFormatter = undefined
	cjlintDiagnostics?.dispose()
	cjlintDiagnostics = undefined
	cjpmTaskProvider?.dispose()
	cjpmTaskProvider = undefined
	cangjieSymbolIndex?.dispose()
	cangjieSymbolIndex = undefined
	cangjieCompileGuard?.dispose()
	cangjieCompileGuard = undefined
}
