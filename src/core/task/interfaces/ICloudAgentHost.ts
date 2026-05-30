import type { ClineAsk, ClineSay } from "@njust-ai/types"

import type { ClineAskResponse } from "../../../shared/WebviewMessage"
import type { RooIgnoreController } from "../../ignore/RooIgnoreController"
import type { RooProtectedController } from "../../protect/RooProtectedController"

export interface ICloudAgentHost {
	readonly taskId: string
	readonly cwd: string
	readonly abort: boolean
	readonly rooIgnoreController?: RooIgnoreController
	readonly rooProtectedController?: RooProtectedController

	say(type: ClineSay, text?: string, images?: string[]): Promise<void>
	ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
	): Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
	}>
	emit(event: string, ...args: unknown[]): boolean

	setCurrentRequestAbortController(controller: AbortController | undefined): void

	/**
	 * Compile the local workspace using the Cangjie SDK (cjpm build).
	 * Called by CloudAgentOrchestrator when compileLoop is enabled.
	 * Should throw if the SDK is not available so the orchestrator can abort.
	 */
	compileLocal?(cwd: string): Promise<{ success: boolean; output: string }>
}
