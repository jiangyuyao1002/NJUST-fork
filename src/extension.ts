import * as vscode from "vscode"
import * as dotenvx from "@dotenvx/dotenvx"
import * as fs from "fs"
import * as path from "path"

// Load environment variables from .env file
// The extension-level .env is optional (not shipped in production builds).
// Avoid calling dotenvx when the file doesn't exist, otherwise dotenvx emits
// a noisy [MISSING_ENV_FILE] error to the extension host console.
const envPath = path.join(__dirname, "..", ".env")
if (fs.existsSync(envPath)) {
	try {
		dotenvx.config({ path: envPath })
	} catch (e) {
		// Best-effort only: never fail extension activation due to optional env loading.
		console.warn("Failed to load environment variables:", e)
	}
}

import { customToolRegistry } from "@njust-ai-cj/core"
import { TelemetryService } from "@njust-ai-cj/telemetry"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { logger } from "./shared/logger"
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ClineProvider } from "./core/webview/ClineProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { CangjieLspClient } from "./services/cangjie-lsp/CangjieLspClient"
import { CangjieLspStatusBar } from "./services/cangjie-lsp/CangjieLspStatusBar"
import { CjfmtFormatter } from "./services/cangjie-lsp/CjfmtFormatter"
import { CjlintDiagnostics } from "./services/cangjie-lsp/CjlintDiagnostics"
import { CjpmTaskProvider } from "./services/cangjie-lsp/CjpmTaskProvider"
import { registerCangjieCommands } from "./services/cangjie-lsp/cangjieCommands"
import { cleanupOrphanedTestFiles, initTestCleanup } from "./services/cangjie-lsp/cangjieGeneratedTestCleanup"
import { CangjieCodeActionProvider } from "./services/cangjie-lsp/CangjieCodeActionProvider"
import { checkAndPromptSdkSetup } from "./services/cangjie-lsp/CangjieSdkSetup"
import { probeCangjieToolchain } from "./services/cangjie-lsp/cangjieToolUtils"
import { setDeviceToken } from "./services/cloud-agent/deviceToken"
import { CangjieDocumentSymbolProvider } from "./services/cangjie-lsp/CangjieDocumentSymbolProvider"
import { CangjieFoldingRangeProvider } from "./services/cangjie-lsp/CangjieFoldingRangeProvider"
import { CangjieHoverProvider } from "./services/cangjie-lsp/CangjieHoverProvider"
import { CangjieTestCodeLensProvider } from "./services/cangjie-lsp/CangjieTestCodeLensProvider"
import { CangjieDebugAdapterFactory, CangjieDebugConfigurationProvider } from "./services/cangjie-lsp/CangjieDebugAdapterFactory"
import { CangjieSymbolIndex } from "./services/cangjie-lsp/CangjieSymbolIndex"
import { CangjieDefinitionProvider } from "./services/cangjie-lsp/CangjieDefinitionProvider"
import { CangjieReferenceProvider } from "./services/cangjie-lsp/CangjieReferenceProvider"
import { CangjieEnhancedRenameProvider } from "./services/cangjie-lsp/CangjieEnhancedRenameProvider"
import { CangjieMacroCodeLensProvider, CangjieMacroHoverProvider, registerMacroCommands } from "./services/cangjie-lsp/CangjieMacroProvider"
import { CangjieSemanticTokensProvider } from "./services/cangjie-lsp/CangjieSemanticTokensProvider"
import { CangjieInlayHintsProvider } from "./services/cangjie-lsp/CangjieInlayHintsProvider"
import { CangjieCallHierarchyProvider } from "./services/cangjie-lsp/CangjieCallHierarchyProvider"
import { CangjieTypeHierarchyProvider } from "./services/cangjie-lsp/CangjieTypeHierarchyProvider"
import { CangjieWorkspaceSymbolProvider } from "./services/cangjie-lsp/CangjieWorkspaceSymbolProvider"
import { CangjieCompileGuard } from "./services/cangjie-lsp/CangjieCompileGuard"
import { invalidateCangjieToolEnvCache } from "./services/cangjie-lsp/cangjieToolUtils"
import { bumpCangjieL3TtlConfigCache, invalidateCangjieL3ContextCache } from "./core/prompts/sections/cangjie-context"
import { registerCangjieRulesHotReload } from "./services/cangjie-lsp/cangjieRulesHotReload"
import { registerLatexCommands } from "./services/latex/latexCommands"
import { cangjieDiagnosticModeSwitch } from "./services/cangjie-lsp/cangjieDiagnosticModeSwitch"
import { CangjieLintConfig } from "./services/cangjie-lsp/CangjieLintConfig"
import { CangjieMetricsCollector } from "./services/cangjie-lsp/CangjieMetricsCollector"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./core/config/autoImportSettings"
import { startupProfiler } from "./utils/profiler"
import { API } from "./extension/api"
import { RooToolsMcpServer } from "./services/mcp-server/RooToolsMcpServer"
import { getWorkspacePath } from "./utils/path"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"
import { ChatParticipantHandler, registerLMTools, ChatStateSync } from "./chat"
import { InlineCompletionProvider } from "./services/inline-completion/InlineCompletionProvider"
import { resolveInlineCompletionApiHandler } from "./services/inline-completion/inlineCompletionApi"
import { getErrorMessage } from "./shared/error-utils"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext
let cangjieLspClient: CangjieLspClient | undefined
let cangjieLspStatusBar: CangjieLspStatusBar | undefined
let cjfmtFormatter: CjfmtFormatter | undefined
let cjlintDiagnostics: CjlintDiagnostics | undefined
let cjpmTaskProvider: CjpmTaskProvider | undefined
let cangjieSymbolIndex: CangjieSymbolIndex | undefined
let cangjieCompileGuard: CangjieCompileGuard | undefined
let cangjieDebugFactory: CangjieDebugAdapterFactory | undefined
let rooToolsMcpServer: RooToolsMcpServer | undefined

