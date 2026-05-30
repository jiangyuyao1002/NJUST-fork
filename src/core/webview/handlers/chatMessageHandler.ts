import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import type { WebviewMessage, ProviderSettings } from "@njust-ai/types"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../../utils/export"
import { openFile } from "../../../integrations/misc/open-file"
import { openImage, saveImage } from "../../../integrations/misc/image-handler"
import { selectImages } from "../../../integrations/misc/process-images"
import { selectContextFiles } from "../../../integrations/misc/select-context-files"
import { searchWorkspaceFiles } from "../../../services/search/file-search"
import { playTts, setTtsEnabled, setTtsSpeed, stopTts } from "../../../utils/tts"
import { searchCommits } from "../../../utils/git"
import { openMention } from "../../mentions"
import { RooIgnoreController } from "../../ignore/RooIgnoreController"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { generateSystemPrompt } from "../generateSystemPrompt"
import {
	getWhisperCredentialsFromProviderSettings,
	transcribeWithOpenAiWhisper,
} from "../../../utils/openai-audio-transcription"
import { MessageEnhancer } from "../messageEnhancer"
import { generateErrorDiagnostics } from "../diagnosticsHandler"
import { t } from "../../../i18n"

import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"
import { resolveIncomingImages } from "./shared-utils"
import { getErrorMessage } from "../../../shared/error-utils"

export function registerChatHandlers(router: MessageRouter): void {
	router.register("customInstructions", handleCustomInstructions)
	router.register("askResponse", handleAskResponse)
	router.register("terminalOperation", handleTerminalOperation)
	router.register("selectImages", handleSelectImages)
	router.register("selectContextFiles", handleSelectContextFiles)
	router.register("openImage", handleOpenImage)
	router.register("saveImage", handleSaveImage)
	router.register("openFile", handleOpenFile)
	router.register("readFileContent", handleReadFileContent)
	router.register("openMention", handleOpenMention)
	router.register("openExternal", handleOpenExternal)
	router.register("ttsEnabled", handleTtsEnabled)
	router.register("ttsSpeed", handleTtsSpeed)
	router.register("playTts", handlePlayTts)
	router.register("stopTts", handleStopTts)
	router.register("enhancePrompt", handleEnhancePrompt)
	router.register("transcribeAudio", handleTranscribeAudio)
	router.register("getSystemPrompt", handleGetSystemPrompt)
	router.register("copySystemPrompt", handleCopySystemPrompt)
	router.register("searchCommits", handleSearchCommits)
	router.register("searchFiles", handleSearchFiles)
	router.register("insertTextIntoTextarea", handleInsertTextIntoTextarea)
	router.register("showMdmAuthRequiredNotification", handleShowMdmAuthRequiredNotification)
	router.register("dismissUpsell", handleDismissUpsell)
	router.register("getDismissedUpsells", handleGetDismissedUpsells)
	router.register("openMarkdownPreview", handleOpenMarkdownPreview)
	router.register("downloadErrorDiagnostics", handleDownloadErrorDiagnostics)
}

async function handleCustomInstructions(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await context.provider.updateCustomInstructions(message.text)
}

async function handleAskResponse(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const resolved = await resolveIncomingImages(context, { text: message.text, images: message.images })
	context.provider
		.getCurrentTask()
		?.handleWebviewAskResponse(message.askResponse!, resolved.text, resolved.images)
}

function handleTerminalOperation(context: MessageHandlerContext, message: WebviewMessage): void {
	if (message.terminalOperation) {
		void context.provider.getCurrentTask()?.handleTerminalOperation(message.terminalOperation)
	}
}

async function handleSelectImages(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const images = await selectImages()
	await context.provider.postMessageToWebview({
		type: "selectedImages",
		images,
		context: message.context,
		messageTs: message.messageTs,
	})
}

async function handleSelectContextFiles(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { mentionPaths, imageDataUrls } = await selectContextFiles()
	await context.provider.postMessageToWebview({
		type: "selectedContextFiles",
		contextFilePaths: mentionPaths,
		images: imageDataUrls.length > 0 ? imageDataUrls : undefined,
		context: message.context,
		messageTs: message.messageTs,
	})
}

function handleOpenImage(context: MessageHandlerContext, message: WebviewMessage): void {
	void openImage(message.text!, { values: message.values })
}

