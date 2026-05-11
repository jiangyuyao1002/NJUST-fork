import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { NJUST_AI_CONFIG_DIR, type Command, type WebviewMessage } from "@njust-ai-cj/types"
import { type Mode, defaultModeSlug } from "../../../shared/modes"
import { customToolRegistry } from "@njust-ai-cj/core"
import { getRooDirectoriesForCwd } from "../../../services/roo-config/index.js"
import { openFile } from "../../../integrations/misc/open-file"
import { fileExistsAtPath } from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { t } from "../../../i18n"
import {
	handleRequestSkills as skillsRequestSkills,
	handleCreateSkill as skillsCreateSkill,
	handleDeleteSkill as skillsDeleteSkill,
	handleMoveSkill as skillsMoveSkill,
	handleUpdateSkillModes as skillsUpdateSkillModes,
	handleOpenSkillFile as skillsOpenSkillFile,
} from "../skillsMessageHandler"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../../utils/export"

import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"
import { getErrorMessage } from "../../../shared/error-utils"

export function registerModeHandlers(router: MessageRouter): void {
	router.register("mode", handleMode)
	router.register("updatePrompt", handleUpdatePrompt)
	router.register("openCustomModesSettings", handleOpenCustomModesSettings)
	router.register("openKeyboardShortcuts", handleOpenKeyboardShortcuts)
	router.register("refreshCustomTools", handleRefreshCustomTools)
	router.register("updateCustomMode", handleUpdateCustomMode)
	router.register("deleteCustomMode", handleDeleteCustomMode)
	router.register("exportMode", handleExportMode)
	router.register("importMode", handleImportMode)
	router.register("checkRulesDirectory", handleCheckRulesDirectory)
	router.register("requestCommands", handleRequestCommands)
	router.register("requestModes", handleRequestModes)
	router.register("requestSkills", handleRequestSkills)
	router.register("createSkill", handleCreateSkill)
	router.register("deleteSkill", handleDeleteSkill)
	router.register("moveSkill", handleMoveSkill)
	router.register("updateSkillModes", handleUpdateSkillModes)
	router.register("openSkillFile", handleOpenSkillFile)
	router.register("openCommandFile", handleOpenCommandFile)
	router.register("deleteCommand", handleDeleteCommand)
	router.register("createCommand", handleCreateCommand)
	router.register("openDebugApiHistory", handleOpenDebugHistory)
	router.register("openDebugUiHistory", handleOpenDebugHistory)
}

async function handleMode(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await context.provider.handleModeSwitch(message.text as Mode)
}

async function handleUpdatePrompt(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState, updateGlobalState } = context
	if (message.promptMode && message.customPrompt !== undefined) {
		const existingPrompts = getGlobalState("customModePrompts") ?? {}
		const updatedPrompts = { ...existingPrompts, [message.promptMode]: message.customPrompt }
		await updateGlobalState("customModePrompts", updatedPrompts)
		const currentState = await provider.getStateToPostToWebview()
		const stateWithPrompts = {
			...currentState,
			customModePrompts: updatedPrompts,
			hasOpenedModeSelector: currentState.hasOpenedModeSelector ?? false,
		}
		void provider.postMessageToWebview({ type: "state", state: stateWithPrompts })
	}
}

async function handleOpenCustomModesSettings(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const customModesFilePath = await context.provider.customModesManager.getCustomModesFilePath()
	if (customModesFilePath) {
		void openFile(customModesFilePath)
	}
}

async function handleOpenKeyboardShortcuts(_context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const searchQuery = message.text || ""
	if (searchQuery) {
		await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", searchQuery)
	} else {
		await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings")
	}
}

async function handleRefreshCustomTools(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	try {
		const toolDirs = getRooDirectoriesForCwd(getCurrentCwd()).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectories(toolDirs)
		await provider.postMessageToWebview({
			type: "customToolsResult",
			tools: customToolRegistry.getAllSerialized(),
		})
	} catch (error) {
		await provider.postMessageToWebview({
			type: "customToolsResult",
			tools: [],
			error: getErrorMessage(error),
		})
	}
}

