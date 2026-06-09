import * as vscode from "vscode"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { buildApiHandler } from "../../api"
import { defaultToolCallParser } from "../assistant-message/ToolCallParserImpl"

import { SYSTEM_PROMPT } from "../prompts/system"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { Package } from "../../shared/package"

import { logger } from "../../shared/logger"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

export interface ISystemPromptHost {
	getState(): Promise<{
		apiConfiguration: UnsafeAny
		customModePrompts?: UnsafeAny
		customInstructions?: string | undefined
		mcpEnabled: boolean
		experiments: UnsafeAny
		language?: string
		enableSubfolderRules: boolean | undefined
	}>
	readonly cwd: string
	readonly context: vscode.ExtensionContext
	getMcpHub(): UnsafeAny
	getSkillsManager(): UnsafeAny
	getCustomModes(): Promise<UnsafeAny[]>
	getCurrentTask(): { rooIgnoreController?: { getInstructions(): string | undefined } } | undefined
}

export const generateSystemPrompt = async (provider: ISystemPromptHost, message: WebviewMessage) => {
	const {
		apiConfiguration,
		customModePrompts,
		customInstructions,
		mcpEnabled,
		experiments,
		language,
		enableSubfolderRules,
	} = await provider.getState()

	const diffStrategy = new MultiSearchReplaceDiffStrategy()

	const cwd = provider.cwd

	const mode = message.mode ?? defaultModeSlug
	const customModes = await provider.getCustomModes()

	const rooIgnoreInstructions = provider.getCurrentTask()?.rooIgnoreController?.getInstructions()

	let modelInfo: { isStealthModel?: boolean } | undefined
	try {
		const tempApiHandler = buildApiHandler(apiConfiguration, undefined, { toolCallParser: defaultToolCallParser })
		modelInfo = tempApiHandler.getModel().info
	} catch (error) {
		logger.error("GenerateSystemPrompt", "Error fetching model info for system prompt preview:", error)
		TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
	}

	const systemPrompt = await SYSTEM_PROMPT(
		provider.context,
		cwd,
		false,
		mcpEnabled ? provider.getMcpHub() : undefined,
		diffStrategy,
		mode,
		customModePrompts,
		customModes,
		customInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		{
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
			enableSubfolderRules: enableSubfolderRules ?? false,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: modelInfo?.isStealthModel,
		},
		undefined,
		undefined,
		provider.getSkillsManager(),
	)

	return systemPrompt
}