async function handleSaveImage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.dataUri) {
		const matches = message.dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
		if (!matches) {
			void saveImage(message.dataUri, vscode.Uri.file(""))
			return
		}
		const format = matches[1]
		const defaultFileName = `img_${Date.now()}.${format}`

		const defaultUri = await resolveDefaultSaveUri(
			context.provider.contextProxy,
			"lastImageSavePath",
			defaultFileName,
			{
				useWorkspace: false,
				fallbackDir: path.join(os.homedir(), "Downloads"),
			},
		)

		const savedUri = await saveImage(message.dataUri, defaultUri)

		if (savedUri) {
			await saveLastExportPath(context.provider.contextProxy, "lastImageSavePath", savedUri)
		}
	}
}

function handleOpenFile(context: MessageHandlerContext, message: WebviewMessage): void {
	if (!message.text) return
	let filePath: string = message.text
	if (!path.isAbsolute(filePath)) {
		filePath = path.join(context.getCurrentCwd(), filePath)
	}
	if (isPathOutsideWorkspace(filePath)) {
		const errorMessage = `Access denied: Path is outside the workspace: ${filePath}`
		vscode.window.showErrorMessage(errorMessage)
		return
	}
	void openFile(filePath, message.values as { create?: boolean; content?: string; line?: number })
}

async function handleReadFileContent(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	const relPath = message.text || ""
	if (!relPath) {
		void provider.postMessageToWebview({
			type: "fileContent",
			fileContent: { path: relPath, content: null, error: "No path provided" },
		})
		return
	}
	try {
		const cwd = getCurrentCwd()
		if (!cwd) {
			void provider.postMessageToWebview({
				type: "fileContent",
				fileContent: { path: relPath, content: null, error: "No workspace path available" },
			})
			return
		}
		const absPath = path.resolve(cwd, relPath)
		if (isPathOutsideWorkspace(absPath)) {
			void provider.postMessageToWebview({
				type: "fileContent",
				fileContent: { path: relPath, content: null, error: "Path is outside workspace" },
			})
			return
		}
		const content = await fs.readFile(absPath, "utf-8")
		void provider.postMessageToWebview({ type: "fileContent", fileContent: { path: relPath, content } })
	} catch (err) {
		const errorMsg = getErrorMessage(err)
		void provider.postMessageToWebview({
			type: "fileContent",
			fileContent: { path: relPath, content: null, error: errorMsg },
		})
	}
}

function handleOpenMention(context: MessageHandlerContext, message: WebviewMessage): void {
	void openMention(context.getCurrentCwd(), message.text)
}

function handleOpenExternal(_context: MessageHandlerContext, message: WebviewMessage): void {
	if (message.url) {
		const parsed = vscode.Uri.parse(message.url)
		if (parsed.scheme !== "http" && parsed.scheme !== "https") {
			vscode.window.showErrorMessage(`Only HTTP/HTTPS URLs are allowed. Got: ${parsed.scheme}`)
			return
		}
		vscode.env.openExternal(parsed)
	}
}

async function handleTtsEnabled(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	const ttsEnabled = message.bool ?? true
	await updateGlobalState("ttsEnabled", ttsEnabled)
	setTtsEnabled(ttsEnabled)
	await provider.postStateToWebview()
}

async function handleTtsSpeed(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	const ttsSpeed = message.value ?? 1.0
	await updateGlobalState("ttsSpeed", ttsSpeed)
	setTtsSpeed(ttsSpeed)
	await provider.postStateToWebview()
}

function handlePlayTts(context: MessageHandlerContext, message: WebviewMessage): void {
	if (message.text) {
		void playTts(message.text, {
			onStart: () => context.provider.postMessageToWebview({ type: "ttsStart", text: message.text }),
			onStop: () => context.provider.postMessageToWebview({ type: "ttsStop", text: message.text }),
		})
	}
}

function handleStopTts(_context: MessageHandlerContext, _message: WebviewMessage): void {
	stopTts()
}

