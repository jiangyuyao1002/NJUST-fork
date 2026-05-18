export interface TaskDiffSaveResult {
	newProblemsMessage: string | undefined
	userEdits: string | undefined
	finalContent: string | undefined
}

export interface ITaskDiffViewProvider {
	newProblemsMessage?: string
	userEdits?: string
	editType?: "create" | "modify"
	isEditing: boolean
	originalContent: string | undefined

	open(relPath: string): Promise<void>
	update(accumulatedContent: string, isFinal: boolean): Promise<void>
	saveChanges(diagnosticsEnabled?: boolean, writeDelayMs?: number): Promise<TaskDiffSaveResult>
	saveDirectly(
		relPath: string,
		content: string,
		openFile?: boolean,
		diagnosticsEnabled?: boolean,
		writeDelayMs?: number,
	): Promise<TaskDiffSaveResult>
	pushToolWriteResult(task: UnsafeAny, cwd: string, isNewFile: boolean): Promise<string>
	revertChanges(): Promise<void>
	reset(): Promise<void>
	scrollToFirstDiff(): void
}

export class NullTaskDiffViewProvider implements ITaskDiffViewProvider {
	newProblemsMessage?: string
	userEdits?: string
	editType?: "create" | "modify"
	isEditing = false
	originalContent: string | undefined

	async open(): Promise<void> {}

	async update(): Promise<void> {}

	async saveChanges(): Promise<TaskDiffSaveResult> {
		return { newProblemsMessage: undefined, userEdits: undefined, finalContent: undefined }
	}

	async saveDirectly(_relPath: string, content: string): Promise<TaskDiffSaveResult> {
		return { newProblemsMessage: undefined, userEdits: undefined, finalContent: content }
	}

	async pushToolWriteResult(_task: UnsafeAny, _cwd: string, isNewFile: boolean): Promise<string> {
		return JSON.stringify({
			path: "",
			operation: isNewFile ? "created" : "modified",
			notice: "No diff view provider is attached to this task.",
		})
	}

	async revertChanges(): Promise<void> {
		this.isEditing = false
	}

	async reset(): Promise<void> {
		this.editType = undefined
		this.isEditing = false
		this.originalContent = undefined
		this.newProblemsMessage = undefined
		this.userEdits = undefined
	}

	scrollToFirstDiff(): void {}
}
