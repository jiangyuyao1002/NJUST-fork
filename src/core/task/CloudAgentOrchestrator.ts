import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { Package } from "../../shared/package"
import type { ClineAskResponse } from "../../shared/WebviewMessage"
import type {
	CloudAgentCallbacks,
	CloudRunResult,
	DeferredResponse,
	DeferredToolCall,
	DeferredToolResult,
	WorkspaceOp,
} from "../../services/cloud-agent/types"
import type { CloudAgentProfile } from "../../services/cloud-agent/types/profile"
import type { ICloudAgentClient, ICloudAgentService } from "../../services/cloud-agent/interfaces/ICloudAgentService"
import { CloudAgentService } from "../../services/cloud-agent/CloudAgentService"
import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { AskIgnoredError } from "./AskIgnoredError"
import { NJUST_AIEventName } from "@njust-ai/types"
import { getErrorMessage } from "../../shared/error-utils"
import type { ICloudAgentHost } from "./interfaces/ICloudAgentHost"
import { TaskAbortedError } from "./TaskErrors"
import { t } from "../../i18n"

export type { ICloudAgentHost } from "./interfaces/ICloudAgentHost"

// ─── 行为配置（保留为全局 VS Code 设置）─────────────────────────────

interface BehaviorConfig {
	applyRemoteWorkspaceOps: boolean
	confirmRemoteWorkspaceOps: boolean
	useDeferredProtocol: boolean
	compileLoopEnabled: boolean
	compileMaxRetries: number
	requestTimeoutMs: number
	allowedCommands: string[]
	deniedCommands: string[]
}

function readBehaviorConfig(): BehaviorConfig {
	const config = vscode.workspace.getConfiguration(Package.name)
	return {
		applyRemoteWorkspaceOps: config.get<boolean>("cloudAgent.applyRemoteWorkspaceOps", true) ?? true,
		confirmRemoteWorkspaceOps: config.get<boolean>("cloudAgent.confirmRemoteWorkspaceOps", true) ?? true,
		useDeferredProtocol: config.get<boolean>("cloudAgent.deferredProtocol", true) ?? true,
		compileLoopEnabled: config.get<boolean>("cloudAgent.compileLoop.enabled", true) ?? true,
		compileMaxRetries: config.get<number>("cloudAgent.compileLoop.maxRetries", 3) ?? 3,
		requestTimeoutMs: config.get<number>("cloudAgent.requestTimeoutMs", 0) ?? 0,
		allowedCommands: config.get<string[]>("allowedCommands") ?? [],
		deniedCommands: config.get<string[]>("deniedCommands") ?? [],
	}
}

function makeCallbacks(host: ICloudAgentHost): CloudAgentCallbacks {
	return {
		onText: async (content) => host.say("text", content),
		onReasoning: async (content) => host.say("reasoning", content),
		onDone: async (summary) => {
			if (summary) await host.say("completion_result", summary)
		},
		onError: async (message) => host.say("error", message),
	}
}

function makeClientOptions(profile: CloudAgentProfile, signal: AbortSignal, requestTimeoutMs: number) {
	return {
		profile,
		signal,
		requestTimeoutMs: requestTimeoutMs > 0 ? requestTimeoutMs : undefined,
	}
}

/**
 * Encapsulates the Cloud Agent REST orchestration that was previously inline
 * in Task.ts (~600 lines). The host interface keeps this decoupled from the
 * full Task surface area.
 */
export class CloudAgentOrchestrator {
	constructor(
		private readonly host: ICloudAgentHost,
		private readonly service: ICloudAgentService = new CloudAgentService(),
	) {}

