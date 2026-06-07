import { getErrorMessage } from "../../shared/error-utils"
import { parseWorkspaceOps } from "./parseWorkspaceOps"
import { logger } from "../../shared/logger"
import { ApiRetryExecutor, type ApiRetryOptions } from "../../api/retry/ApiRetryStrategy"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { analyzeErrorForRetry } from "../../api/retry/ApiErrorClassifier"
import type {
	CloudAgentCallbacks,
	CloudAgentClientOptions,
	CloudCompileResponse,
	CloudCompileResult,
	CloudRunResult,
	DeferredResponse,
	DeferredToolResult,
} from "./types"
import type { CloudAgentProfile } from "./types/profile"
import { AdapterFactory } from "./adapters/AdapterFactory"
import type { IProtocolAdapter, UniversalTaskResponse } from "./adapters/types"
import { McpProtocolAdapter, MCP_TOOLS } from "./adapters/McpProtocolAdapter"
import type { McpCallbackHandler } from "./adapters/McpProtocolAdapter"
import { normalizeServerUrl } from "./urlUtils"
import { t } from "../../i18n"

/** Maximum response body size (50 MB) before rejecting to avoid loading pathological payloads into memory. */
const MAX_RESPONSE_BODY_BYTES = 50 * 1024 * 1024

const CLOUD_AGENT_RETRY_OPTIONS: Partial<ApiRetryOptions> = {
	maxAttempts: 3,
	baseDelayMs: 2_000,
	maxDelayMs: 30_000,
	jitterRatio: 0.15,
}

function shouldRetryCloudAgent(error: UnsafeAny, _attempt: number): { retry: boolean; retryAfterSeconds?: number } {
	if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
		return { retry: false }
	}
	const decision = analyzeErrorForRetry(error)
	return { retry: decision.shouldRetry, retryAfterSeconds: decision.retryAfterSeconds }
}

/** Undici/Node often surfaces low-level failures as `fetch failed` with details on `error.cause`. */
function enrichFetchError(error: UnsafeAny): Error {
	if (!(error instanceof Error)) {
		return new Error(String(error))
	}
	const parts: string[] = [error.message]
	const c = (error as Error & { cause?: UnsafeAny }).cause
	if (c instanceof Error && c.message && !error.message.includes(c.message)) {
		parts.push(c.message)
	} else if (typeof c === "object" && c !== null && "code" in c) {
		const code = (c as { code?: UnsafeAny }).code
		if (code !== undefined) {
			parts.push(String(code))
		}
	}
	return parts.length > 1 ? new Error(parts.join(": ")) : error
}

function apiKeyHintFor401(status: number, bodySnippet: string): string {
	if (status !== 401 || !/X-API-Key|api_?key/i.test(bodySnippet)) {
		return ""
	}
	return (
		t("errors.cloud_agent.api_key_hint_401") +
		" or set process env CLOUD_AGENT_MOCK_API_KEY / NJUST_CLOUD_AGENT_API_KEY for the extension host (e.g. Njust-AI/.env). " +
		"Workspace .vscode/settings.json only applies when that folder is the workspace root."
	)
}

export class CloudAgentClient {
	/**
	 * Notify the server that the deferred session should be torn down (best-effort; does not throw).
	 * POST `/v1/run/deferred/abort` with `{ session_id, run_id? }`. Missing servers may return 404 — logged only.
	 */
	static async sendDeferredAbort(
		profile: CloudAgentProfile,
		sessionId: string,
		runId: string | undefined,
		requestTimeoutMs?: number,
	): Promise<void> {
		const base = normalizeServerUrl(profile.serverUrl)
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		if (requestTimeoutMs && requestTimeoutMs > 0) {
			timer = setTimeout(
				() => controller.abort(new DOMException("abort request timed out", "AbortError")),
				requestTimeoutMs,
			)
		}

		// 从 Profile 构建临时适配器以生成认证头
		const tempAdapter = AdapterFactory.create(profile)
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...tempAdapter.buildAuthHeaders(),
		}

