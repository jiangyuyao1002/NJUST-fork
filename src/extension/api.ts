import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type NJUST_AIAPI,
	type NJUST_AISettings,
	type NJUST_AIEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	type CreateTaskOptions,
	NJUST_AIEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
} from "@njust-ai/types"
import { IpcServer } from "@njust-ai/ipc"

import { Package } from "../shared/package"
import { logger } from "../shared/logger"
import { openClineInNewTab } from "../activate/registerCommands"
import { getCommands } from "../services/command/commands"
import { getModels } from "../api/providers/fetchers/modelCache"
import { getErrorMessage } from "../shared/error-utils"
import type { IProviderHost } from "./IProviderHost"

export class API extends EventEmitter<NJUST_AIEvents> implements NJUST_AIAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: IProviderHost
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly log: (...args: UnsafeAny[]) => void
	private logfile?: string

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: IProviderHost,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

		if (enableLogging) {
			this.log = (...args: UnsafeAny[]) => {
				this.outputChannelLog(...args)
				logger.info("API", args.map(String).join(" "))
			}

			this.logfile = path.join(os.tmpdir(), "Njust-AI-messages.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners(this.sidebarProvider)

		if (socketPath) {
			const ipc = (this.ipc = new IpcServer(socketPath, this.log))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (clientId, command) => {
				const sendResponse = (eventName: NJUST_AIEventName, payload: UnsafeAny[]) => {
					ipc.send(clientId, {
						type: IpcMessageType.TaskEvent,
						origin: IpcOrigin.Server,
						data: { eventName, payload } as TaskEvent,
					})
				}

				switch (command.commandName) {
					case TaskCommandName.StartNewTask:
						this.log(
							`[API] StartNewTask -> ${command.data.text}, ${JSON.stringify(command.data.configuration)}`,
						)
						await this.startNewTask(command.data)
						break
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask`)
						await this.cancelCurrentTask()
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
					case TaskCommandName.ResumeTask:
						this.log(`[API] ResumeTask -> ${command.data}`)
						try {
							await this.resumeTask(command.data)
						} catch (error) {
							const errorMessage = getErrorMessage(error)
							this.log(`[API] ResumeTask failed for taskId ${command.data}: ${errorMessage}`)
						}
						break
					case TaskCommandName.SendMessage:
						this.log(`[API] SendMessage -> ${command.data.text}`)
						await this.sendMessage(command.data.text, command.data.images)
						break
					case TaskCommandName.GetCommands:
						try {
							const commands = await getCommands(this.sidebarProvider.cwd)

							sendResponse(NJUST_AIEventName.CommandsResponse, [
								commands.map((cmd) => ({
									name: cmd.name,
									source: cmd.source,
									filePath: cmd.filePath,
									description: cmd.description,
									argumentHint: cmd.argumentHint,
								})),
							])
						} catch (e) {
							logger.warn("ExtensionAPI", `CommandsRequest failed: ${e}`)
							sendResponse(NJUST_AIEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(NJUST_AIEventName.ModesResponse, [modes])
						} catch (e) {
							logger.warn("ExtensionAPI", `ModesRequest failed: ${e}`)
							sendResponse(NJUST_AIEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							const models = await getModels({
								provider: "njust-ai" as const,
								baseUrl: process.env.NJUST_AI_PROVIDER_URL ?? "",
								apiKey: undefined,
							})

							sendResponse(NJUST_AIEventName.ModelsResponse, [models])
						} catch (e) {
							logger.warn("ExtensionAPI", `ModelsRequest failed: ${e}`)
							sendResponse(NJUST_AIEventName.ModelsResponse, [{}])
						}

						break
					case TaskCommandName.DeleteQueuedMessage:
						this.log(`[API] DeleteQueuedMessage -> ${command.data}`)
						try {
							this.deleteQueuedMessage(command.data)
						} catch (error) {
							const errorMessage = getErrorMessage(error)
							this.log(`[API] DeleteQueuedMessage failed for messageId ${command.data}: ${errorMessage}`)
						}
						break
				}
			})
		}
	}

	public override emit<K extends keyof NJUST_AIEvents>(
		eventName: K,
		...args: K extends keyof NJUST_AIEvents ? NJUST_AIEvents[K] : never
	) {
		const data = { eventName: eventName as NJUST_AIEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })
		return super.emit(eventName, ...args)
	}

	public async startNewTask({
		configuration,
		text,
		images,
		newTab,
	}: {
		configuration: NJUST_AISettings
		text?: string
		images?: string[]
		newTab?: boolean
	}) {
		let provider: IProviderHost

		if (newTab) {
			await vscode.commands.executeCommand("workbench.action.files.revert")
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")

			provider = await openClineInNewTab({ context: this.context, outputChannel: this.outputChannel })
			this.registerListeners(provider as UnsafeAny)
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		await provider.stack.pop()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const options: CreateTaskOptions = {
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
		}

		const task = await provider.createTask(text, images, undefined, options, configuration)

		if (!task) {
			throw new Error("Failed to create task due to policy restrictions")
		}

		return task.taskId
	}

	public async resumeTask(taskId: string): Promise<void> {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		await this.waitForWebviewLaunch(5_000)

		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		await this.sidebarProvider.createTaskWithHistoryItem(historyItem)

		if (this.sidebarProvider.viewLaunched) {
			await this.sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		} else {
			this.log(
				`[API#resumeTask] webview not launched after resume for task ${taskId}; continuing in headless mode`,
			)
		}
	}

	public async isTaskInHistory(taskId: string): Promise<boolean> {
		try {
			await this.sidebarProvider.getTaskWithId(taskId)
			return true
		} catch {
			return false
		}
	}

	public getCurrentTaskStack() {
		return this.sidebarProvider.getCurrentTaskStack()
	}

	public async clearCurrentTask(_lastMessage?: string) {
		await this.sidebarProvider.stack.pop()
		await this.sidebarProvider.postStateToWebview()
	}

	public async cancelCurrentTask() {
		await this.sidebarProvider.cancelTask()
	}

	public async sendMessage(text?: string, images?: string[]) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		if (!this.sidebarProvider.viewLaunched) {
			if (!currentTask) {
				this.log("[API#sendMessage] no current task in headless mode; message dropped")
				return
			}

			await currentTask.submitUserMessage(text ?? "", images)
			return
		}

		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public deleteQueuedMessage(messageId: string) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		if (!currentTask) {
			this.log(`[API#deleteQueuedMessage] no current task; ignoring delete for messageId ${messageId}`)
			return
		}

		currentTask.messageQueueService.removeMessage(messageId)
	}

	public async pressPrimaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	public isReady() {
		return this.sidebarProvider.viewLaunched
	}

	private async waitForWebviewLaunch(timeoutMs: number): Promise<boolean> {
		try {
			await pWaitFor(() => this.sidebarProvider.viewLaunched, {
				timeout: timeoutMs,
				interval: 50,
			})

			return true
		} catch {
			this.log(`[API#waitForWebviewLaunch] webview did not launch within ${timeoutMs}ms`)
			return false
		}
	}

	private registerListeners(provider: IProviderHost) {
		provider.on(NJUST_AIEventName.TaskCreated, (task) => {
			task.on(NJUST_AIEventName.TaskStarted, async () => {
				this.emit(NJUST_AIEventName.TaskStarted, task.taskId)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${task.taskId}\n`)
			})

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			task.on(NJUST_AIEventName.TaskCompleted, async (_: unknown, tokenUsage: any, toolUsage: any) => {
				this.emit(NJUST_AIEventName.TaskCompleted, task.taskId, tokenUsage, toolUsage, {
					isSubtask: !!task.parentTaskId,
				})

				await this.fileLog(
					`[${new Date().toISOString()}] taskCompleted -> ${task.taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
				)
			})

			task.on(NJUST_AIEventName.TaskAborted, () => {
				this.emit(NJUST_AIEventName.TaskAborted, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskFocused, () => {
				this.emit(NJUST_AIEventName.TaskFocused, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskUnfocused, () => {
				this.emit(NJUST_AIEventName.TaskUnfocused, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskActive, () => {
				this.emit(NJUST_AIEventName.TaskActive, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskInteractive, () => {
				this.emit(NJUST_AIEventName.TaskInteractive, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskResumable, () => {
				this.emit(NJUST_AIEventName.TaskResumable, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskIdle, () => {
				this.emit(NJUST_AIEventName.TaskIdle, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskPaused, () => {
				this.emit(NJUST_AIEventName.TaskPaused, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskUnpaused, () => {
				this.emit(NJUST_AIEventName.TaskUnpaused, task.taskId)
			})

			task.on(NJUST_AIEventName.TaskSpawned, (childTaskId: UnsafeAny) => {
				this.emit(NJUST_AIEventName.TaskSpawned, task.taskId, childTaskId)
			})

			task.on(NJUST_AIEventName.TaskDelegated as UnsafeAny, (childTaskId: UnsafeAny) => {
				;(this.emit as UnsafeAny)(NJUST_AIEventName.TaskDelegated, task.taskId, childTaskId)
			})

			task.on(NJUST_AIEventName.TaskDelegationCompleted as UnsafeAny, (childTaskId: UnsafeAny, summary: UnsafeAny) => {
				;(this.emit as UnsafeAny)(NJUST_AIEventName.TaskDelegationCompleted, task.taskId, childTaskId, summary)
			})

			task.on(NJUST_AIEventName.TaskDelegationResumed as UnsafeAny, (childTaskId: UnsafeAny) => {
				;(this.emit as UnsafeAny)(NJUST_AIEventName.TaskDelegationResumed, task.taskId, childTaskId)
			})

			task.on(NJUST_AIEventName.Message, async (message: UnsafeAny) => {
				this.emit(NJUST_AIEventName.Message, { taskId: task.taskId, ...message })

				if (message.message.partial !== true) {
					await this.fileLog(`[${new Date().toISOString()}] ${JSON.stringify(message.message, null, 2)}\n`)
				}
			})

			task.on(NJUST_AIEventName.TaskModeSwitched, (taskId: UnsafeAny, mode: UnsafeAny) => {
				this.emit(NJUST_AIEventName.TaskModeSwitched, taskId, mode)
			})

			task.on(NJUST_AIEventName.TaskAskResponded, () => {
				this.emit(NJUST_AIEventName.TaskAskResponded, task.taskId)
			})

			task.on(NJUST_AIEventName.QueuedMessagesUpdated, (taskId: UnsafeAny, messages: UnsafeAny) => {
				this.emit(NJUST_AIEventName.QueuedMessagesUpdated, taskId, messages)
			})

			task.on(NJUST_AIEventName.TaskToolFailed, (taskId: UnsafeAny, tool: UnsafeAny, error: UnsafeAny) => {
				this.emit(NJUST_AIEventName.TaskToolFailed, taskId, tool, error)
			})

			task.on(NJUST_AIEventName.TaskTokenUsageUpdated, (_: UnsafeAny, tokenUsage: UnsafeAny, toolUsage: UnsafeAny) => {
				this.emit(NJUST_AIEventName.TaskTokenUsageUpdated, task.taskId, tokenUsage, toolUsage)
			})

			this.emit(NJUST_AIEventName.TaskCreated, task.taskId)
		})
	}

	// Logging

	private outputChannelLog(...args: UnsafeAny[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): NJUST_AISettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: NJUST_AISettings) {
		await this.sidebarProvider.contextProxy.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		await this.sidebarProvider.postStateToWebview()
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, activate)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}
}