	async run(userMessage: string, images?: string[]): Promise<void> {
		// 1. 从 ProfileStorageService 获取活跃 Profile
		const profile = this.service.getActiveProfile()
		if (!profile) {
			await this.host.say("error", t("errors.cloud_agent.profile_not_configured"))
			return
		}

		// 2. 读取行为配置（全局设置）
		const behavior = readBehaviorConfig()

		const callbacks = makeCallbacks(this.host)
		const requestAbort = new AbortController()
		this.host.setCurrentRequestAbortController(requestAbort)

		const client = this.service.createClient(
			callbacks,
			makeClientOptions(profile, requestAbort.signal, behavior.requestTimeoutMs),
		)
		this.host.emit(NJUST_AIEventName.TaskStarted)

		// MCP 协议强制走 legacy 路径（submit_task 在服务器端内聚 deferred 逻辑）
		if (behavior.useDeferredProtocol && profile.protocolType !== "mcp") {
			try {
				await client.connect()
			} catch (error) {
				if (this.host.abort) return
				const msg = getErrorMessage(error)
				await this.host.say("error", `Cloud Agent connect error: ${msg}`)
				await this.host.ask("api_req_failed", msg)
				return
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}
			await this.runDeferredLoop(client, profile, behavior, callbacks, userMessage, images)
			return
		}

		await this.runLegacy(client, profile, behavior, callbacks, userMessage, images)
	}

	// ── Legacy single-shot /v1/run ──────────────────────────────────────

