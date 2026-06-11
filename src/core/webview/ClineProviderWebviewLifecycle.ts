/**
 * ClineProviderWebviewLifecycle — Webview lifecycle management.
 *
 * Extracted from ClineProvider.ts to decompose the monolithic provider.
 * Manages webview creation, configuration, and lifecycle events.
 */

import * as vscode from "vscode"

import type { ExtensionMessage } from "@njust-ai/types"

import { setPanel } from "../../activate/registerCommands"
import { Terminal } from "../../integrations/terminal/Terminal"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getTheme } from "../../integrations/theme/getTheme"
import type { WebviewContentProvider } from "./WebviewContentProvider"
import type { ContextProxy } from "../config/ContextProxy"
import type { Task } from "../task/Task"

export interface ClineProviderWebviewLifecycleHost {
	readonly contextProxy: ContextProxy
	readonly webviewContentProvider: WebviewContentProvider
	readonly webviewDisposables: vscode.Disposable[]
	readonly disposables: vscode.Disposable[]
	readonly view: vscode.WebviewView | vscode.WebviewPanel | undefined

	setView(view: vscode.WebviewView | vscode.WebviewPanel): void

	getState(): Promise<{
		terminalShellIntegrationTimeout?: number
		terminalShellIntegrationDisabled?: boolean
		terminalCommandDelay?: number
		terminalZshClearEolMark?: boolean
		terminalZshOhMy?: boolean
		terminalZshP10k?: boolean
		terminalPowershellCounter?: boolean
		terminalZdotdir?: boolean
		ttsEnabled?: boolean
		ttsSpeed?: number
	}>

	postMessageToWebview(message: ExtensionMessage): Promise<void>
	updateCodeIndexStatusSubscription(): void
	log(message: string): void
	dispose(): Promise<void>
	clearCodeIndexManager(): void
}

export class ClineProviderWebviewLifecycle {
	constructor(private readonly host: ClineProviderWebviewLifecycleHost) {}

	public clearWebviewResources(): void {
		while (this.host.webviewDisposables.length) {
			const x = this.host.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	public async resolveWebviewView(
		webviewView: vscode.WebviewView | vscode.WebviewPanel,
		messageRouter: {
			setWebviewMessageListener: (webview: vscode.Webview) => void
			getDisposables: () => readonly vscode.Disposable[]
		},
		stack: { pop: () => Promise<void> },
		getCurrentTask: () => Task | undefined,
	): Promise<void> {
		this.host.setView(webviewView)
		const inTabMode = this.configureWebviewPanelMode(webviewView)

		await this.initializeWebviewRuntimeState()
		await this.configureWebviewContent(webviewView)
		messageRouter.setWebviewMessageListener(webviewView.webview)
		this.host.webviewDisposables.push(...messageRouter.getDisposables())
		this.host.updateCodeIndexStatusSubscription()
		this.attachWebviewLifecycleListeners(webviewView, inTabMode)

		const currentTask = getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await stack.pop()
		}
	}

	private configureWebviewPanelMode(webviewView: vscode.WebviewView | vscode.WebviewPanel): boolean {
		const inTabMode = "onDidChangeViewState" in webviewView
		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}
		return inTabMode
	}

	private async initializeWebviewRuntimeState(): Promise<void> {
		const {
			terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled = false,
			terminalCommandDelay = 0,
			terminalZshClearEolMark = true,
			terminalZshOhMy = false,
			terminalZshP10k = false,
			terminalPowershellCounter = false,
			terminalZdotdir = false,
			ttsEnabled,
			ttsSpeed,
		} = await this.host.getState()

		Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
		Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
		Terminal.setCommandDelay(terminalCommandDelay)
		Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
		Terminal.setTerminalZshOhMy(terminalZshOhMy)
		Terminal.setTerminalZshP10k(terminalZshP10k)
		Terminal.setPowershellCounter(terminalPowershellCounter)
		Terminal.setTerminalZdotdir(terminalZdotdir)
		setTtsEnabled(ttsEnabled ?? false)
		setTtsSpeed(ttsSpeed ?? 1)

		await this.host.contextProxy.setValue("enableWebSearch", false)
	}

	private async configureWebviewContent(webviewView: vscode.WebviewView | vscode.WebviewPanel): Promise<void> {
		const resourceRoots = [this.host.contextProxy.extensionUri]
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = { enableScripts: true, localResourceRoots: resourceRoots }
		webviewView.webview.html =
			this.host.contextProxy.extensionMode === vscode.ExtensionMode.Development
				? await this.host.webviewContentProvider.getHMRHtmlContent(webviewView.webview)
				: await this.host.webviewContentProvider.getHtmlContent(webviewView.webview)
	}

	private attachWebviewLifecycleListeners(
		webviewView: vscode.WebviewView | vscode.WebviewPanel,
		inTabMode: boolean,
	): void {
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			this.host.updateCodeIndexStatusSubscription()
		})
		this.host.webviewDisposables.push(activeEditorSubscription)

		if ("onDidChangeViewState" in webviewView) {
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.host.view?.visible) {
					void this.host.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})
			this.host.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.host.view?.visible) {
					void this.host.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})
			this.host.webviewDisposables.push(visibilityDisposable)
		}

		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.host.log("Disposing ClineProvider instance for tab view")
					await this.host.dispose()
				} else {
					this.host.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					this.host.clearCodeIndexManager()
				}
			},
			null,
			this.host.disposables,
		)

		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e?.affectsConfiguration("workbench.colorTheme")) {
				await this.host.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.host.webviewDisposables.push(configDisposable)
	}
}
