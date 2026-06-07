import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { Package } from "../../shared/package"
import type { ClineAskResponse } from "../../shared/WebviewMessage"
import { applyCloudWorkspaceOps, applySingleCloudWorkspaceOp } from "../../services/cloud-agent/applyCloudWorkspaceOps"
import { buildCloudWorkspaceOpToolMessage } from "../../services/cloud-agent/buildCloudWorkspaceOpToolMessage"
import { CloudAgentClient } from "../../services/cloud-agent/CloudAgentClient"
import { executeDeferredToolCall } from "../../services/cloud-agent/executeDeferredToolCall"
import {
	CLOUD_AGENT_DEFERRED_MAX_ITERATIONS,
	CLOUD_AGENT_DEFERRED_MAX_DURATION_MS,
	CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX,
} from "../../services/cloud-agent/deferredConstants"
import { parseWorkspaceOps } from "../../services/cloud-agent/parseWorkspaceOps"
import { getProfileStorageService } from "../../services/cloud-agent/ProfileStorageService"
import type {
	CloudAgentCallbacks,
	CloudRunResult,
	DeferredResponse,
	DeferredToolCall,
	DeferredToolResult,
	WorkspaceOp,
} from "../../services/cloud-agent/types"
import type { CloudAgentProfile } from "../../services/cloud-agent/types/profile"
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
	constructor(private readonly host: ICloudAgentHost) {}

	async run(userMessage: string, images?: string[]): Promise<void> {
		// 1. 从 ProfileStorageService 获取活跃 Profile
		const profile = getProfileStorageService().getActiveProfile()
		if (!profile) {
			await this.host.say("error", "未配置 Cloud Agent Profile。请在设置中创建或选择一个 Profile。")
			return
		}

		// 2. 读取行为配置（全局设置）
		const behavior = readBehaviorConfig()

		const callbacks = makeCallbacks(this.host)
		const requestAbort = new AbortController()
		this.host.setCurrentRequestAbortController(requestAbort)

		const client = new CloudAgentClient(
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
		client: CloudAgentClient,
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
				`Cloud Agent 响应中的 workspace_ops 格式无效，已跳过本地写盘。校验信息：${runResult.workspaceOpsParseError}`,
			)
		}

		const ops = runResult.workspaceOps
		if (!behavior.applyRemoteWorkspaceOps && ops.length > 0) {
			await this.host.say(
				"text",
				`Cloud Agent 返回了 ${ops.length} 条可应用的 workspace_ops，但当前设置未开启「应用远程工作区操作」，因此不会在本地创建或修改文件。请在设置中启用 ${Package.name}.cloudAgent.applyRemoteWorkspaceOps（并可保留 ${Package.name}.cloudAgent.confirmRemoteWorkspaceOps 以在聊天界面中逐项确认）。`,
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
		client: CloudAgentClient,
		profile: CloudAgentProfile,
		behavior: BehaviorConfig,
		callbacks: CloudAgentCallbacks,
		userMessage: string,
		images?: string[],
	): Promise<void> {
		const maxIterations = CLOUD_AGENT_DEFERRED_MAX_ITERATIONS
		let hadWorkspaceOpsForCompile = false
		let lastNotifiedRunId: string | undefined
		let lastServerRevision: string | undefined
		let sessionRecoveries = 0

		await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent deferred/start" }))

		const startAbort = new AbortController()
		this.host.setCurrentRequestAbortController(startAbort)

		let deferredResp: DeferredResponse
		try {
			const startClient = new CloudAgentClient(
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
			if (Date.now() - loopStartTime > CLOUD_AGENT_DEFERRED_MAX_DURATION_MS) {
				const elapsedSec = Math.round((Date.now() - loopStartTime) / 1000)
				await this.host.say(
					"error",
					`[Deferred] 达到最大运行时长 (${elapsedSec}s > ${CLOUD_AGENT_DEFERRED_MAX_DURATION_MS / 1000}s)，已中止 Cloud Agent 会话。`,
				)
				await CloudAgentClient.sendDeferredAbort(
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

			const parsed = parseWorkspaceOps(deferredResp)
			const { operations: ops, error: workspaceOpsParseError } = parsed
			if (workspaceOpsParseError) {
				await this.host.say(
					"text",
					`Cloud Agent 响应中的 workspace_ops 无效，已跳过写盘。校验信息：${workspaceOpsParseError}`,
				)
			} else if (ops.length > 0 && behavior.applyRemoteWorkspaceOps) {
				const applied = await this.applyWorkspaceOps(ops, behavior.confirmRemoteWorkspaceOps)
				if (applied) {
					hadWorkspaceOpsForCompile = true
				}
			} else if (ops.length > 0) {
				await this.host.say(
					"text",
					`Cloud Agent 返回了 ${ops.length} 条 workspace_ops，但 applyRemoteWorkspaceOps 已关闭，跳过写盘。`,
				)
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
				const result = await executeDeferredToolCall(
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
				const msg = `Cloud Agent deferred/resume 无法继续：本轮 pending_tools 为 ${pendingTools.length} 条，本地仅生成 ${toolResults.length} 条 tool_results（请重试任务或更新插件）。`
				await this.host.say("error", msg)
				await this.host.ask("api_req_failed", msg)
				return
			}

			const runIdForResume = deferredResp.run_id
			if (!runIdForResume?.trim()) {
				const msg = "Cloud Agent deferred/resume 无法继续：缺少 run_id。"
				await this.host.say("error", msg)
				await this.host.ask("api_req_failed", msg)
				await CloudAgentClient.sendDeferredAbort(
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
				const resumeClient = new CloudAgentClient(
					makeCallbacks(this.host),
					makeClientOptions(profile, resumeAbort.signal, behavior.requestTimeoutMs),
				)
				deferredResp = await resumeClient.deferredResume(runIdForResume, this.host.taskId, toolResults)
				const nextRev = deferredResp.server_revision
				if (lastServerRevision !== undefined && nextRev !== undefined && nextRev !== lastServerRevision) {
					await this.host.say(
						"error",
						`[Deferred] 服务端 server_revision 已变更（${lastServerRevision} → ${nextRev}），为避免会话串线已中止。`,
					)
					await CloudAgentClient.sendDeferredAbort(
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
						`[Deferred] 服务端更新了 run_id（${lastNotifiedRunId.slice(0, 8)}… → ${deferredResp.run_id.slice(0, 8)}…），后续轮次将使用新会话上下文。`,
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
				if (status === 404 && sessionRecoveries < CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX) {
					sessionRecoveries++
					await this.host.say(
						"text",
						`[Deferred] 会话已过期（run_id ${runIdForResume.slice(0, 8)}…），正在自动恢复 (${sessionRecoveries}/${CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX})…`,
					)

					const restartAbort = new AbortController()
					this.host.setCurrentRequestAbortController(restartAbort)
					try {
						const restartClient = new CloudAgentClient(
							makeCallbacks(this.host),
							makeClientOptions(profile, restartAbort.signal, behavior.requestTimeoutMs),
						)
						deferredResp = await restartClient.deferredStart(
							this.host.taskId,
							`[自动恢复] 之前的 deferred 会话已过期（run_id ${runIdForResume.slice(0, 8)}…），请继续之前的任务。`,
							this.host.cwd,
						)
						lastNotifiedRunId = deferredResp.run_id
						lastServerRevision = deferredResp.server_revision
						await this.host.say(
							"text",
							`[Deferred] 会话已恢复，新的 run_id: ${(deferredResp.run_id ?? "").slice(0, 8)}…`,
						)
						continue
					} catch (restartError) {
						if (this.host.abort) break
						const restartMsg = getErrorMessage(restartError)
						await this.host.say("error", `[Deferred] 会话恢复失败: ${restartMsg}`)
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
					await CloudAgentClient.sendDeferredAbort(
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
			await this.host.say("error", `[Deferred] 达到最大迭代次数 (${maxIterations})，已中止 Cloud Agent 会话。`)
			await CloudAgentClient.sendDeferredAbort(
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

			const finalParsed = parseWorkspaceOps(deferredResp)
			if (finalParsed.error) {
				await this.host.say(
					"text",
					`Cloud Agent 最终响应中的 workspace_ops 无效，已跳过写盘。校验信息：${finalParsed.error}`,
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
				deferredResp.ok ? "Cloud Agent 任务完成。" : "Cloud Agent 任务结束（服务端报告未成功）。",
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
			const toolJson = await buildCloudWorkspaceOpToolMessage(this.host.cwd, op, { isWriteProtected })
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

			// Agent-facing prompt — intentionally kept in Chinese (not i18n'd) as it targets the LLM, not the UI.
			const fixGoal =
				`以下仓颉代码编译失败，请根据错误信息修正代码，返回修正后的 workspace_ops。` +
				`仅修改出错的文件，不要重复返回正确的文件。\n\n编译输出:\n${truncatedOutput}`

			await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent compile-fix iteration" }))

			const fixAbort = new AbortController()
			this.host.setCurrentRequestAbortController(fixAbort)

			let fixResult: CloudRunResult
			try {
				const fixClient = new CloudAgentClient(
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
				await this.host.say("error", `[Compile] 修正请求失败: ${msg}`)
				break
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}

			if (fixResult.workspaceOpsParseError) {
				await this.host.say(
					"text",
					`[Compile] 修正响应中的 workspace_ops 无效，停止编译反馈循环。校验信息：${fixResult.workspaceOpsParseError}`,
				)
				break
			}

			const fixOps = fixResult.workspaceOps
			if (fixOps.length === 0) {
				await this.host.say("text", "[Compile] Cloud Agent 未返回修正代码，停止编译反馈循环。")
				break
			}

			const applied = await this.applyWorkspaceOps(fixOps, confirmOps)
			if (!applied) {
				await this.host.say("error", "[Compile] 修正代码未能应用到本地，停止编译反馈循环。")
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
				const toolJson = await buildCloudWorkspaceOpToolMessage(this.host.cwd, op, { isWriteProtected })

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

				const single = await applySingleCloudWorkspaceOp(
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
			const applied = await applyCloudWorkspaceOps(
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
