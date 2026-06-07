import * as vscode from "vscode"
import * as dotenvx from "@dotenvx/dotenvx"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { customToolRegistry } from "@njust-ai/core"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { logger } from "./shared/logger"
import { t } from "./i18n"
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ClineProvider } from "./core/webview/ClineProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/diffViewConstants"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { AuditLogger } from "./services/AuditLogger"
import { AuditSink } from "./services/AuditSink"
import { cleanupOrphanedTestFiles, initTestCleanup } from "./services/cangjie-lsp/cangjieGeneratedTestCleanup"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./core/config/autoImportSettings"
import { startupProfiler } from "./utils/profiler"
import { API } from "./extension/api"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"
import { ChatParticipantHandler, registerLMTools } from "./chat"
import { InlineCompletionProvider } from "./services/inline-completion/InlineCompletionProvider"
import { resolveInlineCompletionApiHandler } from "./services/inline-completion/inlineCompletionApi"
import { getErrorMessage } from "./shared/error-utils"

import { initializeCloudAgent } from "./activate/cloudAgentInit"
import { initializeCangjieLanguage, wireCangjieCommands, disposeCangjieLanguage } from "./activate/cangjieLanguage"
import { setupMcpToolsServer } from "./activate/mcpToolsServer"
import { setupDevModeWatcher } from "./activate/devModeWatcher"
import { registerLatexCommands } from "./services/latex/latexCommands"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext
let auditLogger: AuditLogger | undefined
let auditSink: AuditSink | undefined

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
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
			logger.warn("Extension", "Failed to load environment variables:", e)
			TelemetryService.reportError(e, TelemetryEventName.EXTENSION_INIT_ERROR)
		}
	}

	startupProfiler.start("activate")
	extensionContext = context
	process.on("unhandledRejection", (reason, _promise) => {
		logger.error("Extension", "Unhandled promise rejection:", reason)
		TelemetryService.reportError(
			reason instanceof Error ? reason : new Error(String(reason)),
			TelemetryEventName.UTILITY_ERROR,
		)
	})
	process.on("uncaughtException", (error) => {
		logger.error("Extension", "Uncaught exception:", error)
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
		// Re-throw to preserve Node.js default fatal behavior.
		// VSCode extension host will log and deactivate the extension.
		// Wrap in setTimeout to allow telemetry to flush before the fatal crash.
		setTimeout(() => {
			throw error
		}, 100)
	})
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize telemetry with file-based logging
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance({ telemetryDir: context.globalStorageUri.fsPath })
	}

	// Apply persisted telemetry preference (opt-out stops collection immediately)
	const telemetrySetting = context.globalState.get<string>("telemetrySetting") ?? "unset"
	if (telemetrySetting === "disabled") {
		TelemetryService.instance.updateTelemetryState(false)
	}

	// Initialize audit log system (NDJSON in globalStorage/audit/)
	auditLogger = new AuditLogger(context.globalStorageUri.fsPath)
	auditSink = new AuditSink(auditLogger)

	initTestCleanup(context.workspaceState)
	void cleanupOrphanedTestFiles(context.globalStorageUri.fsPath)
		.then((r) => {
			if (r.filesRemoved > 0) {
				outputChannel.appendLine(
					t("info.cangjie_test_cleanup_orphan", {
						filesRemoved: r.filesRemoved,
						taskEntriesRemoved: r.taskEntriesRemoved,
					}),
				)
			}
		})
		.catch((e) => {
			outputChannel.appendLine(t("errors.cangjie_test_cleanup_failed", { error: getErrorMessage(e) }))
			TelemetryService.reportError(e, TelemetryEventName.EXTENSION_INIT_ERROR)
		})

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Initialize i18n for internationalization support (follow VS Code UI language until user sets language in extension state).
	await initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Parallelize independent initialization steps for faster startup.
	// - Network proxy configuration (before any network requests)
	// - Settings migration (independent of network proxy)
	// Each step has its own error handling so one failure doesn't block the other.
	await Promise.allSettled([
		initializeNetworkProxy(context, outputChannel).catch((err) => {
			outputChannel.appendLine(`[Startup] Network proxy init failed: ${getErrorMessage(err)}`)
			TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
		}),
		migrateSettings(context, outputChannel).catch((err) => {
			outputChannel.appendLine(`[Startup] Settings migration failed: ${getErrorMessage(err)}`)
			TelemetryService.reportError(err, TelemetryEventName.EXTENSION_INIT_ERROR)
		}),
	])

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		await context.globalState.update("allowedCommands", defaultCommands)
	}

	// Initialize Cloud Agent (device token + profile storage)
	await initializeCloudAgent(context, outputChannel)

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
					TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
				})

				context.subscriptions.push(manager)
			}
		}
	}

	// Initialize Cangjie language support (LSP, debugger, providers, etc.)
	const cangjieInit = initializeCangjieLanguage(context, outputChannel)

	// Initialize the provider.
	const provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy)

	// Inject local compile capability for CloudAgentOrchestrator.
	provider.compileLocal = async (cwd) => {
		const compileGuard = cangjieInit.compileGuardAccessor()
		if (!compileGuard) {
			throw new Error(t("common:errors.cangjieCompileGuard.notInitialized"))
		}
		const result = await compileGuard.compile(cwd)
		return { success: result.success, output: result.output }
	}

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
		outputChannel.appendLine(`[AutoImport] Error during auto-import: ${getErrorMessage(error)}`)
		TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
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
		vscode.commands.registerCommand("njust-ai.triggerInlineCompletion", async () => {
			await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.inlineCompletionDiagnostics", async () => {
			const log = (m: string) => outputChannel.appendLine(m)
			const api = await resolveInlineCompletionApiHandler(provider, log)
			if (api) {
				const { id } = api.getModel()
				void vscode.window.showInformationMessage(t("info.inline_completion_api_available", { id }))
			} else {
				void vscode.window.showWarningMessage(t("warnings.inline_completion_no_api"))
			}
		}),
	)

	// Register VSCode Chat Participant (@njust-ai) for the native chat panel.
	const chatParticipant = new ChatParticipantHandler(provider, context, outputChannel)
	context.subscriptions.push({ dispose: () => chatParticipant.dispose() })

	// Register Njust-AI's native tools as VSCode Language Model Tools.
	registerLMTools(context, provider, outputChannel)

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
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

	// Wire Cangjie commands that depend on ClineProvider
	wireCangjieCommands(context, () => provider.getCurrentTask()?.taskId)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Start MCP Tools Server if enabled in settings.
	await setupMcpToolsServer({ context, outputChannel, defaultCommands })

	// Allows other extensions to activate once Njust-AI is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `NJUST_AIAPI` interface.
	const rawSocketPath = process.env.NJUST_AI_IPC_SOCKET_PATH
	let socketPath: string | undefined
	if (typeof rawSocketPath === "string" && rawSocketPath.length > 0) {
		const tmpDir = os.tmpdir()
		const resolved = path.resolve(rawSocketPath)
		const resolvedTmp = path.resolve(tmpDir)
		if (!rawSocketPath.includes("\0") && resolved.toLowerCase().startsWith(resolvedTmp.toLowerCase())) {
			socketPath = rawSocketPath
		} else {
			outputChannel.appendLine(
				`[Security] NJUST_AI_IPC_SOCKET_PATH rejected: must resolve within os.tmpdir() (${tmpDir})`,
			)
		}
	}
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host (dev mode only).
	setupDevModeWatcher(context)

	startupProfiler.end("activate")
	const profile = startupProfiler.summary()
	if (profile.length) {
		outputChannel.appendLine(`[StartupProfiler] ${JSON.stringify(profile)}`)
	}

	// Report activation performance to telemetry (Task 2.1)
	if (TelemetryService.hasInstance()) {
		const activateEntry = profile.find((e) => e.name === "activate")
		const activationMs = activateEntry?.durationMs ?? 0
		TelemetryService.instance.captureEvent(TelemetryEventName.EXTENSION_ACTIVATED, {
			activationMs,
			coldStart: !context.globalState.get<boolean>("hasActivatedBefore"),
		})
		void context.globalState.update("hasActivatedBefore", true)
	}

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	// Dispose Cangjie language resources
	await disposeCangjieLanguage()

	await McpServerManager.cleanup(extensionContext)
	TerminalRegistry.cleanup()

	// Flush audit log before exit
	if (auditSink) {
		auditSink.dispose()
		auditSink = undefined
	}
	if (auditLogger) {
		await auditLogger.dispose()
		auditLogger = undefined
	}

	// Flush telemetry before exit
	if (TelemetryService.hasInstance()) {
		TelemetryService.instance.shutdown()
	}
}
