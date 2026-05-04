/**
 * PendingEditManager manages pending edit operations with automatic timeout cleanup.
 *
 * This is used to track edit operations that are waiting for user confirmation
 * or other asynchronous processing. Each operation has a timeout to prevent
 * memory leaks from abandoned operations.
 */

export interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

export interface PendingEditData {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
}

export interface PendingEditManagerHost {
	log(message: string): void
}

export class PendingEditManager {
	private pendingOperations: Map<string, PendingEditOperation> = new Map()
	private static readonly PENDING_OPERATION_TIMEOUT_MS = 30000

	constructor(private host: PendingEditManagerHost) {}

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	set(operationId: string, editData: PendingEditData): void {
		this.clear(operationId)

		const timeoutId = setTimeout(() => {
			this.clear(operationId)
			this.host.log(`[PendingEditManager] Automatically cleared stale pending operation: ${operationId}`)
		}, PendingEditManager.PENDING_OPERATION_TIMEOUT_MS)

		this.pendingOperations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.host.log(`[PendingEditManager] Set pending operation: ${operationId}`)
	}

	/**
	 * Gets a pending edit operation by ID
	 */
	get(operationId: string): PendingEditOperation | undefined {
		return this.pendingOperations.get(operationId)
	}

	/**
	 * Clears a specific pending edit operation
	 */
	clear(operationId: string): boolean {
		const operation = this.pendingOperations.get(operationId)
		if (operation) {
			clearTimeout(operation.timeoutId)
			this.pendingOperations.delete(operationId)
			this.host.log(`[PendingEditManager] Cleared pending operation: ${operationId}`)
			return true
		}
		return false
	}

	/**
	 * Clears all pending edit operations
	 */
	clearAll(): void {
		for (const [operationId, operation] of this.pendingOperations) {
			clearTimeout(operation.timeoutId)
		}
		this.pendingOperations.clear()
		this.host.log(`[PendingEditManager] Cleared all pending operations`)
	}

	/**
	 * Dispose of all resources
	 */
	dispose(): void {
		this.clearAll()
	}
}
