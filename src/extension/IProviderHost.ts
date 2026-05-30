import type * as vscode from "vscode"
import type { ProviderSettings, ProviderSettingsEntry, CreateTaskOptions, HistoryItem } from "@njust-ai/types"
import type { ContextProxy } from "../core/config/ContextProxy"
import type { ProviderSettingsManager } from "../core/config/ProviderSettingsManager"
import type { Task } from "../core/task/Task"

export interface IProviderHost {
	readonly context: vscode.ExtensionContext
	readonly cwd: string
	readonly contextProxy: ContextProxy
	readonly providerSettingsManager: ProviderSettingsManager
	readonly viewLaunched: boolean

	getModes(): Promise<{ slug: string; name: string }[]>
	getValues(): Record<string, unknown>
	getCurrentTask(): Task | undefined
	getCurrentTaskStack(): string[]
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	createTask(text?: string, images?: string[], parentTask?: unknown, options?: CreateTaskOptions, configuration?: unknown): Promise<Task | undefined>
	createTaskWithHistoryItem(historyItem: HistoryItem, options?: unknown): Promise<Task | undefined>
	cancelTask(): Promise<void>
	postStateToWebview(): Promise<void>
	postMessageToWebview(message: UnsafeAny): Promise<void>
	getProviderProfileEntries(): ProviderSettingsEntry[]
	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined
	upsertProviderProfile(name: string, profile: ProviderSettings, activate?: boolean): Promise<string | undefined>
	deleteProviderProfile(entry: ProviderSettingsEntry): Promise<void>
	activateProviderProfile(args: { name: string }): Promise<void>
	readonly stack: { pop(options?: unknown): Promise<void> }

	on(event: string, listener: (...args: UnsafeAny[]) => void): this
}

