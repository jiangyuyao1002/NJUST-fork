import * as vscode from "vscode"
import { Package } from "../../shared/package"
import type { ClineAskResponse } from "../../shared/WebviewMessage"
import { applyCloudWorkspaceOps, applySingleCloudWorkspaceOp } from "../../services/cloud-agent/applyCloudWorkspaceOps"
import { buildCloudWorkspaceOpToolMessage } from "../../services/cloud-agent/buildCloudWorkspaceOpToolMessage"
import { CloudAgentClient } from "../../services/cloud-agent/CloudAgentClient"
import { executeDeferredToolCall } from "../../services/cloud-agent/executeDeferredToolCall"
import { CLOUD_AGENT_DEFERRED_MAX_ITERATIONS } from "../../services/cloud-agent/deferredConstants"
import { parseWorkspaceOps } from "../../services/cloud-agent/parseWorkspaceOps"
import { getDeviceToken } from "../../services/cloud-agent/deviceToken"
import type {
	CloudAgentCallbacks,
	CloudCompileResult,
	CloudRunResult,
	DeferredResponse,
	DeferredToolResult,
	WorkspaceOp,
} from "../../services/cloud-agent/types"
import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { AskIgnoredError } from "./AskIgnoredError"
import { NJUST_AI_CJEventName } from "@njust-ai-cj/types"
import { getErrorMessage } from "../../shared/error-utils"
import type { ICloudAgentHost } from "./interfaces/ICloudAgentHost"
import { TaskAbortedError } from "./TaskErrors"

export type { ICloudAgentHost } from "./interfaces/ICloudAgentHost"

interface CloudAgentConfig {
	serverUrl: string
	deviceToken: string
	apiKey: string
	requestTimeoutMs: number
	applyRemoteWorkspaceOps: boolean
	confirmRemoteWorkspaceOps: boolean
	useDeferredProtocol: boolean
	compileLoopEnabled: boolean
	compileMaxRetries: number
}