async function handleEnhancePrompt(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.text) {
		try {
			const state = await provider.getState()
			const {
				apiConfiguration,
				customSupportPrompts,
				listApiConfigMeta = [],
				enhancementApiConfigId,
				includeTaskHistoryInEnhance,
			} = state

			const currentCline = provider.getCurrentTask()

			const result = await MessageEnhancer.enhanceMessage({
				text: message.text,
				apiConfiguration,
				customSupportPrompts,
				listApiConfigMeta,
				enhancementApiConfigId,
				includeTaskHistoryInEnhance,
				currentClineMessages: currentCline?.clineMessages,
				providerSettingsManager: provider.providerSettingsManager,
			})

			if (result.success && result.enhancedText) {
				MessageEnhancer.captureTelemetry(currentCline?.taskId, includeTaskHistoryInEnhance)
				await provider.postMessageToWebview({ type: "enhancedPrompt", text: result.enhancedText })
			} else {
				throw new Error(result.error || "Unknown error")
			}
		} catch (error) {
			provider.log(`Error enhancing prompt: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.enhance_prompt"))
			await provider.postMessageToWebview({ type: "enhancedPrompt" })
		}
	}
}

async function handleTranscribeAudio(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const requestId = message.transcriptionRequestId
	const postError = async (values: Record<string, unknown>) => {
		await provider.postMessageToWebview({
			type: "transcriptionError",
			transcriptionRequestId: requestId,
			values,
		})
	}

	if (!requestId || typeof message.audioBase64 !== "string" || !message.audioBase64.trim()) {
		await postError({ errorI18nKey: "chat:voiceInput.errorInvalidRequest" })
		return
	}

	if (message.audioBase64.length > 36 * 1024 * 1024) {
		await postError({ errorI18nKey: "chat:voiceInput.errorAudioTooLarge" })
		return
	}

	try {
		let buf: Buffer
		try {
			buf = Buffer.from(message.audioBase64, "base64")
		} catch {
			await postError({ errorI18nKey: "chat:voiceInput.errorInvalidRequest" })
			return
		}

		if (buf.length === 0) {
			await postError({ errorI18nKey: "chat:voiceInput.errorInvalidRequest" })
			return
		}

		const state = await provider.getState()
		const { apiConfiguration, enhancementApiConfigId, listApiConfigMeta = [] } = state

		let creds = getWhisperCredentialsFromProviderSettings(apiConfiguration)
		if (
			!creds &&
			enhancementApiConfigId &&
			listApiConfigMeta.some((m) => m.id === enhancementApiConfigId)
		) {
			try {
				const { name: _n, ...profile } = await provider.providerSettingsManager.getProfile({
					id: enhancementApiConfigId,
				})
				creds = getWhisperCredentialsFromProviderSettings(profile as ProviderSettings)
			} catch (e) {
				provider.log(`transcribeAudio enhancement profile: ${getErrorMessage(e)}`)
			}
		}

		if (!creds) {
			await postError({ errorI18nKey: "chat:voiceInput.errorNoOpenAi" })
			return
		}

		const mime = message.audioMimeType?.trim() || "audio/webm"
		const ext = mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "webm"
		const langRaw = message.values?.language
		const language = typeof langRaw === "string" && langRaw.length >= 2 ? langRaw : undefined

		const text = await transcribeWithOpenAiWhisper({
			apiKey: creds.apiKey,
			baseUrl: creds.baseUrl,
			audioBuffer: buf,
			mimeType: mime,
			filename: `recording.${ext}`,
			language,
		})

		await provider.postMessageToWebview({
			type: "transcriptionResult",
			text,
			transcriptionRequestId: requestId,
		})
	} catch (error) {
		provider.log(`transcribeAudio: ${error instanceof Error ? error.message : JSON.stringify(error)}`)
		await postError({
			errorI18nKey: "chat:voiceInput.errorTranscriptionFailed",
			detail: getErrorMessage(error),
		})
	}
}

async function handleGetSystemPrompt(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const systemPrompt = await generateSystemPrompt(provider, message)
		await provider.postMessageToWebview({
			type: "systemPrompt",
			text: systemPrompt,
			mode: message.mode,
		})
	} catch (error) {
		provider.log(`Error getting system prompt: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
	}
}

async function handleCopySystemPrompt(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const systemPrompt = await generateSystemPrompt(provider, message)
		await vscode.env.clipboard.writeText(systemPrompt)
		await vscode.window.showInformationMessage(t("common:info.clipboard_copy"))
	} catch (error) {
		provider.log(`Error getting system prompt: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
	}
}

async function handleSearchCommits(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	const cwd = getCurrentCwd()
	if (cwd) {
		try {
			const commits = await searchCommits(message.query || "", cwd)
			await provider.postMessageToWebview({
				type: "commitSearchResults",
				commits,
			})
		} catch (error) {
			provider.log(`Error searching commits: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.search_commits"))
		}
	}
}