async function handleUpdateCustomMode(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	if (message.modeConfig) {
		try {
			await provider.customModesManager.updateCustomMode(message.modeConfig.slug, message.modeConfig)
			const customModes = await provider.customModesManager.getCustomModes()
			await updateGlobalState("customModes", customModes)
			await updateGlobalState("mode", message.modeConfig.slug)
			await provider.postStateToWebview()
		} catch {
			// Error already shown to user by updateCustomMode
		}
	}
}

async function handleDeleteCustomMode(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	if (message.slug) {
		const customModes = await provider.customModesManager.getCustomModes()
		const modeToDelete = customModes.find((mode) => mode.slug === message.slug)
		if (!modeToDelete) return

		const scope = modeToDelete.source || "global"

		let rulesFolderPath: string
		if (scope === "project") {
			const wsPath = getWorkspacePath()
			if (wsPath) {
				rulesFolderPath = path.join(wsPath, NJUST_AI_CONFIG_DIR, `rules-${message.slug}`)
			} else {
				rulesFolderPath = path.join(NJUST_AI_CONFIG_DIR, `rules-${message.slug}`)
			}
		} else {
			const homeDir = os.homedir()
			rulesFolderPath = path.join(homeDir, NJUST_AI_CONFIG_DIR, `rules-${message.slug}`)
		}

		const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)

		if (message.checkOnly) {
			await provider.postMessageToWebview({
				type: "deleteCustomModeCheck",
				slug: message.slug,
				rulesFolderPath: rulesFolderExists ? rulesFolderPath : undefined,
			})
			return
		}

		await provider.customModesManager.deleteCustomMode(message.slug)

		if (rulesFolderExists) {
			try {
				await fs.rm(rulesFolderPath, { recursive: true, force: true })
				provider.log(`Deleted rules folder for mode ${message.slug}: ${rulesFolderPath}`)
			} catch (error) {
				provider.log(`Failed to delete rules folder for mode ${message.slug}: ${error}`)
				vscode.window.showErrorMessage(
					t("common:errors.delete_rules_folder_failed", {
						rulesFolderPath,
						error: getErrorMessage(error),
					}),
				)
			}
		}

		await updateGlobalState("mode", defaultModeSlug)
		await provider.postStateToWebview()
	}
}

async function handleExportMode(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState } = context
	if (message.slug) {
		try {
			const customModePrompts = getGlobalState("customModePrompts") || {}
			const customPrompt = customModePrompts[message.slug]
			const result = await provider.customModesManager.exportModeWithRules(message.slug, customPrompt)

			if (result.success && result.yaml) {
				const defaultUri = await resolveDefaultSaveUri(
					provider.contextProxy,
					"lastModeExportPath",
					`${message.slug}-export.yaml`,
					{
						useWorkspace: true,
						fallbackDir: path.join(os.homedir(), "Downloads"),
					},
				)

				const saveUri = await vscode.window.showSaveDialog({
					defaultUri,
					filters: { "YAML files": ["yaml", "yml"] },
					title: "Save mode export",
				})

				if (saveUri && result.yaml) {
					await saveLastExportPath(provider.contextProxy, "lastModeExportPath", saveUri)
					await fs.writeFile(saveUri.fsPath, result.yaml, "utf-8")
					void provider.postMessageToWebview({ type: "exportModeResult", success: true, slug: message.slug })
					vscode.window.showInformationMessage(t("common:info.mode_exported", { mode: message.slug }))
				} else {
					void provider.postMessageToWebview({ type: "exportModeResult", success: false, error: "Export cancelled", slug: message.slug })
				}
			} else {
				void provider.postMessageToWebview({ type: "exportModeResult", success: false, error: result.error, slug: message.slug })
			}
		} catch (error) {
			const errorMessage = getErrorMessage(error)
			provider.log(`Failed to export mode ${message.slug}: ${errorMessage}`)
			void provider.postMessageToWebview({ type: "exportModeResult", success: false, error: errorMessage, slug: message.slug })
		}
	}
}

