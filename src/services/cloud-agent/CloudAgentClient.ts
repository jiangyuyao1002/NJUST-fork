import { getErrorMessage } from "../../shared/error-utils"
import { normalizeDeferredResponse } from "./normalizeDeferredResponse"
import { parseWorkspaceOps } from "./parseWorkspaceOps"
import { logger } from "../../shared/logger"
import { ApiRetryExecutor, type ApiRetryOptions } from "../../api/retry/ApiRetryStrategy"
import { analyzeErrorForRetry } from "../../api/retry/ApiErrorClassifier"
import type {	CloudAgentCallbacks,
	CloudAgentClientOptions,
	CloudCompileResponse,
	CloudCompileResult,
	CloudRunResponse,
	CloudRunResult,
	DeferredResponse,
	DeferredToolResult,
} from "./types"

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
		' Hint: set VS Code "njust-ai-cj.cloudAgent.apiKey" (User settings) to match server CLOUD_AGENT_MOCK_API_KEY, ' +
		"or set process env CLOUD_AGENT_MOCK_API_KEY / NJUST_CLOUD_AGENT_API_KEY for the extension host (e.g. Roo-Code/.env). " +
		"Workspace .vscode/settings.json only applies when that folder is the workspace root."
	)
}

export class CloudAgentClient {
	/**
	 * Notify the server that the deferred session should be torn down (best-effort; does not throw).
	 * POST `/v1/run/deferred/abort` with `{ session_id, run_id? }`. Missing servers may return 404 — logged only.
	 */
	static async sendDeferredAbort(
		serverUrl: string,
		deviceToken: string,
		apiKey: string | undefined,
		sessionId: string,
		runId: string | undefined,
		requestTimeoutMs?: number,
	): Promise<void> {
		const base = serverUrl.replace(/\/$/, "")
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		if (requestTimeoutMs && requestTimeoutMs > 0) {
			timer = setTimeout(() => controller.abort(new DOMException("abort request timed out", "AbortError")), requestTimeoutMs)
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Device-Token": deviceToken,
		}
		if (apiKey) {
			headers["X-API-Key"] = apiKey
		}
		const body = JSON.stringify({
			session_id: sessionId,
			...(runId?.trim() ? { run_id: runId.trim() } : {}),
		})
		try {
			let resp: Response
			try {
				resp = await fetch(`${base}/v1/run/deferred/abort`, {
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
				// Still clean up local session state so counters / caches
				// don't leak across connection attempts.
				(this as Record<string, UnsafeAny>).localSessionCleanup?.()
				return
			}
			if (!resp.ok) {
				const t = await resp.text().catch(() => "")
				logger.warn("CloudAgentClient", `deferred/abort HTTP ${resp.status}: ${t.slice(0, 300)}`)
			}
		} catch (e) {
			const msg = getErrorMessage(e)
			logger.warn("CloudAgentClient", `deferred/abort failed: ${msg}`)
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private serverUrl: string
	private deviceToken: string
	private callbacks: CloudAgentCallbacks
	private readonly options: CloudAgentClientOptions | undefined
	private readonly retryExecutor = new ApiRetryExecutor(CLOUD_AGENT_RETRY_OPTIONS)

	constructor(
		serverUrl: string,
		deviceToken: string,
		callbacks: CloudAgentCallbacks,
		options?: CloudAgentClientOptions,
	) {
		this.serverUrl = serverUrl.replace(/\/$/, "")
		const url = new URL(this.serverUrl)
		if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
			throw new Error("Cloud Agent requires HTTPS for non-localhost connections")
		}
		this.deviceToken = deviceToken
		this.callbacks = callbacks
		this.options = options
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
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Device-Token": this.deviceToken,
		}
		if (this.options?.apiKey) {
			headers["X-API-Key"] = this.options.apiKey
		}
		return headers
	}

	private async parseJsonResponse(resp: Response): Promise<CloudRunResponse> {
		const text = await resp.text()
		try {
			return JSON.parse(text) as CloudRunResponse
		} catch {
			throw new Error(
				`Cloud Agent: response is not valid JSON (HTTP ${resp.status}): ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`,
			)
		}
	}

	async connect(): Promise<void> {
		await this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				try {
					let resp: Response
					try {
						resp = await fetch(`${this.serverUrl}/health`, {
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

	async submitTask(
		sessionId: string,
		message: string,
		workspacePath?: string,
		images?: string[],
	): Promise<CloudRunResult> {
		const body: Record<string, UnsafeAny> = {
			goal: message,
			session_id: sessionId,
			workspace_path: workspacePath,
		}
		if (images && images.length > 0) {
			body.images = images
		}

		const data = await this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				let resp: Response
				try {
					try {
						resp = await fetch(`${this.serverUrl}/v1/run`, {
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
					const err = new Error(`Cloud Agent error (HTTP ${resp.status}): ${slice}${apiKeyHintFor401(resp.status, slice)}`)
					;(err as Error & { status?: number }).status = resp.status
					throw err
				}

				return this.parseJsonResponse(resp)
			},
			shouldRetryCloudAgent,
			(info) => logger.warn("CloudAgentClient", `submitTask retry #${info.attempt + 1} after ${info.delayMs}ms`),
		)

		const { operations: workspaceOps, error: workspaceOpsError } = parseWorkspaceOps(data)
		if (workspaceOpsError !== undefined) {
			logger.warn("CloudAgentClient", `Invalid workspace_ops in /v1/run response: ${workspaceOpsError}`)
		}

		for (const log of data.logs || []) {
			await this.callbacks.onText(log)
		}

		if (data.memory_summary) {
			await this.callbacks.onText(data.memory_summary)
		}

		await this.callbacks.onDone(data.ok ? "Task completed" : "Task failed")

		return {
			memorySummary: data.memory_summary || "",
			tokensIn: data.tokens_in ?? 0,
			tokensOut: data.tokens_out ?? 0,
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
		const body: Record<string, UnsafeAny> = { session_id: sessionId }
		if (workspacePath) {
			body.workspace_path = workspacePath
		}

		return this.retryExecutor.execute(
			async () => {
				const { signal, cleanup } = this.mergeAbortAndTimeout()
				let resp: Response
				try {
					try {
						resp = await fetch(`${this.serverUrl}/v1/run/compile`, {
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

				const text = await resp.text()
				let parsed: UnsafeAny
				try {
					parsed = JSON.parse(text)
				} catch {
					throw new Error(
						`Cloud Agent: deferred response is not valid JSON (HTTP ${resp.status}): ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`,
					)
				}
				try {
					return normalizeDeferredResponse(parsed)
				} catch (e) {
					const hint = getErrorMessage(e)
					throw new Error(`Cloud Agent: invalid deferred response payload (HTTP ${resp.status}): ${hint}`)
				}
			},
			shouldRetryCloudAgent,
			(info) => logger.warn("CloudAgentClient", `fetchDeferred(${endpoint}) retry #${info.attempt + 1} after ${info.delayMs}ms`),
		)
	}

	async deferredStart(
		sessionId: string,
		message: string,
		workspacePath?: string,
		images?: string[],
	): Promise<DeferredResponse> {
		const body: Record<string, UnsafeAny> = {
			goal: message,
			session_id: sessionId,
			workspace_path: workspacePath,
		}
		if (images && images.length > 0) {
			body.images = images
		}
		return this.fetchDeferred("/v1/run/deferred/start", body)
	}

	async deferredResume(
		runId: string,
		sessionId: string,
		toolResults: DeferredToolResult[],
	): Promise<DeferredResponse> {
		return this.fetchDeferred("/v1/run/deferred/resume", {
			run_id: runId,
			session_id: sessionId,
			tool_results: toolResults,
		})
	}

	async disconnect(sessionId?: string, runId?: string): Promise<void> {
		if (sessionId?.trim()) {
			await CloudAgentClient.sendDeferredAbort(
				this.serverUrl,
				this.deviceToken,
				this.options?.apiKey,
				sessionId.trim(),
				runId?.trim() || undefined,
				this.options?.requestTimeoutMs,
			)
		}
	}
}
