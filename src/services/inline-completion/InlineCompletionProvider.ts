import * as vscode from "vscode"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { Package } from "../../shared/package"

import { CangjieCompletionEngine } from "./CangjieCompletionEngine"
import { CompletionCache } from "./CompletionCache"
import { GenericCompletionEngine } from "./GenericCompletionEngine"
import { resolveInlineCompletionApiHandler } from "./inlineCompletionApi"
import { getErrorMessage } from "../../shared/error-utils"

function delayWithCancellation(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		if (token.isCancellationRequested) {
			reject(new vscode.CancellationError())
			return
		}
		const handle = setTimeout(() => {
			dispose.dispose()
			resolve()
		}, ms)
		const dispose = token.onCancellationRequested(() => {
			clearTimeout(handle)
			reject(new vscode.CancellationError())
		})
	})
}

/** @internal exported for tests */
export async function debounceInlineDelay(
	ms: number,
	token: vscode.CancellationToken,
	triggerKind: vscode.InlineCompletionTriggerKind,
): Promise<void> {
	if (triggerKind !== vscode.InlineCompletionTriggerKind.Automatic || ms <= 0) {
		return
	}
	try {
		await delayWithCancellation(ms, token)
	} catch {
		// vscode.CancellationError — caller checks token
	}
}

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private static firstInvokeLogged = false

	private readonly cache = new CompletionCache({ maxEntries: 20, ttlMs: 5 * 60_000 })
	private readonly cangjieEngine: CangjieCompletionEngine
	private readonly genericEngine: GenericCompletionEngine

	constructor(
		extensionContext: vscode.ExtensionContext,
		private readonly clineProvider: ClineProvider,
		private readonly outputChannel?: vscode.OutputChannel,
	) {
		const log = (msg: string) => this.outputChannel?.appendLine(msg)
		const getApi = () => resolveInlineCompletionApiHandler(clineProvider, log)
		const getTaskMeta = () => {
			const task = clineProvider.getCurrentTask()
			return { taskId: task?.taskId, mode: undefined as string | undefined }
		}
		this.cangjieEngine = new CangjieCompletionEngine(getApi, getTaskMeta, extensionContext.extensionPath)
		this.genericEngine = new GenericCompletionEngine(getApi, getTaskMeta)
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
		const verbose =
			vscode.workspace.getConfiguration(Package.name).get<boolean>("inlineCompletion.verboseLog") === true ||
			vscode.workspace.getConfiguration(Package.name).get<boolean>("debug") === true
		if (!InlineCompletionProvider.firstInvokeLogged) {
			InlineCompletionProvider.firstInvokeLogged = true
			this.outputChannel?.appendLine(
				`[InlineCompletion] Provider active — file=${document.uri.fsPath} lang=${document.languageId} (if you never see this line, inline providers are not being invoked for this editor)`,
			)
		}
		if (verbose) {
			this.outputChannel?.appendLine(
				`[InlineCompletion] invoke trigger=${context.triggerKind} line=${position.line} col=${position.character}`,
			)
		}

		const editorConfig = vscode.workspace.getConfiguration("editor")
		// Only skip when explicitly disabled; missing config (tests) should stay enabled.
		if (editorConfig.get<boolean>("inlineSuggest.enabled") === false) {
			return null
		}

		const config = vscode.workspace.getConfiguration(Package.name)
		if (!config.get<boolean>("inlineCompletion.enabled")) {
			return null
		}

		const delayMs = config.get<number>("inlineCompletion.triggerDelayMs") ?? 300
		const maxLines = config.get<number>("inlineCompletion.maxLines") ?? 10
		const enableCangjieEnhanced = config.get<boolean>("inlineCompletion.enableCangjieEnhanced") ?? true

		const line = document.lineAt(position.line)
		const prefixSample = line.text.slice(0, position.character)
		const prefixHash = CompletionCache.hashPrefix(prefixSample)

		const isCangjieFile = document.languageId === "cangjie" || document.fileName.toLowerCase().endsWith(".cj")
		const engine: "cangjie" | "generic" = isCangjieFile && enableCangjieEnhanced ? "cangjie" : "generic"

		const cacheKey = this.cache.makeKey({
			filePath: document.uri.fsPath,
			line: position.line,
			character: position.character,
			prefixHash,
			engine,
		})

		const cached = this.cache.get(cacheKey)
		if (cached) {
			return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))]
		}

		await debounceInlineDelay(delayMs, token, context.triggerKind)
		if (token.isCancellationRequested) {
			return null
		}

		const cachedAfterWait = this.cache.get(cacheKey)
		if (cachedAfterWait) {
			return [new vscode.InlineCompletionItem(cachedAfterWait, new vscode.Range(position, position))]
		}

		let text: string | undefined
		try {
			if (engine === "cangjie") {
				text = await this.cangjieEngine.run(document, position, { maxLines, token })
			} else {
				text = await this.genericEngine.run(document, position, { maxLines, token })
			}
		} catch (error) {
			this.outputChannel?.appendLine(
				`[InlineCompletion] Request failed: ${getErrorMessage(error)}`,
			)
			return null
		}

		if (!text || token.isCancellationRequested) {
			return null
		}

		this.cache.set(cacheKey, text)
		return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))]
	}
}
