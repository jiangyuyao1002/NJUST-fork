import type { CreateTaskOptions, HistoryItem, NJUST_AI_CJSettings } from "@njust-ai-cj/types"

import type { Task } from "../task/Task"

export interface TaskCoordinatorHost {
	getCurrentTask(): Task | undefined
	getTaskStackSize(): number
	getCurrentTaskStack(): string[]
	getRecentTasks(): string[]
	createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options?: CreateTaskOptions,
		configuration?: NJUST_AI_CJSettings,
	): Promise<Task>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	resumeTask(taskId: string): void
	createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	): Promise<Task>
}

export class TaskCoordinator {
	constructor(private readonly host: TaskCoordinatorHost) {}

	public getCurrentTask(): Task | undefined {
		return this.host.getCurrentTask()
	}

	public getTaskStackSize(): number {
		return this.host.getTaskStackSize()
	}

	public getCurrentTaskStack(): string[] {
		return this.host.getCurrentTaskStack()
	}

	public getRecentTasks(): string[] {
		return this.host.getRecentTasks()
	}

	public createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: NJUST_AI_CJSettings = {},
	): Promise<Task> {
		return this.host.createTask(text, images, parentTask, options, configuration)
	}

	public cancelTask(): Promise<void> {
		return this.host.cancelTask()
	}

	public clearTask(): Promise<void> {
		return this.host.clearTask()
	}

	public resumeTask(taskId: string): void {
		this.host.resumeTask(taskId)
	}

	public createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options: { startTask?: boolean } = {},
	): Promise<Task> {
		return this.host.createTaskWithHistoryItem(historyItem, options)
	}
}