		const body = JSON.stringify({
			session_id: sessionId,
			...(runId?.trim() ? { run_id: runId.trim() } : {}),
		})
		try {
			let resp: Response
			try {
				resp = await fetch(`${base}${tempAdapter.getEndpoint("deferredAbort")}`, {
					method: "POST",
					headers,
					body,
					signal: controller.signal,
				})
			} catch (e) {
				throw enrichFetchError(e)
			}
			if (resp.status === 404) {
				// Older servers — expected until upgraded.
				return
			}
			if (!resp.ok) {
				const t = await resp.text().catch(() => "")
				logger.warn("CloudAgentClient", `deferred/abort HTTP ${resp.status}: ${t.slice(0, 300)}`)
			}
		} catch (e) {
			const msg = getErrorMessage(e)
			logger.warn("CloudAgentClient", `deferred/abort failed: ${msg}`)
			TelemetryService.reportError(e instanceof Error ? e : new Error(msg), TelemetryEventName.UTILITY_ERROR)
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private serverUrl: string
	private callbacks: CloudAgentCallbacks
	private readonly options: CloudAgentClientOptions
	private readonly retryExecutor = new ApiRetryExecutor(CLOUD_AGENT_RETRY_OPTIONS)
	private readonly adapter: IProtocolAdapter

	constructor(callbacks: CloudAgentCallbacks, options: CloudAgentClientOptions) {
		this.callbacks = callbacks
		this.options = options

		const profile = options.profile
		this.serverUrl = normalizeServerUrl(profile.serverUrl)

		if (!this.serverUrl?.trim()) {
			throw new Error(t("errors.cloud_agent.server_url_empty"))
		}

		// HTTPS 校验
		const url = new URL(this.serverUrl)
		if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
			throw new Error("Cloud Agent requires HTTPS for non-localhost connections")
		}

		// 创建并初始化适配器
		this.adapter = AdapterFactory.create(profile)

		if (this.adapter.protocolType === "mcp") {
			;(this.adapter as McpProtocolAdapter).setCallbackHandler(this.createMcpCallbackHandler())
		}
	}

	private createMcpCallbackHandler(): McpCallbackHandler {
		return {
			onText: async (content) => this.callbacks.onText(content),
			onReasoning: async (content) => this.callbacks.onReasoning(content),
			onDone: async (summary) => this.callbacks.onDone(summary),
			onError: async (message) => this.callbacks.onError(message),
		}
	}

	private mergeAbortAndTimeout(): { signal?: AbortSignal; cleanup: () => void } {
		const baseSignal = this.options?.signal
		const timeoutMs = this.options?.requestTimeoutMs
		const hasTimeout = !!(timeoutMs && timeoutMs > 0)

		if (!hasTimeout && !baseSignal) {
			return { cleanup: () => {} }
		}
		if (!hasTimeout && baseSignal) {
			return { signal: baseSignal, cleanup: () => {} }
		}

		const controller = new AbortController()
		const cleanups: (() => void)[] = []

		if (hasTimeout) {
			const id = setTimeout(() => {
				controller.abort(new DOMException("Cloud Agent request timed out", "AbortError"))
			}, timeoutMs!)
			cleanups.push(() => clearTimeout(id))
		}

		if (baseSignal) {
			if (baseSignal.aborted) {
				controller.abort(baseSignal.reason)
			} else {
				const onAbort = () => controller.abort(baseSignal.reason)
				baseSignal.addEventListener("abort", onAbort, { once: true })
				cleanups.push(() => baseSignal.removeEventListener("abort", onAbort))
			}
		}

		return { signal: controller.signal, cleanup: () => cleanups.forEach((fn) => fn()) }
	}