function readCloudAgentConfig(): CloudAgentConfig {
	const config = vscode.workspace.getConfiguration(Package.name)
	const serverUrl = (config.get<string>("cloudAgent.serverUrl", "") ?? "").trim()
	const deviceToken = getDeviceToken()
	let apiKey = (config.get<string>("cloudAgent.apiKey", "") ?? "").trim()
	if (!apiKey) {
		apiKey = (vscode.workspace.getConfiguration().get<string>(`${Package.name}.cloudAgent.apiKey`) ?? "").trim()
	}
	if (!apiKey) {
		apiKey = (process.env.CLOUD_AGENT_MOCK_API_KEY ?? process.env.NJUST_CLOUD_AGENT_API_KEY ?? "").trim()
	}

	if (serverUrl && !apiKey) {
		vscode.window
			.showWarningMessage(
				"Cloud Agent server is configured but no API Key is set. Configure njust-ai-cj.cloudAgent.apiKey in settings.",
				"Open Settings",
			)
			.then((choice) => {
				if (choice === "Open Settings") {
					void vscode.commands.executeCommand(
						"workbench.action.openSettings",
						"njust-ai-cj.cloudAgent.apiKey",
					)
				}
			})
	}

	return {
		serverUrl,
		deviceToken,
		apiKey,
		requestTimeoutMs: config.get<number>("cloudAgent.requestTimeoutMs", 0) ?? 0,
		applyRemoteWorkspaceOps: config.get<boolean>("cloudAgent.applyRemoteWorkspaceOps", true) ?? true,
		confirmRemoteWorkspaceOps: config.get<boolean>("cloudAgent.confirmRemoteWorkspaceOps", true) ?? true,
		useDeferredProtocol: config.get<boolean>("cloudAgent.deferredProtocol", true) ?? true,
		compileLoopEnabled: config.get<boolean>("cloudAgent.compileLoop.enabled", true) ?? true,
		compileMaxRetries: config.get<number>("cloudAgent.compileLoop.maxRetries", 3) ?? 3,
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

function makeClientOptions(cfg: CloudAgentConfig, signal: AbortSignal) {
	return {
		apiKey: cfg.apiKey || undefined,
		signal,
		requestTimeoutMs: cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : undefined,
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
		const cfg = readCloudAgentConfig()

		if (!cfg.serverUrl) {
			await this.host.say(
				"error",
				"Cloud Agent server URL is not configured. Set njust-ai-cj.cloudAgent.serverUrl (e.g. http://127.0.0.1:4000 for the local mock).",
			)
			return
		}
		if (!cfg.deviceToken) {
			await this.host.say("error", "Cloud Agent device token not found. Please restart VS Code.")
			return
		}

		const callbacks = makeCallbacks(this.host)
		const requestAbort = new AbortController()
		this.host.setCurrentRequestAbortController(requestAbort)

		const client = new CloudAgentClient(
			cfg.serverUrl,
			cfg.deviceToken,
			callbacks,
			makeClientOptions(cfg, requestAbort.signal),
		)
		this.host.emit(NJUST_AI_CJEventName.TaskStarted)

		if (cfg.useDeferredProtocol) {
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
			await this.runDeferredLoop(client, cfg, callbacks, userMessage, images)
			return
		}

		await this.runLegacy(client, cfg, callbacks, userMessage, images)
	}

	// ── Legacy single-shot /v1/run ──────────────────────────────────────

	private async runLegacy(
		client: CloudAgentClient,
		cfg: CloudAgentConfig,
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
		if (!cfg.applyRemoteWorkspaceOps && ops.length > 0) {
			await this.host.say(
				"text",
				`Cloud Agent 返回了 ${ops.length} 条可应用的 workspace_ops，但当前设置未开启「应用远程工作区操作」，因此不会在本地创建或修改文件。请在设置中启用 ${Package.name}.cloudAgent.applyRemoteWorkspaceOps（并可保留 ${Package.name}.cloudAgent.confirmRemoteWorkspaceOps 以在聊天界面中逐项确认）。`,
			)
		}

		if (cfg.applyRemoteWorkspaceOps && ops.length > 0) {
			await this.applyWorkspaceOps(ops, cfg.confirmRemoteWorkspaceOps)
		}

		if (cfg.compileLoopEnabled && cfg.applyRemoteWorkspaceOps && ops.length > 0 && !this.host.abort) {
			await this.runCompileFeedbackLoop(cfg, callbacks, cfg.compileMaxRetries, cfg.confirmRemoteWorkspaceOps)
		}
	}

	// ── Deferred protocol loop ──────────────────────────────────────────

	private async runDeferredLoop(
		client: CloudAgentClient,
		cfg: CloudAgentConfig,
		callbacks: CloudAgentCallbacks,
		userMessage: string,
		images?: string[],
	): Promise<void> {
		const maxIterations = CLOUD_AGENT_DEFERRED_MAX_ITERATIONS
		let hadWorkspaceOpsForCompile = false
		let lastNotifiedRunId: string | undefined
		let lastServerRevision: string | undefined

		await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent deferred/start" }))

		const startAbort = new AbortController()
		this.host.setCurrentRequestAbortController(startAbort)

		let deferredResp: DeferredResponse
		try {
			const startClient = new CloudAgentClient(
				cfg.serverUrl,
				cfg.deviceToken,
				makeCallbacks(this.host),
				makeClientOptions(cfg, startAbort.signal),
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
		while (deferredResp.status === "pending" && iteration < maxIterations && !this.host.abort) {
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
			} else if (ops.length > 0 && cfg.applyRemoteWorkspaceOps) {
				hadWorkspaceOpsForCompile = true
				await this.applyWorkspaceOps(ops, cfg.confirmRemoteWorkspaceOps)
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
				const result = await executeDeferredToolCall(this.host.cwd, call)
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
					cfg.serverUrl,
					cfg.deviceToken,
					cfg.apiKey || undefined,
					this.host.taskId,
					lastNotifiedRunId,
					cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : undefined,
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
					cfg.serverUrl,
					cfg.deviceToken,
					makeCallbacks(this.host),
					makeClientOptions(cfg, resumeAbort.signal),
				)
				deferredResp = await resumeClient.deferredResume(runIdForResume, this.host.taskId, toolResults)
				const nextRev = deferredResp.server_revision
				if (lastServerRevision !== undefined && nextRev !== undefined && nextRev !== lastServerRevision) {
					await this.host.say(
						"error",
						`[Deferred] 服务端 server_revision 已变更（${lastServerRevision} → ${nextRev}），为避免会话串线已中止。`,
					)
					await CloudAgentClient.sendDeferredAbort(
						cfg.serverUrl,
						cfg.deviceToken,
						cfg.apiKey || undefined,
						this.host.taskId,
						deferredResp.run_id,
						cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : undefined,
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
				const msg = getErrorMessage(error)
				await this.host.say("error", `Cloud Agent deferred/resume error: ${msg}`)
				await this.host.ask("api_req_failed", msg)
				await CloudAgentClient.sendDeferredAbort(
					cfg.serverUrl,
					cfg.deviceToken,
					cfg.apiKey || undefined,
					this.host.taskId,
					runIdForResume,
					cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : undefined,
				)
				return
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}
		}

		if (iteration >= maxIterations && deferredResp.status === "pending") {
			await this.host.say("error", `[Deferred] 达到最大迭代次数 (${maxIterations})，已中止 Cloud Agent 会话。`)
			await CloudAgentClient.sendDeferredAbort(
				cfg.serverUrl,
				cfg.deviceToken,
				cfg.apiKey || undefined,
				this.host.taskId,
				lastNotifiedRunId,
				cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : undefined,
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
			} else if (finalParsed.operations.length > 0 && cfg.applyRemoteWorkspaceOps) {
				hadWorkspaceOpsForCompile = true
				await this.applyWorkspaceOps(finalParsed.operations, cfg.confirmRemoteWorkspaceOps)
			}

			if (
				cfg.compileLoopEnabled &&
				cfg.applyRemoteWorkspaceOps &&
				hadWorkspaceOpsForCompile &&
				!this.host.abort
			) {
				await this.runCompileFeedbackLoop(cfg, callbacks, cfg.compileMaxRetries, cfg.confirmRemoteWorkspaceOps)
			}

			await this.host.say(
				"completion_result",
				deferredResp.ok ? "Cloud Agent 任务完成。" : "Cloud Agent 任务结束（服务端报告未成功）。",
			)
		}
	}

	// ── Compile feedback loop ───────────────────────────────────────────

	private async runCompileFeedbackLoop(
		cfg: CloudAgentConfig,
		callbacks: CloudAgentCallbacks,
		maxRetries: number,
		confirmOps: boolean,
	): Promise<void> {
		// maxRetries = maximum number of compile attempts (including the first). Fix rounds = maxRetries - 1 at most.
		for (let attempt = 1; attempt <= maxRetries && !this.host.abort; attempt++) {
			await this.host.say("text", `[Compile] 编译检查 (${attempt}/${maxRetries})...`)

			const compileAbort = new AbortController()
			this.host.setCurrentRequestAbortController(compileAbort)

			let compileResult: CloudCompileResult
			try {
				const compileClient = new CloudAgentClient(
					cfg.serverUrl,
					cfg.deviceToken,
					callbacks,
					makeClientOptions(cfg, compileAbort.signal),
				)
				compileResult = await compileClient.compile(this.host.taskId, this.host.cwd)
			} catch (error) {
				if (this.host.abort) break
				const msg = getErrorMessage(error)
				await this.host.say("error", `[Compile] 编译请求失败: ${msg}`)
				break
			} finally {
				this.host.setCurrentRequestAbortController(undefined)
			}

			if (compileResult.success) {
				await this.host.say("text", "[Compile] 编译通过!")
				break
			}

			const truncatedOutput =
				compileResult.output.length > 8000
					? compileResult.output.slice(0, 8000) + "\n...(output truncated)"
					: compileResult.output
			await this.host.say("text", `[Compile] 编译失败:\n\`\`\`\n${truncatedOutput}\n\`\`\``)

			if (attempt >= maxRetries) {
				await this.host.say("text", `[Compile] 已达最大重试次数 (${maxRetries})，停止编译反馈循环。`)
				break
			}

			const fixGoal =
				`以下仓颉代码编译失败，请根据错误信息修正代码，返回修正后的 workspace_ops。` +
				`仅修改出错的文件，不要重复返回正确的文件。\n\n编译输出:\n${truncatedOutput}`

			await this.host.say("api_req_started", JSON.stringify({ request: "Cloud Agent compile-fix iteration" }))

			const fixAbort = new AbortController()
			this.host.setCurrentRequestAbortController(fixAbort)

			let fixResult: CloudRunResult
			try {
				const fixClient = new CloudAgentClient(
					cfg.serverUrl,
					cfg.deviceToken,
					callbacks,
					makeClientOptions(cfg, fixAbort.signal),
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

			await this.applyWorkspaceOps(fixOps, confirmOps)
		}
	}

	// ── Workspace ops application ───────────────────────────────────────

	private async applyWorkspaceOps(ops: WorkspaceOp[], confirmOps: boolean): Promise<void> {
		if (confirmOps) {
			for (let i = 0; i < ops.length && !this.host.abort; i++) {
				const op = ops[i]!
				const accessAllowed = allowRooIgnorePathAccess(this.host.rooIgnoreController, op.path)
				if (!accessAllowed) {
					await this.host.say("rooignore_error", op.path)
					continue
				}
				const isWriteProtected = this.host.rooProtectedController?.isWriteProtected(op.path) || false
				const toolJson = await buildCloudWorkspaceOpToolMessage(this.host.cwd, op, { isWriteProtected })

				let response: ClineAskResponse
				try {
					const askResult = await this.host.ask("tool", toolJson, false)
					response = askResult.response
					if (askResult.text) {
						await this.host.say("user_feedback", askResult.text, askResult.images)
					}
				} catch (err) {
					if (err instanceof AskIgnoredError) break
					throw err
				}

				if (response !== "yesButtonClicked") {
					await this.host.say("text", `Skipped workspace op (${i + 1}/${ops.length}): ${op.path}`)
					continue
				}

				const single = await applySingleCloudWorkspaceOp(this.host.cwd, op)
				await this.host.say("text", single.message)
				if (!single.ok) {
					await this.host.say("error", `Workspace operation failed: ${single.message}`)
					break
				}
			}
		} else {
			const applied = await applyCloudWorkspaceOps(this.host.cwd, ops, () => this.host.abort)
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
			}
		}
	}
}
