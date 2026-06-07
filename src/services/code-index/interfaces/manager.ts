import { VectorStoreSearchResult } from "./vector-store"
import * as vscode from "vscode"
import type { ContextProxy } from "../../../core/config/ContextProxy"

/**
 * Interface for the code index manager
 */
export interface ICodeIndexManager {
	/**
	 * Event emitted when progress is updated
	 */
	onProgressUpdate: vscode.Event<{
		systemStatus: IndexingState
		message: string
		processedItems: number
		totalItems: number
		currentItemUnit: string
	}>

	/**
	 * Current state of the indexing process
	 */
	readonly state: IndexingState

	/**
	 * Whether the code indexing feature is enabled
	 */
	readonly isFeatureEnabled: boolean

	/**
	 * Whether the code indexing feature is configured
	 */
	readonly isFeatureConfigured: boolean

	/**
	 * Whether indexing is enabled for the current workspace
	 */
	readonly isWorkspaceEnabled: boolean

	/**
	 * Starts the indexing process
	 */
	startIndexing(): Promise<void>

	/**
	 * Stops any in-progress indexing operation and the file watcher
	 */
	stopIndexing(): void

	/**
	 * Stops the file watcher
	 */
	stopWatcher(): void

	/**
	 * Clears the index data
	 */
	clearIndexData(): Promise<void>

	/**
	 * Searches the index
	 * @param query Query string
	 * @param limit Maximum number of results to return
	 * @returns Promise resolving to search results
	 */
	searchIndex(query: string, limit: number): Promise<VectorStoreSearchResult[]>

	/**
	 * Gets the current status of the indexing system
	 * @returns Current status information
	 */
	getCurrentStatus(): { systemStatus: IndexingState; fileStatuses: Record<string, string>; message?: string }

	/**
	 * Whether the manager has been initialized
	 */
	readonly isInitialized: boolean

	/**
	 * Initializes the manager with configuration
	 */
	initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }>

	/**
	 * Enables or disables indexing for the current workspace
	 */
	setWorkspaceEnabled(enabled: boolean): Promise<void>

	/**
	 * Sets the auto-enable default for new workspaces
	 */
	setAutoEnableDefault(enabled: boolean): Promise<void>

	/**
	 * Handles settings changes and recreates services if needed
	 */
	handleSettingsChange(): Promise<void>

	/**
	 * Disposes of resources used by the manager
	 */
	dispose(): void
}

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"
export type EmbedderProvider =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "mistral"
	| "vercel-ai-gateway"
	| "bedrock"
	| "openrouter"

export interface IndexProgressUpdate {
	systemStatus: IndexingState
	message?: string
	processedBlockCount?: number
	totalBlockCount?: number
}