	private async runLegacy(
		client: ICloudAgentClient,
		profile: CloudAgentProfile,
		behavior: BehaviorConfig,
		callbacks: CloudAgentCallbacks,
		userMessage: string,
		images?: string[],
	): Promise<void> {
		await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent task submitted" }))

		let runResult: CloudRunResult | undefined
		try {
			await client.connect()
			runResult = await client.submitTask(this.host.taskId, userMessage, this.host.cwd, images)
			await this.host.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: runResult.tokensIn,
					tokensOut: runResult.tokensOut,
					cost: runResult.cost,
				}),
			)
		} catch (error) {
			if (this.host.abort) return
			const isAbort =
				error instanceof TaskAbortedError ||
				(error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message)))
			if (isAbort) {
				const errorMsg = getErrorMessage(error)
				await this.host.say("error", `Cloud Agent request was cancelled or timed out: ${errorMsg}`)
				await this.host.ask("api_req_failed", errorMsg)
				return
			}
			const errorMsg = getErrorMessage(error)
			await this.host.say("error", `Cloud Agent error: ${errorMsg}`)
			await this.host.ask("api_req_failed", errorMsg)
		} finally {
			this.host.setCurrentRequestAbortController(undefined)
			await client.disconnect(this.host.taskId)
		}

		if (this.host.abort || !runResult) return

		if (runResult.workspaceOpsParseError) {
			await this.host.say(
				"text",
				t("errors.cloud_agent.workspace_ops_invalid", { validationMessage: runResult.workspaceOpsParseError }),
			)
		}

		const ops = runResult.workspaceOps
		if (!behavior.applyRemoteWorkspaceOps && ops.length > 0) {
			await this.host.say(
				"text",
				t("info.cloud_agent.ops_not_enabled", {
					count: ops.length,
					packageName: Package.name,
				}),
			)
		}

		if (behavior.applyRemoteWorkspaceOps && ops.length > 0) {
			const applied = await this.applyWorkspaceOps(ops, behavior.confirmRemoteWorkspaceOps)
			if (behavior.compileLoopEnabled && applied && !this.host.abort) {
				await this.runCompileFeedbackLoop(
					profile,
					behavior,
					callbacks,
					behavior.compileMaxRetries,
					behavior.confirmRemoteWorkspaceOps,
				)
			}
		}
	}

	// ── Deferred protocol loop ──────────────────────────────────────────

	private async runDeferredLoop(
		client: ICloudAgentClient,
		profile: CloudAgentProfile,
		behavior: BehaviorConfig,
		callbacks: CloudAgentCallbacks,
		userMessage: string,
		images?: string[],
	): Promise<void> {
		const maxIterations = this.service.deferredConstants.maxIterations
		let hadWorkspaceOpsForCompile = false
		let lastNotifiedRunId: string | undefined
		let lastServerRevision: string | undefined
		let sessionRecoveries = 0

		await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent deferred/start" }))

		const startAbort = new AbortController()
		this.host.setCurrentRequestAbortController(startAbort)

		let deferredResp: DeferredResponse
		try {
			const startClient = this.service.createClient(
				makeCallbacks(this.host),
				makeClientOptions(profile, startAbort.signal, behavior.requestTimeoutMs),
			)
			deferredResp = await startClient.deferredStart(this.host.taskId, userMessage, this.host.cwd, images)
			await this.host.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: deferredResp.tokens_in ?? 0,
					tokensOut: deferredResp.tokens_out ?? 0,
					cost: deferredResp.cost ?? 0,
				}),
			)
		} catch (error) {
			if (this.host.abort) return
			const msg = getErrorMessage(error)
			await this.host.say("error", `Cloud Agent deferred/start error: ${msg}`)
			await this.host.ask("api_req_failed", msg)
			return
		} finally {
			this.host.setCurrentRequestAbortController(undefined)
		}

		lastNotifiedRunId = deferredResp.run_id
		lastServerRevision = deferredResp.server_revision

		let iteration = 0
		const loopStartTime = Date.now()
		while (deferredResp.status === "pending" && iteration < maxIterations && !this.host.abort) {
			// Wall-clock upper limit check: break if the deferred loop has run too long.
			if (Date.now() - loopStartTime > this.service.deferredConstants.maxDurationMs) {
				const elapsedSec = Math.round((Date.now() - loopStartTime) / 1000)
				await this.host.say(
					"error",
					t("errors.cloud_agent.max_duration_reached", {
						elapsed: elapsedSec,
						max: this.service.deferredConstants.maxDurationMs / 1000,
					}),
				)
				await this.service.sendDeferredAbort(
					profile,
					this.host.taskId,
					lastNotifiedRunId,
					behavior.requestTimeoutMs > 0 ? behavior.requestTimeoutMs : undefined,
				)
				break
			}
			iteration++

			if (deferredResp.text) await this.host.say("text", deferredResp.text)
			if (deferredResp.reasoning) await this.host.say("reasoning", deferredResp.reasoning)
			for (const log of deferredResp.logs ?? []) {
				await this.host.say("text", log)
			}

			const parsed = this.service.parseWorkspaceOps(deferredResp)
			const { operations: ops, error: workspaceOpsParseError } = parsed
			if (workspaceOpsParseError) {
				await this.host.say(
					"text",
					t("errors.cloud_agent.workspace_ops_invalid_deferred", {
						validationMessage: workspaceOpsParseError,
					}),
				)
			} else if (ops.length > 0 && behavior.applyRemoteWorkspaceOps) {
				const applied = await this.applyWorkspaceOps(ops, behavior.confirmRemoteWorkspaceOps)
				if (applied) {
					hadWorkspaceOpsForCompile = true
				}
			} else if (ops.length > 0) {
				await this.host.say("text", t("info.cloud_agent.ops_skipped", { count: ops.length }))
			}

			const toolResults: DeferredToolResult[] = []
			const pendingTools = deferredResp.pending_tools ?? []
			for (const call of pendingTools) {
				if (this.host.abort) break
				await this.host.say("text", `[Deferred] executing tool: ${call.tool} (${call.call_id})`)
				const approvalResult = await this.approveDeferredToolCall(call)
				if (approvalResult) {
					toolResults.push(approvalResult)
					if (approvalResult.is_error) {
						await this.host.say(
							"text",
							`[Deferred] tool ${call.tool} error: ${approvalResult.content.slice(0, 500)}`,
						)
					}
					continue
				}
				const result = await this.service.executeDeferredToolCall(
					this.host.cwd,
					call,
					behavior.allowedCommands,
					behavior.deniedCommands,
					this.host.rooIgnoreController,
					this.host.rooProtectedController,
				)
				toolResults.push(result)
				if (result.is_error) {
					await this.host.say("text", `[Deferred] tool ${call.tool} error: ${result.content.slice(0, 500)}`)
				}
			}

			if (this.host.abort) break

			if (pendingTools.length > 0 && toolResults.length !== pendingTools.length) {
				const msg = t("errors.cloud_agent.pending_tools_mismatch", {
					pending: pendingTools.length,
					results: toolResults.length,
				})
				await this.host.say("error", msg)
				await this.host.ask("api_req_failed", msg)
				return
			}

			const runIdForResume = deferredResp.run_id
			if (!runIdForResume?.trim()) {
				const msg = t("errors.cloud_agent.missing_run_id")
				await this.host.say("error", msg)
				await this.host.ask("api_req_failed", msg)
				await this.service.sendDeferredAbort(
					profile,
					this.host.taskId,
					lastNotifiedRunId,
					behavior.requestTimeoutMs > 0 ? behavior.requestTimeoutMs : undefined,
				)
				return
			}

			await this.host.say(
				"api_req_started",
				JSON.stringify({ request: `Cloud Agent deferred/resume (iteration ${iteration})` }),
			)

			const resumeAbort = new AbortController()
			this.host.setCurrentRequestAbortController(resumeAbort)

			try {
				const resumeClient = this.service.createClient(
					makeCallbacks(this.host),
					makeClientOptions(profile, resumeAbort.signal, behavior.requestTimeoutMs),
				)
				deferredResp = await resumeClient.deferredResume(runIdForResume, this.host.taskId, toolResults)
				const nextRev = deferredResp.server_revision
				if (lastServerRevision !== undefined && nextRev !== undefined && nextRev !== lastServerRevision) {
					await this.host.say(
						"error",
						t("errors.cloud_agent.server_revision_changed", {
							old: lastServerRevision,
							new: nextRev,
						}),
					)
					await this.service.sendDeferredAbort(
						profile,
						this.host.taskId,
						deferredResp.run_id,
						behavior.requestTimeoutMs > 0 ? behavior.requestTimeoutMs : undefined,
					)
					return
				}
				if (nextRev !== undefined) {
					lastServerRevision = nextRev
				}
				if (deferredResp.run_id && lastNotifiedRunId && deferredResp.run_id !== lastNotifiedRunId) {
					await this.host.say(
						"text",
						t("info.cloud_agent.run_id_updated", {
							old: lastNotifiedRunId.slice(0, 8),
							new: deferredResp.run_id.slice(0, 8),
						}),
					)
				}
				lastNotifiedRunId = deferredResp.run_id
				await this.host.say(
					"api_req_finished",
					JSON.stringify({
						tokensIn: deferredResp.tokens_in ?? 0,
						tokensOut: deferredResp.tokens_out ?? 0,
						cost: deferredResp.cost ?? 0,
					}),
				)
			} catch (error) {
				if (this.host.abort) break
				const status = (error as Error & { status?: number }).status
				if (status === 404 && sessionRecoveries < this.service.deferredConstants.sessionRecoveryMax) {
					sessionRecoveries++
					await this.host.say(
						"text",
						t("info.cloud_agent.session_expired", {
							runId: runIdForResume.slice(0, 8),
							current: sessionRecoveries,
							max: this.service.deferredConstants.sessionRecoveryMax,
						}),
					)

					const restartAbort = new AbortController()
					this.host.setCurrentRequestAbortController(restartAbort)
					try {
						const restartClient = this.service.createClient(
							makeCallbacks(this.host),
							makeClientOptions(profile, restartAbort.signal, behavior.requestTimeoutMs),
						)
						deferredResp = await restartClient.deferredStart(
							this.host.taskId,
							t("tools.deferred_session_recovery", { runId: runIdForResume.slice(0, 8) }),
							this.host.cwd,
						)
						lastNotifiedRunId = deferredResp.run_id
						lastServerRevision = deferredResp.server_revision
						await this.host.say(
							"text",
							t("info.cloud_agent.session_recovered", {
								runId: (deferredResp.run_id ?? "").slice(0, 8),
							}),
						)
						continue
					} catch (restartError) {
						if (this.host.abort) break
						const restartMsg = getErrorMessage(restartError)
						await this.host.say(
							"error",
							t("errors.cloud_agent.session_recovery_failed", { msg: restartMsg }),
						)
						await this.host.ask("api_req_failed", restartMsg)
						return
					} finally {
						this.host.setCurrentRequestAbortController(undefined)
					}
				}

				const msg = getErrorMessage(error)
				await this.host.say("error", `Cloud Agent deferred/resume error: ${msg}`)
				await this.host.ask("api_req_failed", msg)
				if (status !== 404) {
					await this.service.sendDeferredAbort(
						profile,
						this.host.taskId,
						runIdForResume,
						behavior.requestTimeoutMs > 0 ? behavior.requestTimeoutMs : undefined,
					)
				}
				return
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}
		}

		if (iteration >= maxIterations && deferredResp.status === "pending") {
			await this.host.say("error", t("errors.cloud_agent.max_iterations_reached", { max: maxIterations }))
			await this.service.sendDeferredAbort(
				profile,
				this.host.taskId,
				lastNotifiedRunId,
				behavior.requestTimeoutMs > 0 ? behavior.requestTimeoutMs : undefined,
			)
		}

		if (deferredResp.status === "done") {
			if (deferredResp.text) await this.host.say("text", deferredResp.text)
			if (deferredResp.reasoning) await this.host.say("reasoning", deferredResp.reasoning)
			for (const log of deferredResp.logs ?? []) {
				await this.host.say("text", log)
			}
			if (deferredResp.memory_summary) {
				await this.host.say("text", deferredResp.memory_summary)
			}

			const finalParsed = this.service.parseWorkspaceOps(deferredResp)
			if (finalParsed.error) {
				await this.host.say(
					"text",
					t("errors.cloud_agent.final_workspace_ops_invalid", { validationMessage: finalParsed.error }),
				)
			} else if (finalParsed.operations.length > 0 && behavior.applyRemoteWorkspaceOps) {
				const applied = await this.applyWorkspaceOps(finalParsed.operations, behavior.confirmRemoteWorkspaceOps)
				if (applied) {
					hadWorkspaceOpsForCompile = true
				}
			}

			if (
				behavior.compileLoopEnabled &&
				behavior.applyRemoteWorkspaceOps &&
				hadWorkspaceOpsForCompile &&
				!this.host.abort
			) {
				await this.runCompileFeedbackLoop(
					profile,
					behavior,
					callbacks,
					behavior.compileMaxRetries,
					behavior.confirmRemoteWorkspaceOps,
				)
			}

			await this.host.say(
				"completion_result",
				deferredResp.ok ? t("info.cloud_agent.task_completed") : t("errors.cloud_agent.task_failed"),
			)
		}
	}

	private getDeferredStringArg(call: DeferredToolCall, key: string): string | undefined {
		const val = call.arguments[key]
		return typeof val === "string" ? val : undefined
	}

	private getWorkspaceOpFromDeferredTool(call: DeferredToolCall): WorkspaceOp | undefined {
		if (call.tool === "write_file") {
			const path = this.getDeferredStringArg(call, "path")
			const content = this.getDeferredStringArg(call, "content")
			if (!path || content === undefined) return undefined
			return { op: "write_file", path, content }
		}

		if (call.tool === "apply_diff") {
			const path = this.getDeferredStringArg(call, "path")
			const diff = this.getDeferredStringArg(call, "diff")
			if (!path || diff === undefined) return undefined
			return { op: "apply_diff", path, diff }
		}

		return undefined
	}

	private async approveDeferredToolCall(call: DeferredToolCall): Promise<DeferredToolResult | undefined> {
		if (call.tool === "write_file" || call.tool === "apply_diff") {
			const op = this.getWorkspaceOpFromDeferredTool(call)
			if (!op) return undefined

			const accessAllowed = allowRooIgnorePathAccess(this.host.rooIgnoreController, op.path)
			if (!accessAllowed) {
				return { call_id: call.call_id, content: `Access denied by .rooignore: ${op.path}`, is_error: true }
			}

			const isWriteProtected = (await this.host.rooProtectedController?.isWriteProtected(op.path)) || false
			const toolJson = await this.service.buildCloudWorkspaceOpToolMessage(this.host.cwd, op, {
				isWriteProtected,
			})
			const askResult = await this.host.ask("tool", toolJson, false)
			if (askResult.text) {
				await this.host.say("user_feedback", askResult.text, askResult.images)
			}
			if (askResult.response !== "yesButtonClicked") {
				return {
					call_id: call.call_id,
					content: `Deferred tool rejected by user: ${call.tool}`,
					is_error: true,
				}
			}

			return undefined
		}

		if (call.tool === "execute_command") {
			const command = this.getDeferredStringArg(call, "command")
			if (!command) return undefined

			const blockedPath = this.host.rooIgnoreController?.validateCommand(command)
			if (blockedPath) {
				return {
					call_id: call.call_id,
					content: `Access denied by .rooignore: ${blockedPath}`,
					is_error: true,
				}
			}

			const askResult = await this.host.ask("command", command, false)
			if (askResult.text) {
				await this.host.say("user_feedback", askResult.text, askResult.images)
			}
			if (askResult.response !== "yesButtonClicked") {
				return {
					call_id: call.call_id,
					content: `Deferred tool rejected by user: ${call.tool}`,
					is_error: true,
				}
			}
		}

		return undefined
	}

	// ── Compile feedback loop ───────────────────────────────────────────

	private async runCompileFeedbackLoop(
		profile: CloudAgentProfile,
		behavior: BehaviorConfig,
		callbacks: CloudAgentCallbacks,
		maxRetries: number,
		confirmOps: boolean,
	): Promise<void> {
		if (!this.host.compileLocal) {
			await this.host.say("error", t("common:info.cangjieCompileGuard.feedbackLoopNotConfigured"))
			return
		}

		const compileCwd = this.resolveCjpmRoot(this.host.cwd)
		if (!compileCwd) {
			await this.host.say("text", t("common:info.cangjieCompileGuard.noCjpmToml"))
			return
		}

		// maxRetries = maximum number of compile attempts (including the first). Fix rounds = maxRetries - 1 at most.
		for (let attempt = 1; attempt <= maxRetries && !this.host.abort; attempt++) {
			await this.host.say("text", t("common:info.cangjieCompileGuard.compileCheck", { attempt, maxRetries }))

			let compileResult: { success: boolean; output: string }
			try {
				compileResult = await this.host.compileLocal(compileCwd)
			} catch (error) {
				if (this.host.abort) break
				const msg = getErrorMessage(error)
				await this.host.say("error", t("common:errors.cangjieCompileGuard.compileFailed", { msg }))
				break
			}

			if (compileResult.success) {
				await this.host.say("text", t("common:info.cangjieCompileGuard.compileSuccess"))
				break
			}

			let outputForAgent = compileResult.output
			if (!outputForAgent.trim()) {
				outputForAgent = t("common:errors.cangjieCompileGuard.noOutput")
			}
			const truncatedOutput =
				outputForAgent.length > 8000
					? outputForAgent.slice(0, 8000) + "\n...(output truncated)"
					: outputForAgent
			await this.host.say(
				"text",
				t("common:errors.cangjieCompileGuard.compileFailed", { msg: `\n\`\`\`\n${truncatedOutput}\n\`\`\`` }),
			)

			if (attempt >= maxRetries) {
				await this.host.say("text", t("common:info.cangjieCompileGuard.maxRetriesReached", { maxRetries }))
				break
			}

			const fixGoal =
				t("tools.compile_fix_goal_prefix") +
				"\n\n" +
				t("tools.compile_fix_goal_suffix", { output: truncatedOutput })

			await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent compile-fix iteration" }))

			const fixAbort = new AbortController()
			this.host.setCurrentRequestAbortController(fixAbort)

			let fixResult: CloudRunResult
			try {
				const fixClient = this.service.createClient(
					callbacks,
					makeClientOptions(profile, fixAbort.signal, behavior.requestTimeoutMs),
				)
				fixResult = await fixClient.submitTask(this.host.taskId, fixGoal, this.host.cwd)
				await this.host.say(
					"api_req_finished",
					JSON.stringify({
						tokensIn: fixResult.tokensIn,
						tokensOut: fixResult.tokensOut,
						cost: fixResult.cost,
					}),
				)
			} catch (error) {
				if (this.host.abort) break
				const msg = getErrorMessage(error)
				await this.host.say("error", t("errors.cloud_agent.compile_fix_failed", { msg }))
				break
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}

			if (fixResult.workspaceOpsParseError) {
				await this.host.say(
					"text",
					t("errors.cloud_agent.compile_fix_ops_invalid", {
						validationMessage: fixResult.workspaceOpsParseError,
					}),
				)
				break
			}

			const fixOps = fixResult.workspaceOps
			if (fixOps.length === 0) {
				await this.host.say("text", t("info.cloud_agent.compile_no_fix"))
				break
			}

			const applied = await this.applyWorkspaceOps(fixOps, confirmOps)
			if (!applied) {
				await this.host.say("error", t("errors.cloud_agent.compile_fix_not_applied"))
				break
			}
		}
	}

	private resolveCjpmRoot(startDir: string): string | undefined {
		let dir = path.resolve(startDir)
		for (let i = 0; i < 20; i++) {
			if (fs.existsSync(path.join(dir, "cjpm.toml"))) return dir
			const parent = path.dirname(dir)
			if (parent === dir) break
			dir = parent
		}
		return undefined
	}

	// ── Workspace ops application ───────────────────────────────────────

	private async applyWorkspaceOps(ops: WorkspaceOp[], confirmOps: boolean): Promise<boolean> {
		if (confirmOps) {
			for (let i = 0; i < ops.length && !this.host.abort; i++) {
				const op = ops[i]!
				const accessAllowed = allowRooIgnorePathAccess(this.host.rooIgnoreController, op.path)
				if (!accessAllowed) {
					await this.host.say("rooignore_error", op.path)
					continue
				}
				const isWriteProtected = (await this.host.rooProtectedController?.isWriteProtected(op.path)) || false
				const toolJson = await this.service.buildCloudWorkspaceOpToolMessage(this.host.cwd, op, {
					isWriteProtected,
				})

				let response: ClineAskResponse
				try {
					const askResult = await this.host.ask("tool", toolJson, false)
					response = askResult.response
					if (askResult.text) {
						await this.host.say("user_feedback", askResult.text, askResult.images)
					}
				} catch (err) {
					if (err instanceof AskIgnoredError) return false
					throw err
				}

				if (response !== "yesButtonClicked") {
					await this.host.say("text", `Skipped workspace op (${i + 1}/${ops.length}): ${op.path}`)
					continue
				}

				const single = await this.service.applySingleCloudWorkspaceOp(
					this.host.cwd,
					op,
					this.host.rooIgnoreController,
					this.host.rooProtectedController,
				)
				await this.host.say("text", single.message)
				if (!single.ok) {
					await this.host.say("error", `Workspace operation failed: ${single.message}`)
					return false
				}
			}
		} else {
			const applied = await this.service.applyCloudWorkspaceOps(
				this.host.cwd,
				ops,
				() => this.host.abort,
				this.host.rooIgnoreController,
				this.host.rooProtectedController,
			)
			const lines = applied.results.map((r) => `${r.ok ? "OK" : "FAIL"} ${r.path}: ${r.message}`)
			const header = applied.ok
				? `workspace_ops applied (${applied.results.length} operation(s)).`
				: `workspace_ops stopped at operation ${(applied.failedAtIndex ?? 0) + 1} of ${ops.length}.`
			await this.host.say("text", [header, ...lines].join("\n"))
			if (!applied.ok) {
				await this.host.say(
					"error",
					`Workspace operation failed: ${applied.results.at(-1)?.message ?? "unknown"}`,
				)
				return false
			}
		}
		return true
	}
}
