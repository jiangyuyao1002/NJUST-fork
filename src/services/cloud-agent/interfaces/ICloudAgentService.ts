import type {
	CloudAgentCallbacks,
	CloudAgentClientOptions,
	CloudCompileResult,
	CloudRunResult,
	DeferredResponse,
	DeferredToolCall,
	DeferredToolResult,
	WorkspaceOp,
} from "../types"
import type { CloudAgentProfile } from "../types/profile"
import type { ApplyCloudWorkspaceOpsResult, CloudWorkspaceOpResult } from "../applyCloudWorkspaceOps"
import type { ParseWorkspaceOpsResult } from "../parseWorkspaceOps"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { RooProtectedController } from "../../../core/protect/RooProtectedController"

/**
 * Minimal client interface exposed to core/task code.
 * Implementations wrap the full CloudAgentClient class.
 */
export interface ICloudAgentClient {
	connect(): Promise<void>
	disconnect(sessionId?: string, runId?: string): Promise<void>
	submitTask(taskId: string, goal: string, cwd: string, images?: string[]): Promise<CloudRunResult>
	compile(sessionId: string, workspacePath?: string): Promise<CloudCompileResult>
	deferredStart(taskId: string, userMessage: string, cwd: string, images?: string[]): Promise<DeferredResponse>
	deferredResume(runId: string, taskId: string, toolResults: DeferredToolResult[]): Promise<DeferredResponse>
}

/**
 * Aggregated facade for all cloud-agent operations consumed by CloudAgentOrchestrator.
 * Keeps core/task decoupled from services/cloud-agent implementation details.
 */
export interface ICloudAgentService {
	getActiveProfile(): CloudAgentProfile | undefined

	createClient(callbacks: CloudAgentCallbacks, options: CloudAgentClientOptions): ICloudAgentClient

	sendDeferredAbort(
		profile: CloudAgentProfile,
		sessionId: string,
		runId?: string,
		requestTimeoutMs?: number,
	): Promise<void>

	parseWorkspaceOps(response: DeferredResponse): ParseWorkspaceOpsResult

	executeDeferredToolCall(
		cwd: string,
		call: DeferredToolCall,
		allowedCommands?: string[],
		deniedCommands?: string[],
		rooIgnoreController?: RooIgnoreController,
		rooProtectedController?: RooProtectedController,
	): Promise<DeferredToolResult>

	buildCloudWorkspaceOpToolMessage(
		cwd: string,
		op: WorkspaceOp,
		options: { isWriteProtected: boolean },
	): Promise<string>

	applySingleCloudWorkspaceOp(
		cwd: string,
		op: WorkspaceOp,
		rooIgnoreController?: RooIgnoreController,
		rooProtectedController?: RooProtectedController,
	): Promise<CloudWorkspaceOpResult>

	applyCloudWorkspaceOps(
		cwd: string,
		ops: WorkspaceOp[],
		isAborted?: () => boolean,
		rooIgnoreController?: RooIgnoreController,
		rooProtectedController?: RooProtectedController,
	): Promise<ApplyCloudWorkspaceOpsResult>

	readonly deferredConstants: {
		maxIterations: number
		maxDurationMs: number
		sessionRecoveryMax: number
	}
}