async function handleImportMode(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState, updateGlobalState } = context
	try {
		const lastImportPath = getGlobalState("lastModeImportPath")
		let defaultUri: vscode.Uri | undefined
		if (lastImportPath) {
			defaultUri = vscode.Uri.file(path.dirname(lastImportPath))
		} else {
			const workspaceFolders = vscode.workspace.workspaceFolders
			if (workspaceFolders && workspaceFolders.length > 0) {
				defaultUri = vscode.Uri.file(workspaceFolders[0].uri.fsPath)
			}
		}

		const fileUri = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri,
			filters: { "YAML files": ["yaml", "yml"] },
			title: "Select mode export file to import",
		})

		if (fileUri?.[0]) {
			await updateGlobalState("lastModeImportPath", fileUri[0].fsPath)
			const yamlContent = await fs.readFile(fileUri[0].fsPath, "utf-8")
			const result = await provider.customModesManager.importModeWithRules(yamlContent, message.source || "project")

			if (result.success) {
				const customModes = await provider.customModesManager.getCustomModes()
				await updateGlobalState("customModes", customModes)
				await provider.postStateToWebview()
				void provider.postMessageToWebview({ type: "importModeResult", success: true, slug: result.slug })
				vscode.window.showInformationMessage(t("common:info.mode_imported"))
			} else {
				void provider.postMessageToWebview({ type: "importModeResult", success: false, error: result.error })
				vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: result.error }))
			}
		} else {
			void provider.postMessageToWebview({ type: "importModeResult", success: false, error: "cancelled" })
		}
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Failed to import mode: ${errorMessage}`)
		void provider.postMessageToWebview({ type: "importModeResult", success: false, error: errorMessage })
		vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: errorMessage }))
	}
}

async function handleCheckRulesDirectory(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.slug) {
		const hasContent = await context.provider.customModesManager.checkRulesDirectoryHasContent(message.slug)
		void context.provider.postMessageToWebview({
			type: "checkRulesDirectoryResult",
			slug: message.slug,
			hasContent: hasContent,
		})
	}
}

async function handleRequestCommands(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd, getCurrentMode } = context
	try {
		const { getCommands } = await import("../../../services/command/commands")
		const commands = await getCommands(getCurrentCwd())
		const commandList: Command[] = commands.map((command) => ({
			name: command.name,
			source: command.source,
			filePath: command.filePath,
			description: command.description,
			argumentHint: command.argumentHint,
		}))

		const existingCommandNames = new Set(commandList.map((c) => c.name))
		const skillsManager = provider.getSkillsManager()

		if (skillsManager) {
			const currentMode = await getCurrentMode()
			const availableSkills = skillsManager.getSkillsForMode(currentMode)
			for (const skill of availableSkills) {
				if (!existingCommandNames.has(skill.name)) {
					existingCommandNames.add(skill.name)
					commandList.push({
						name: skill.name,
						source: skill.source,
						filePath: skill.path,
						description: skill.description,
					})
				}
			}
		}

		await provider.postMessageToWebview({ type: "commands", commands: commandList })
	} catch (error) {
		provider.log(`Error fetching commands: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		await provider.postMessageToWebview({ type: "commands", commands: [] })
	}
}

async function handleRequestModes(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const modes = await provider.getModes()
		await provider.postMessageToWebview({ type: "modes", modes })
	} catch (error) {
		provider.log(`Error fetching modes: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		await provider.postMessageToWebview({ type: "modes", modes: [] })
	}
}

async function handleRequestSkills(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	await skillsRequestSkills(context.provider)
}

async function handleCreateSkill(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await skillsCreateSkill(context.provider, message)
}

async function handleDeleteSkill(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await skillsDeleteSkill(context.provider, message)
}

async function handleMoveSkill(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await skillsMoveSkill(context.provider, message)
}

async function handleUpdateSkillModes(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await skillsUpdateSkillModes(context.provider, message)
}

async function handleOpenSkillFile(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	await skillsOpenSkillFile(context.provider, message)
}

async function handleOpenCommandFile(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	try {
		if (message.text) {
			const { getCommand } = await import("../../../services/command/commands")
			const command = await getCommand(getCurrentCwd(), message.text)
			if (command?.filePath) {
				void openFile(command.filePath)
			} else {
				vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
			}
		}
	} catch (error) {
		provider.log(`Error opening command file: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.open_command_file"))
	}
}

