import { CloudAgentClient } from "./CloudAgentClient"
import {
	applyCloudWorkspaceOps,
	applySingleCloudWorkspaceOp,
	type ApplyCloudWorkspaceOpsResult,
	type CloudWorkspaceOpResult,
} from "./applyCloudWorkspaceOps"
import { buildCloudWorkspaceOpToolMessage } from "./buildCloudWorkspaceOpToolMessage"
import {
	CLOUD_AGENT_DEFERRED_MAX_DURATION_MS,
	CLOUD_AGENT_DEFERRED_MAX_ITERATIONS,
	CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX,
} from "./deferredConstants"
import { executeDeferredToolCall } from "./executeDeferredToolCall"
import { getProfileStorageService } from "./ProfileStorageService"
import { parseWorkspaceOps, type ParseWorkspaceOpsResult } from "./parseWorkspaceOps"
import type {
	CloudAgentCallbacks,
	CloudAgentClientOptions,
	CloudCompileResult,
	CloudRunResult,
	DeferredResponse,
	DeferredToolCall,
	DeferredToolResult,
	WorkspaceOp,
} from "./types"
import type { CloudAgentProfile } from "./types/profile"
import type { IPathValidator, IWriteProtector } from "./interfaces/IPathAccessController"
import type { ICloudAgentClient, ICloudAgentService } from "./interfaces/ICloudAgentService"

/**
 * Thin adapter that exposes only the methods core/task needs.
 */
class CloudAgentClientAdapter implements ICloudAgentClient {
	constructor(private readonly client: CloudAgentClient) {}

	connect(): Promise<void> {
		return this.client.connect()
	}

	disconnect(sessionId?: string, runId?: string): Promise<void> {
		if (runId === undefined) {
			return this.client.disconnect(sessionId)
		}
		return this.client.disconnect(sessionId, runId)
	}

	submitTask(taskId: string, goal: string, cwd: string, images?: string[]): Promise<CloudRunResult> {
		return this.client.submitTask(taskId, goal, cwd, images)
	}

	compile(sessionId: string, workspacePath?: string): Promise<CloudCompileResult> {
		return this.client.compile(sessionId, workspacePath)
	}

	deferredStart(taskId: string, userMessage: string, cwd: string, images?: string[]): Promise<DeferredResponse> {
		return this.client.deferredStart(taskId, userMessage, cwd, images)
	}

	deferredResume(runId: string, taskId: string, toolResults: DeferredToolResult[]): Promise<DeferredResponse> {
		return this.client.deferredResume(runId, taskId, toolResults)
	}
}

/**
 * Default implementation of ICloudAgentService.
 * All operations delegate to existing functions and classes in services/cloud-agent.
 */
export class CloudAgentService implements ICloudAgentService {
	getActiveProfile(): CloudAgentProfile | undefined {
		return getProfileStorageService().getActiveProfile()
	}

	createClient(callbacks: CloudAgentCallbacks, options: CloudAgentClientOptions): ICloudAgentClient {
		const client = new CloudAgentClient(callbacks, options)
		return new CloudAgentClientAdapter(client)
	}

	sendDeferredAbort(
		profile: CloudAgentProfile,
		sessionId: string,
		runId?: string,
		requestTimeoutMs?: number,
	): Promise<void> {
		return CloudAgentClient.sendDeferredAbort(profile, sessionId, runId, requestTimeoutMs)
	}

	parseWorkspaceOps(response: DeferredResponse): ParseWorkspaceOpsResult {
		return parseWorkspaceOps(response)
	}

	executeDeferredToolCall(
		cwd: string,
		call: DeferredToolCall,
		allowedCommands?: string[],
		deniedCommands?: string[],
		pathValidator?: IPathValidator,
		writeProtector?: IWriteProtector,
	): Promise<DeferredToolResult> {
		return executeDeferredToolCall(cwd, call, allowedCommands, deniedCommands, pathValidator, writeProtector)
	}

	buildCloudWorkspaceOpToolMessage(
		cwd: string,
		op: WorkspaceOp,
		options: { isWriteProtected: boolean },
	): Promise<string> {
		return buildCloudWorkspaceOpToolMessage(cwd, op, options)
	}

	applySingleCloudWorkspaceOp(
		cwd: string,
		op: WorkspaceOp,
		pathValidator?: IPathValidator,
		writeProtector?: IWriteProtector,
	): Promise<CloudWorkspaceOpResult> {
		return applySingleCloudWorkspaceOp(cwd, op, pathValidator, writeProtector)
	}

	applyCloudWorkspaceOps(
		cwd: string,
		ops: WorkspaceOp[],
		isAborted?: () => boolean,
		pathValidator?: IPathValidator,
		writeProtector?: IWriteProtector,
	): Promise<ApplyCloudWorkspaceOpsResult> {
		return applyCloudWorkspaceOps(cwd, ops, isAborted, pathValidator, writeProtector)
	}

	get deferredConstants() {
		return {
			maxIterations: CLOUD_AGENT_DEFERRED_MAX_ITERATIONS,
			maxDurationMs: CLOUD_AGENT_DEFERRED_MAX_DURATION_MS,
			sessionRecoveryMax: CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX,
		}
	}
}
