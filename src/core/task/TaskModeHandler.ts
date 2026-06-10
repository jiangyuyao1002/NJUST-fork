import { NJUST_AIEventName, TelemetryEventName, type ProviderSettings, type HistoryItem } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import { defaultModeSlug } from "../../shared/modes"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import type { ITaskHost } from "./interfaces/ITaskHost"

export interface TaskModeHandlerHost {
	cancelCurrentRequest(): void
	updateApiConfiguration(config: ProviderSettings): void
}

export class TaskModeHandler {
	private _taskMode: string | undefined
	private _taskModeReady: Promise<void>
	private _taskApiConfigName: string | undefined
	private _taskApiConfigReady: Promise<void>
	private _providerProfileChangeListener?: (config: { name: string; provider?: string }) => void
	private _host: ITaskHost | undefined
	private readonly _taskHost: TaskModeHandlerHost

	constructor(taskHost: TaskModeHandlerHost) {
		this._taskHost = taskHost
		this._taskModeReady = Promise.resolve()
		this._taskApiConfigReady = Promise.resolve()
	}

	initializeFromHistory(historyItem: HistoryItem): void {
		this._taskMode = historyItem.mode || defaultModeSlug
		this._taskApiConfigName = historyItem.apiConfigName
		this._taskModeReady = Promise.resolve()
		this._taskApiConfigReady = Promise.resolve()
	}

	initializeAsync(host: ITaskHost): void {
		this._host = host
		this._taskMode = undefined
		this._taskApiConfigName = undefined
		this._taskModeReady = this.initializeTaskMode(host)
		this._taskApiConfigReady = this.initializeTaskApiConfigName(host)
	}

	private async initializeTaskMode(host: ITaskHost): Promise<void> {
		try {
			const state = await host.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			this._taskMode = defaultModeSlug
			const errorMessage = `Failed to initialize task mode: ${getErrorMessage(error)}`
			host.log(errorMessage)
		}
	}

	private async initializeTaskApiConfigName(host: ITaskHost): Promise<void> {
		try {
			const state = await host.getState()
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = "default"
			}
			const errorMessage = `Failed to initialize task API config name: ${getErrorMessage(error)}`
			host.log(errorMessage)
		}
	}

	setupListener(host: ITaskHost): void {
		this._host = host
		if (typeof host.on !== "function") {
			return
		}

		this._providerProfileChangeListener = async () => {
			this._taskHost.cancelCurrentRequest()
			try {
				const newState = await host.getState()
				if (newState?.apiConfiguration) {
					this._taskHost.updateApiConfiguration(newState.apiConfiguration)
				}
			} catch (error) {
				logger.error("TaskModeHandler", `Failed to update API configuration on profile change:`, error)
				TelemetryService.reportError(error, TelemetryEventName.TASK_LIFECYCLE_ERROR)
			}
		}

		host.on(NJUST_AIEventName.ProviderProfileChanged, this._providerProfileChangeListener)
	}

	async waitForModeInitialization(): Promise<void> {
		return this._taskModeReady
	}

	async getTaskMode(): Promise<string> {
		await this._taskModeReady
		return this._taskMode || defaultModeSlug
	}

	get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}
		return this._taskMode
	}

	setTaskMode(mode: string): void {
		this._taskMode = mode
	}

	async waitForApiConfigInitialization(): Promise<void> {
		return this._taskApiConfigReady
	}

	async getTaskApiConfigName(): Promise<string | undefined> {
		await this._taskApiConfigReady
		return this._taskApiConfigName
	}

	get taskApiConfigName(): string | undefined {
		return this._taskApiConfigName
	}

	setTaskApiConfigName(apiConfigName: string | undefined): void {
		this._taskApiConfigName = apiConfigName
	}

	get providerProfileChangeListener(): ((config: { name: string; provider?: string }) => void) | undefined {
		return this._providerProfileChangeListener
	}

	dispose(): void {
		if (this._providerProfileChangeListener && this._host) {
			this._host.off?.(NJUST_AIEventName.ProviderProfileChanged, this._providerProfileChangeListener)
			this._providerProfileChangeListener = undefined
		}
	}
}