let lastCangjieToolchainGapWarn = 0

function scheduleCangjieToolchainGapCheck(): void {
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
				if (c === "验证 SDK") void vscode.commands.executeCommand("njust-ai-cj.cangjieVerifySdk")
				if (c === "打开工具设置") {
					void vscode.commands.executeCommand("workbench.action.openSettings", `${Package.name}.cangjieTools`)
				}
			})
	})().catch((err) => {
		outputChannel?.appendLine(
			`[CangjieToolchain] Gap check failed: ${getErrorMessage(err)}`,
		)
	})
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	startupProfiler.start("activate")
	extensionContext = context
	process.on("unhandledRejection", (reason, _promise) => {
		logger.error("Extension", "Unhandled promise rejection:", reason)
	})
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)
	context.subscriptions.push(outputChannel)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			// Respond to any NJUST_AI_CJ config change across all subsystems.
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
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize telemetry with file-based logging
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance({ telemetryDir: context.globalStorageUri.fsPath })
	}

	initTestCleanup(context.workspaceState)
	void cleanupOrphanedTestFiles(context.globalStorageUri.fsPath)
		.then((r) => {
			if (r.filesRemoved > 0) {
				outputChannel.appendLine(
					`[CangjieTestCleanup] 启动孤儿清理：移除 ${r.filesRemoved} 个生成测试文件（${r.taskEntriesRemoved} 个任务桶）。`,
				)
			}
		})
		.catch((e) => {
			outputChannel.appendLine(
				`[CangjieTestCleanup] 启动孤儿清理失败：${getErrorMessage(e)}`,
			)
		})

	registerCangjieRulesHotReload(context, outputChannel)

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Initialize i18n for internationalization support (follow VS Code UI language until user sets language in extension state).
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Parallelize independent initialization steps for faster startup.
	// - Network proxy configuration (before any network requests)
	// - Settings migration (independent of network proxy)
	// Each step has its own error handling so one failure doesn't block the other.
	await Promise.allSettled([
		initializeNetworkProxy(context, outputChannel).catch((err) =>
			outputChannel.appendLine(
				`[Startup] Network proxy init failed: ${getErrorMessage(err)}`,
			),
		),
		migrateSettings(context, outputChannel).catch((err) =>
			outputChannel.appendLine(
				`[Startup] Settings migration failed: ${getErrorMessage(err)}`,
			),
		),
	])

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", defaultCommands)
	}

	// Auto-generate Cloud Agent device token on first activation.
	// Stored in SecretStorage to prevent exposure to other extensions.
	const DEVICE_TOKEN_KEY = "njust-ai-cj.cloudAgent.deviceToken"
	let deviceToken = await context.secrets.get(DEVICE_TOKEN_KEY)
	if (!deviceToken) {
		// Migration: check old globalState key then old config value
		const legacyToken =
			context.globalState.get<string>("njustCloudDeviceToken") ||
			vscode.workspace.getConfiguration(Package.name).get<string>("cloudAgent.deviceToken", "")
		if (legacyToken && legacyToken.trim()) {
			deviceToken = legacyToken.trim()
		} else {
			const { randomUUID } = await import("crypto")
			deviceToken = randomUUID()
		}
		await context.secrets.store(DEVICE_TOKEN_KEY, deviceToken)
		// Clean up legacy storage
		await context.globalState.update("njustCloudDeviceToken", undefined)
		outputChannel.appendLine("[CloudAgent] Device token generated and saved to SecretStorage.")
		setDeviceToken(deviceToken)
	}

	const contextProxy = await ContextProxy.getInstance(context)

	// Initialize code index managers for all workspace folders.
	const codeIndexManagers: CodeIndexManager[] = []

	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)

			if (manager) {
				codeIndexManagers.push(manager)

				// Initialize in background; do not block extension activation
				void manager.initialize(contextProxy).catch((error) => {
					const message = getErrorMessage(error)
					outputChannel.appendLine(
						`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(manager)
			}
		}
	}

	const cangjieLintConfig = new CangjieLintConfig(outputChannel)
	context.subscriptions.push(cangjieLintConfig)
	void cangjieLintConfig.initialize().catch((err) => {
		outputChannel.appendLine(
			`[CangjieLintConfig] Initialize failed: ${getErrorMessage(err)}`,
		)
	})

	let cangjieMetricsCollector: CangjieMetricsCollector | undefined
	const metricsCwd = vscode.workspace.workspaceFolders?.find((f) =>
		fs.existsSync(path.join(f.uri.fsPath, "cjpm.toml")),
	)?.uri.fsPath
	if (metricsCwd) {
		cangjieMetricsCollector = new CangjieMetricsCollector(metricsCwd, outputChannel)
		context.subscriptions.push(cangjieMetricsCollector)
	}

	// Initialize and start the Cangjie Language Server client (lazy: defers until .cj file is opened).
	cangjieLspClient = new CangjieLspClient(outputChannel)
	context.subscriptions.push({ dispose: () => cangjieLspClient?.dispose() })

	// Cangjie debugger — register before onCangjieActivated so setCompileGuard always has a target.
	cangjieDebugFactory = new CangjieDebugAdapterFactory(undefined, outputChannel)
	context.subscriptions.push(cangjieDebugFactory)
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("cangjie", cangjieDebugFactory),
	)
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("cangjie", new CangjieDebugConfigurationProvider()),
	)

	// Status bar must exist before onCangjieActivated so compile-guard attach always has a target.
	cangjieLspStatusBar = new CangjieLspStatusBar(cangjieLspClient, cangjieLspClient.lspOutputChannel, outputChannel)
	context.subscriptions.push(cangjieLspStatusBar)

	// Defer formatter and linter until a .cj file is actually opened.
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

	void checkAndPromptSdkSetup(context, outputChannel).catch((err: unknown) => { logger.warn("Extension", "checkAndPromptSdkSetup failed", err) })
	void scheduleCangjieToolchainGapCheck()

	void cangjieLspClient.start().catch((error) => {
		const message = getErrorMessage(error)
		outputChannel.appendLine(`[CangjieLSP] Error during startup: ${message}`)
	})

	// cjpm tasks are always registered (user may run tasks before opening .cj files).
	cjpmTaskProvider = new CjpmTaskProvider(outputChannel)
	context.subscriptions.push(cjpmTaskProvider)

	// Initialize the provider.
	const provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// Auto-import configuration if specified in settings.
	try {
		await autoImportSettings(outputChannel, {
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
			customModesManager: provider.customModesManager,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${getErrorMessage(error)}`,
		)
	}

	registerCommands({ context, outputChannel, provider })

	registerLatexCommands(context, outputChannel)

	const inlineCompletionProvider = new InlineCompletionProvider(context, provider, outputChannel)
	// Use scheme + glob: a lone `pattern: "**/*"` often fails to match workspace/untitled documents reliably.
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			[
				{ scheme: "file", pattern: "**" },
				{ scheme: "untitled", pattern: "**" },
				{ scheme: "vscode-notebook-cell", pattern: "**" },
			],
			inlineCompletionProvider,
		),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai-cj.triggerInlineCompletion", async () => {
			await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai-cj.inlineCompletionDiagnostics", async () => {
			const log = (m: string) => outputChannel.appendLine(m)
			const api = await resolveInlineCompletionApiHandler(provider, log)
			if (api) {
				const { id } = api.getModel()
				void vscode.window.showInformationMessage(`内联补全 API 可用：${id}`)
			} else {
				void vscode.window.showWarningMessage(
					"内联补全：未解析到 API。请在扩展设置中配置提供商并填写密钥，或先开始侧边栏对话任务；详情见输出面板「NJUST_AI_CJ」。",
				)
			}
		}),
	)

	// Register VSCode Chat Participant (@roo) for the native chat panel.
	const chatParticipant = new ChatParticipantHandler(provider, context, outputChannel)
	context.subscriptions.push({ dispose: () => chatParticipant.dispose() })

	// Initialize Chat <-> Webview state synchronization.
	const chatStateSync = new ChatStateSync(provider, outputChannel)
	context.subscriptions.push({ dispose: () => chatStateSync.dispose() })

	// Register Roo's native tools as VSCode Language Model Tools.
	registerLMTools(context, provider, outputChannel)

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)

	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

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
		vscode.languages.registerHoverProvider(
			{ language: "cangjie", scheme: "file" },
			new CangjieHoverProvider(),
		),
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

	// Test run/debug commands for CodeLens
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai-cj.cangjieRunTest", (testName: string, fileUri?: vscode.Uri) => {
			const folder = fileUri ? vscode.workspace.getWorkspaceFolder(fileUri) : vscode.workspace.workspaceFolders?.[0]
			const cwd = folder?.uri.fsPath
			const terminal = vscode.window.createTerminal({ name: "Cangjie Test", cwd })
			terminal.show()
			terminal.sendText(`cjpm test --filter "${testName}"`)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai-cj.cangjieDebugTest", (testName: string, fileUri?: vscode.Uri) => {
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

	// Cangjie symbol index + cross-file providers (need a workspace folder; single-file mode has no stable index root)
	if (vscode.workspace.workspaceFolders?.length) {
		cangjieSymbolIndex = new CangjieSymbolIndex(outputChannel)
		context.subscriptions.push(cangjieSymbolIndex)
		setTimeout(() => {
			void cangjieSymbolIndex?.initialize().catch((err) => {
				outputChannel.appendLine(
					`[SymbolIndex] Background initialization error: ${getErrorMessage(err)}`,
				)
			})
		}, 1000)

		context.subscriptions.push(
			vscode.languages.registerDefinitionProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieDefinitionProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerReferenceProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieReferenceProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerRenameProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieEnhancedRenameProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieMacroCodeLensProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerHoverProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieMacroHoverProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerCallHierarchyProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieCallHierarchyProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerTypeHierarchyProvider(
				{ language: "cangjie", scheme: "file" },
				new CangjieTypeHierarchyProvider(cangjieSymbolIndex),
			),
		)

		context.subscriptions.push(
			vscode.languages.registerWorkspaceSymbolProvider(
				new CangjieWorkspaceSymbolProvider(cangjieSymbolIndex),
			),
		)

		if (cangjieLspClient && cangjieSymbolIndex) {
			registerCangjieCommands(context, cangjieLspClient, cangjieSymbolIndex, () => provider.getCurrentTask()?.taskId)
		}
	}

	registerMacroCommands(context, outputChannel)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Start MCP Tools Server if enabled in settings.
	const mcpServerConfig = vscode.workspace.getConfiguration(Package.name)
	const mcpServerEnabled = mcpServerConfig.get<boolean>("mcpServer.enabled", false)
	if (mcpServerEnabled) {
		const port = mcpServerConfig.get<number>("mcpServer.port", 3100)
		const bindAddress = mcpServerConfig.get<string>("mcpServer.bindAddress", "127.0.0.1")

		// Read MCP authToken from SecretStorage (preferred) or migrate from settings.
		const MCP_AUTH_TOKEN_SECRET_KEY = "njust-ai-cj.mcpServer.authToken"
		let authToken = (await context.secrets.get(MCP_AUTH_TOKEN_SECRET_KEY)) || undefined
		if (!authToken) {
			// Migration: read legacy token from settings and store in SecretStorage.
			const legacyToken = mcpServerConfig.get<string>("mcpServer.authToken", "")
			if (legacyToken && legacyToken.trim()) {
				authToken = legacyToken.trim()
				context.secrets.store(MCP_AUTH_TOKEN_SECRET_KEY, authToken).then(
					() => {},
					(err: unknown) => {
						outputChannel.appendLine(
							`[McpToolsServer] Failed to persist auth token to secret storage: ${getErrorMessage(err)}. ` +
							`MCP server authentication will not survive VS Code restart until this is resolved.`,
						)
					},
				)
			}
		}

		const startMcpServer = (wsPath: string) => {
			rooToolsMcpServer = new RooToolsMcpServer({
				workspacePath: wsPath,
				port,
				bindAddress,
				authToken,
				allowedCommands: defaultCommands,
				deniedCommands: mcpServerConfig.get<string[]>("deniedCommands", []),
			})

			rooToolsMcpServer
				.start()
				.then(() => {
					outputChannel.appendLine(`[McpToolsServer] Started on http://${bindAddress}:${port}/mcp (workspace: ${wsPath})`)
					if (bindAddress === "0.0.0.0") {
						outputChannel.appendLine(
							`[McpToolsServer] WARNING: Server is accessible from remote machines. Ensure authToken is set and firewall rules are configured.`,
						)
					}
				})
				.catch((error) => {
					outputChannel.appendLine(
						`[McpToolsServer] Failed to start: ${getErrorMessage(error)}`,
					)
				})

			context.subscriptions.push({
				dispose: () => {
					void rooToolsMcpServer?.stop()
				},
			})
		}

		const workspacePath = getWorkspacePath()

		if (workspacePath) {
			startMcpServer(workspacePath)
		}

		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				const newPath = getWorkspacePath()
				if (!newPath) {
					return
				}
				if (rooToolsMcpServer) {
					rooToolsMcpServer.updateWorkspacePath(newPath)
					outputChannel.appendLine(`[McpToolsServer] Workspace path updated to: ${newPath}`)
				} else {
					startMcpServer(newPath)
				}
			}),
		)
	}

	// Allows other extensions to activate once Roo is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `NJUST_AI_CJAPI` interface.
	const socketPath = process.env.NJUST_AI_CJ_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
		]

		logger.info("Extension",
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			logger.info("Extension", `♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				logger.info("Extension", `♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)

			context.subscriptions.push(watcher)
		})

		// Clean up the timeout on deactivation
		context.subscriptions.push({
			dispose: () => {
				if (reloadTimeout) {
					clearTimeout(reloadTimeout)
				}
			},
		})
	}

	startupProfiler.end("activate")
	const profile = startupProfiler.summary()
	if (profile.length) {
		outputChannel.appendLine(`[StartupProfiler] ${JSON.stringify(profile)}`)
	}

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

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

	if (rooToolsMcpServer) {
		await rooToolsMcpServer.stop()
		rooToolsMcpServer = undefined
	}

	await McpServerManager.cleanup(extensionContext)
	TerminalRegistry.cleanup()

	// Flush telemetry before exit
	if (TelemetryService.hasInstance()) {
		TelemetryService.instance.shutdown()
	}
}