async function handleSearchFiles(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	const workspacePath = getCurrentCwd()

	if (!workspacePath) {
		await provider.postMessageToWebview({
			type: "fileSearchResults",
			results: [],
			requestId: message.requestId,
			error: "No workspace path available",
		})
		return
	}
	try {
		const results = await searchWorkspaceFiles(message.query || "", workspacePath, 20)

		const currentTask = provider.getCurrentTask()
		let rooIgnoreController = currentTask?.rooIgnoreController
		let tempController: RooIgnoreController | undefined

		if (!rooIgnoreController) {
			tempController = new RooIgnoreController(workspacePath)
			await tempController.initialize()
			rooIgnoreController = tempController
		}

		try {
			const { showRooIgnoredFiles = false } = (await provider.getState()) ?? {}

			let filteredResults = results
			if (!showRooIgnoredFiles && rooIgnoreController) {
				const allowedPaths = rooIgnoreController.filterPaths(results.map((r) => r.path))
				filteredResults = results.filter((r) => allowedPaths.includes(r.path))
			}

			await provider.postMessageToWebview({
				type: "fileSearchResults",
				results: filteredResults,
				requestId: message.requestId,
			})
		} finally {
			tempController?.dispose()
		}
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		await provider.postMessageToWebview({
			type: "fileSearchResults",
			results: [],
			error: errorMessage,
			requestId: message.requestId,
		})
	}
}

async function handleInsertTextIntoTextarea(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.text) {
		await context.provider.postMessageToWebview({
			type: "insertTextIntoTextarea",
			text: message.text,
		})
	}
}

function handleShowMdmAuthRequiredNotification(_context: MessageHandlerContext, _message: WebviewMessage): void {
	vscode.window.showWarningMessage(t("common:mdm.info.organization_requires_auth"))
}

async function handleDismissUpsell(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState, updateGlobalState } = context
	if (message.upsellId) {
		try {
			const dismissedUpsells = getGlobalState("dismissedUpsells") || []
			let updatedList = dismissedUpsells
			if (!dismissedUpsells.includes(message.upsellId)) {
				updatedList = [...dismissedUpsells, message.upsellId]
				await updateGlobalState("dismissedUpsells", updatedList)
			}
			await provider.postMessageToWebview({ type: "dismissedUpsells", list: updatedList })
		} catch (error) {
			provider.log(`Failed to dismiss upsell: ${getErrorMessage(error)}`)
		}
	}
}

async function handleGetDismissedUpsells(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState } = context
	const dismissedUpsells = getGlobalState("dismissedUpsells") || []
	await provider.postMessageToWebview({ type: "dismissedUpsells", list: dismissedUpsells })
}

async function handleOpenMarkdownPreview(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.text) {
		try {
			const tmpDir = os.tmpdir()
			const timestamp = Date.now()
			const tempFileName = `njust-ai-preview-${timestamp}.md`
			const tempFilePath = path.join(tmpDir, tempFileName)

			await fs.writeFile(tempFilePath, message.text, "utf8")

			const doc = await vscode.workspace.openTextDocument(tempFilePath)
			await vscode.commands.executeCommand("markdown.showPreview", doc.uri)
		} catch (error) {
			const errorMessage = getErrorMessage(error)
			provider.log(`Error opening markdown preview: ${errorMessage}`)
			vscode.window.showErrorMessage(`Failed to open markdown preview: ${errorMessage}`)
		}
	}
}

async function handleDownloadErrorDiagnostics(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const currentTask = provider.getCurrentTask()
	if (!currentTask) {
		vscode.window.showErrorMessage("No active task to generate diagnostics for")
		return
	}

	await generateErrorDiagnostics({
		taskId: currentTask.taskId,
		globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
		values: message.values,
		log: (msg: string) => provider.log(msg),
	})
}