async function handleDeleteCommand(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	try {
		if (message.text && message.values?.source) {
			const { getCommand } = await import("../../../services/command/commands")
			const command = await getCommand(getCurrentCwd(), message.text)
			if (command?.filePath) {
				await fs.unlink(command.filePath)
				provider.log(`Deleted command file: ${command.filePath}`)
			} else {
				vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
			}
		}
	} catch (error) {
		provider.log(`Error deleting command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.delete_command"))
	}
}

async function handleCreateCommand(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	try {
		const source = message.values?.source as "global" | "project"
		const fileName = message.text

		if (!source) {
			provider.log("Missing source for createCommand")
			return
		}

		let commandsDir: string
		if (source === "global") {
			const globalConfigDir = path.join(os.homedir(), NJUST_AI_CONFIG_DIR)
			commandsDir = path.join(globalConfigDir, "commands")
		} else {
			if (!vscode.workspace.workspaceFolders?.length) {
				vscode.window.showErrorMessage(t("common:errors.no_workspace"))
				return
			}
			const workspaceRoot = getCurrentCwd()
			if (!workspaceRoot) {
				vscode.window.showErrorMessage(t("common:errors.no_workspace_for_project_command"))
				return
			}
			commandsDir = path.join(workspaceRoot, NJUST_AI_CONFIG_DIR, "commands")
		}

		await fs.mkdir(commandsDir, { recursive: true })

		let commandName: string
		if (fileName?.trim()) {
			let cleanFileName = fileName.trim()
			if (cleanFileName.startsWith("/")) {
				cleanFileName = cleanFileName.substring(1)
			}
			if (cleanFileName.toLowerCase().endsWith(".md")) {
				cleanFileName = cleanFileName.slice(0, -3)
			}
			commandName = cleanFileName
				.toLowerCase()
				.replace(/\s+/g, "-")
				.replace(/[^a-z0-9-]/g, "")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")

			if (!commandName || commandName.length === 0) {
				commandName = "new-command"
			}
		} else {
			commandName = "new-command"
			let counter = 1
			let fp = path.join(commandsDir, `${commandName}.md`)
			while (await fs.access(fp).then(() => true).catch(() => false)) {
				commandName = `new-command-${counter}`
				fp = path.join(commandsDir, `${commandName}.md`)
				counter++
			}
		}

		const filePath = path.join(commandsDir, `${commandName}.md`)
		if (await fs.access(filePath).then(() => true).catch(() => false)) {
			vscode.window.showErrorMessage(t("common:errors.command_already_exists", { commandName }))
			return
		}

		const templateContent = t("common:errors.command_template_content")
		await fs.writeFile(filePath, templateContent, "utf8")
		provider.log(`Created new command file: ${filePath}`)

		void openFile(filePath)

		const { getCommands } = await import("../../../services/command/commands")
		const commands = await getCommands(getCurrentCwd() || "")
		const commandList = commands.map((command) => ({
			name: command.name,
			source: command.source,
			filePath: command.filePath,
			description: command.description,
			argumentHint: command.argumentHint,
		}))
		await provider.postMessageToWebview({ type: "commands", commands: commandList })
	} catch (error) {
		provider.log(`Error creating command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.create_command_failed"))
	}
}

async function handleOpenDebugHistory(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const currentTask = provider.getCurrentTask()
	if (!currentTask) {
		vscode.window.showErrorMessage("No active task to view history for")
		return
	}

	try {
		const { getTaskDirectoryPath } = await import("../../../utils/storage")
		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, currentTask.taskId)

		const fileName = message.type === "openDebugApiHistory" ? "api_conversation_history.json" : "ui_messages.json"
		const sourceFilePath = path.join(taskDirPath, fileName)

		if (!(await fileExistsAtPath(sourceFilePath))) {
			vscode.window.showErrorMessage(`File not found: ${fileName}`)
			return
		}

		const content = await fs.readFile(sourceFilePath, "utf8")
		let jsonContent: unknown
		try {
			jsonContent = JSON.parse(content)
		} catch {
			vscode.window.showErrorMessage(`Failed to parse ${fileName}`)
			return
		}

		const prettifiedContent = JSON.stringify(jsonContent, null, 2)

		const tmpDir = os.tmpdir()
		const timestamp = Date.now()
		const suffix = message.type === "openDebugApiHistory" ? "api" : "ui"
		const tempFileName = `roo-debug-${suffix}-${currentTask.taskId.slice(0, 8)}-${timestamp}.json`
		const tempFilePath = path.join(tmpDir, tempFileName)

		await fs.writeFile(tempFilePath, prettifiedContent, "utf8")

		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error opening debug history: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to open debug history: ${errorMessage}`)
	}
}