	private buildHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			...this.adapter.buildAuthHeaders(),
		}
	}

	private async parseUniversalResponse(resp: Response): Promise<UniversalTaskResponse> {
		// Pre-check Content-Length to reject pathologically large bodies before loading into memory.
		const contentLength = resp.headers.get("content-length")
		if (contentLength) {
			const len = Number(contentLength)
			if (Number.isFinite(len) && len > MAX_RESPONSE_BODY_BYTES) {
				throw new Error(
					`Cloud Agent: response body too large (${(len / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_RESPONSE_BODY_BYTES / 1024 / 1024} MB limit)`,
				)
			}
		}
		const text = await resp.text()
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new Error(
				`Cloud Agent: response is not valid JSON (HTTP ${resp.status}): ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`,
			)
		}
		try {
			return this.adapter.parseResponseBody(parsed as Record<string, unknown>)
		} catch (e) {
			const hint = getErrorMessage(e)
			throw new Error(`Cloud Agent: invalid response payload (HTTP ${resp.status}): ${hint}`)
		}
	}

	async connect(): Promise<void> {
		if (this.adapter.protocolType === "mcp") {
			const { signal, cleanup } = this.mergeAbortAndTimeout()
			try {
				const connectPromise = this.adapter.connect()
				if (signal) {
					connectPromise.catch((e) =>
						logger.debug("CloudAgentClient", "MCP connect promise rejected during abort race:", e),
					)
					await Promise.race([
						connectPromise,
						new Promise<never>((_, reject) => {
							const onAbort = () => reject(new DOMException("MCP connect timed out", "AbortError"))
							if (signal.aborted) {
								onAbort()
							} else {
								signal.addEventListener("abort", onAbort, { once: true })
							}
						}),
					])
				} else {
					await connectPromise
				}
			} finally {
				cleanup()
			}
			return
		}

		// REST 健康检查（现有逻辑不变）
		const endpoint = this.adapter.getEndpoint("health")
		await this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				try {
					let resp: Response
					try {
						resp = await fetch(`${this.serverUrl}${endpoint}`, {
							method: "GET",
							...(signal ? { signal } : {}),
							headers: this.buildHeaders(),
						})
					} catch (e) {
						throw enrichFetchError(e)
					}
					if (!resp.ok) {
						const errText = await resp.text()
						const slice = errText.slice(0, 300)
						const err = new Error(
							`Cloud Agent health check failed: HTTP ${resp.status}: ${slice}${apiKeyHintFor401(resp.status, slice)}`,
						)
						;(err as Error & { status?: number }).status = resp.status
						throw err
					}
				} finally {
					cleanup()
				}
			},
			shouldRetryCloudAgent,
			(info) => logger.warn("CloudAgentClient", `connect retry #${info.attempt + 1} after ${info.delayMs}ms`),
		)
	}

	/**
	 * 在 MCP adapter 上执行操作。异常时自动释放连接。
	 * 成功路径的连接释放由调用者（CloudAgentOrchestrator.runLegacy 的 finally 块）负责。
	 */
	private async withMcpAdapter<T>(fn: (adapter: McpProtocolAdapter) => Promise<T>): Promise<T> {
		const mcpAdapter = this.adapter as McpProtocolAdapter
		try {
			return await fn(mcpAdapter)
		} catch (err) {
			await mcpAdapter
				.disconnect()
				.catch((e) => logger.debug("CloudAgentClient", "MCP disconnect failed during error cleanup:", e))
			throw err
		}
	}

	async submitTask(
		sessionId: string,
		message: string,
		workspacePath?: string,
		images?: string[],
	): Promise<CloudRunResult> {
		// 1. 适配器构建请求体
		const body = this.adapter.buildRequestBody({
			goal: message,
			sessionId,
			workspacePath,
			images,
		})

		let data: UniversalTaskResponse

		// 2. 根据协议类型选择调用方式
		if (this.adapter.protocolType === "mcp") {
			data = await this.withMcpAdapter((mcpAdapter) => mcpAdapter.callTool(MCP_TOOLS.SUBMIT_TASK, body))
		} else {
			// REST 路径（现有逻辑不变）
			const endpoint = this.adapter.getEndpoint("run")
			data = await this.retryExecutor.execute(
				async () => {
					const { signal, cleanup } = this.mergeAbortAndTimeout()
					let resp: Response
					try {
						try {
							resp = await fetch(`${this.serverUrl}${endpoint}`, {
								method: "POST",
								headers: this.buildHeaders(),
								body: JSON.stringify(body),
								...(signal ? { signal } : {}),
							})
						} catch (e) {
							throw enrichFetchError(e)
						}
					} finally {
						cleanup()
					}

					if (!resp.ok) {
						const errText = await resp.text()
						const slice = errText.slice(0, 500)
						const err = new Error(
							`Cloud Agent error (HTTP ${resp.status}): ${slice}${apiKeyHintFor401(resp.status, slice)}`,
						)
						;(err as Error & { status?: number }).status = resp.status
						throw err
					}

					return this.parseUniversalResponse(resp)
				},
				shouldRetryCloudAgent,
				(info) =>
					logger.warn("CloudAgentClient", `submitTask retry #${info.attempt + 1} after ${info.delayMs}ms`),
			)
		}

		// 3. 处理 workspace_ops（两种协议共用）
		const { operations: workspaceOps, error: workspaceOpsError } = parseWorkspaceOps(data.raw)
		if (workspaceOpsError !== undefined) {
			logger.warn("CloudAgentClient", `Invalid workspace_ops in /v1/run response: ${workspaceOpsError}`)
		}

		for (const log of data.logs || []) {
			await this.callbacks.onText(log)
		}

		if (data.memorySummary) {
			await this.callbacks.onText(data.memorySummary)
		}

		await this.callbacks.onDone(data.ok ? "Task completed" : "Task failed")

		return {
			memorySummary: data.memorySummary || "",
			tokensIn: data.tokensIn ?? 0,
			tokensOut: data.tokensOut ?? 0,
			cost: data.cost ?? 0,
			workspaceOps,
			workspaceOpsParseError: workspaceOpsError,
		}
	}

	/**
	 * Call POST /v1/run/compile to run cjc/cjpm build on the server side.
	 * Returns structured compile output (success flag + stdout/stderr).
	 */
	async compile(sessionId: string, workspacePath?: string): Promise<CloudCompileResult> {
		if (this.adapter.protocolType === "mcp") {
			return this.withMcpAdapter(async (mcpAdapter) => {
				const result = await mcpAdapter.callTool(MCP_TOOLS.COMPILE, {
					session_id: sessionId,
					workspace_path: workspacePath,
				})
				return mcpAdapter.parseCompileResponse(result.raw ?? {})
			})
		}

		// REST 路径（现有逻辑不变）
		const body = this.adapter.buildRequestBody({
			goal: "",
			sessionId,
			workspacePath,
		})

		const endpoint = this.adapter.getEndpoint("compile")
		return this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				let resp: Response
				try {
					try {
						resp = await fetch(`${this.serverUrl}${endpoint}`, {
							method: "POST",
							headers: this.buildHeaders(),
							body: JSON.stringify(body),
							...(signal ? { signal } : {}),
						})
					} catch (e) {
						throw enrichFetchError(e)
					}
				} finally {
					cleanup()
				}

				if (!resp.ok) {
					const errText = await resp.text()
					const slice = errText.slice(0, 500)
					const err = new Error(
						`Cloud Agent compile error (HTTP ${resp.status}): ${slice}${apiKeyHintFor401(resp.status, slice)}`,
					)
					;(err as Error & { status?: number }).status = resp.status
					throw err
				}

				const clHeader = resp.headers.get("content-length")
				if (clHeader) {
					const clLen = Number(clHeader)
					if (Number.isFinite(clLen) && clLen > MAX_RESPONSE_BODY_BYTES) {
						throw new Error(
							`Cloud Agent: compile response body too large (${(clLen / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_RESPONSE_BODY_BYTES / 1024 / 1024} MB limit)`,
						)
					}
				}
				const text = await resp.text()
				let data: CloudCompileResponse
				try {
					data = JSON.parse(text) as CloudCompileResponse
				} catch {
					throw new Error(
						`Cloud Agent: compile response is not valid JSON (HTTP ${resp.status}): ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`,
					)
				}

				return { success: data.success, output: data.output ?? "" }
			},
			shouldRetryCloudAgent,
			(info) => logger.warn("CloudAgentClient", `compile retry #${info.attempt + 1} after ${info.delayMs}ms`),
		)
	}

	// -------------------------------------------------------------------
	// Deferred execution protocol
	// -------------------------------------------------------------------

	private async fetchDeferred(endpoint: string, body: Record<string, UnsafeAny>): Promise<DeferredResponse> {
		return this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				let resp: Response
				try {
					try {
						resp = await fetch(`${this.serverUrl}${endpoint}`, {
							method: "POST",
							headers: this.buildHeaders(),
							body: JSON.stringify(body),
							...(signal ? { signal } : {}),
						})
					} catch (e) {
						throw enrichFetchError(e)
					}
				} finally {
					cleanup()
				}

				if (!resp.ok) {
					const errText = await resp.text()
					const slice = errText.slice(0, 500)
					const err = new Error(
						`Cloud Agent deferred error (HTTP ${resp.status}): ${slice}${apiKeyHintFor401(resp.status, slice)}`,
					)
					;(err as Error & { status?: number }).status = resp.status
					throw err
				}

				const universal = await this.parseUniversalResponse(resp)
				// 转换为 DeferredResponse（snake_case 字段名）
				return {
					run_id: universal.runId,
					status: universal.status,
					pending_tools: universal.pendingTools?.map((t) => ({
						call_id: t.callId,
						tool: t.tool,
						arguments: t.arguments,
					})),
					workspace_ops: universal.raw?.workspace_ops as UnsafeAny,
					text: universal.text,
					reasoning: universal.reasoning,
					ok: universal.ok,
					memory_summary: universal.memorySummary,
					logs: universal.logs,
					tokens_in: universal.tokensIn,
					tokens_out: universal.tokensOut,
					cost: universal.cost,
				}
			},
			shouldRetryCloudAgent,
			(info) =>
				logger.warn(
					"CloudAgentClient",
					`fetchDeferred(${endpoint}) retry #${info.attempt + 1} after ${info.delayMs}ms`,
				),
		)
	}

	async deferredStart(
		sessionId: string,
		message: string,
		workspacePath?: string,
		images?: string[],
	): Promise<DeferredResponse> {
		const body = this.adapter.buildRequestBody({
			goal: message,
			sessionId,
			workspacePath,
			images,
		})
		const endpoint = this.adapter.getEndpoint("deferredStart")
		return this.fetchDeferred(endpoint, body)
	}

	async deferredResume(
		runId: string,
		sessionId: string,
		toolResults: DeferredToolResult[],
	): Promise<DeferredResponse> {
		const body = this.adapter.buildRequestBody({
			runId,
			sessionId,
			toolResults,
		})
		const endpoint = this.adapter.getEndpoint("deferredResume")
		return this.fetchDeferred(endpoint, body)
	}

	async disconnect(sessionId?: string, runId?: string): Promise<void> {
		// MCP 协议：断开连接后直接返回
		if (this.adapter.protocolType === "mcp") {
			await this.adapter.disconnect()
			return
		}

		// REST 协议：发送 deferred/abort
		if (sessionId?.trim()) {
			await CloudAgentClient.sendDeferredAbort(
				this.options.profile,
				sessionId.trim(),
				runId?.trim() || undefined,
				this.options.requestTimeoutMs,
			)
		}
	}
}
