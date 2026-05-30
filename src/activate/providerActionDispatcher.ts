import * as vscode from "vscode"

import {
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
} from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import { supportPrompt } from "../shared/support-prompt"
import { Package } from "../shared/package"
import { OrganizationAllowListViolationError } from "../utils/errors"
import delay from "delay"
import { findLast } from "../shared/array"

export interface IProviderActionTarget {
	readonly view?: { visible?: boolean }
	getState(): Promise<{ customSupportPrompts?: Record<string, string | undefined> }>
	postMessageToWebview(message: UnsafeAny): Promise<void>
	createTask(text: string, images?: string[], parentTask?: unknown, options?: unknown, configuration?: unknown): Promise<unknown>
}

const activeInstances: Set<IProviderActionTarget & { constructor: { name: string } }> = new Set()

export function registerActionTarget(target: IProviderActionTarget): void {
	activeInstances.add(target as IProviderActionTarget & { constructor: { name: string } })
}

export function unregisterActionTarget(target: IProviderActionTarget): void {
	activeInstances.delete(target as IProviderActionTarget & { constructor: { name: string } })
}

export function getVisibleInstance(): IProviderActionTarget | undefined {
	return findLast(Array.from(activeInstances), (instance) => instance.view?.visible === true)
}

export async function getInstance(): Promise<IProviderActionTarget | undefined> {
	let visibleProvider = getVisibleInstance()

	if (!visibleProvider) {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		await delay(100)
		visibleProvider = getVisibleInstance()
	}

	return visibleProvider
}

export async function handleCodeAction(
	command: CodeActionId,
	promptType: CodeActionName,
	params: Record<string, string | unknown[]>,
): Promise<void> {
	TelemetryService.instance.captureCodeActionUsed(promptType)

	const visibleProvider = await getInstance()

	if (!visibleProvider) {
		return
	}

	const { customSupportPrompts } = await visibleProvider.getState()

	const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

	if (command === "addToContext") {
		await visibleProvider.postMessageToWebview({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: `${prompt}\n\n`,
		})
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
		return
	}

	await visibleProvider.createTask(prompt)
}

export async function handleTerminalAction(
	command: TerminalActionId,
	promptType: TerminalActionPromptType,
	params: Record<string, string | unknown[]>,
): Promise<void> {
	TelemetryService.instance.captureCodeActionUsed(promptType)

	const visibleProvider = await getInstance()

	if (!visibleProvider) {
		return
	}

	const { customSupportPrompts } = await visibleProvider.getState()
	const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

	if (command === "terminalAddToContext") {
		await visibleProvider.postMessageToWebview({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: `${prompt}\n\n`,
		})
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
		return
	}

	try {
		await visibleProvider.createTask(prompt)
	} catch (error) {
		if (error instanceof OrganizationAllowListViolationError) {
			vscode.window.showErrorMessage(error.message)
		}

		throw error
	}
}
