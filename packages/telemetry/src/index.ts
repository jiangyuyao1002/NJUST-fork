import { TelemetryLogger } from "./TelemetryLogger.js"
import { TelemetryBatcher } from "./TelemetryBatcher.js"

export interface TelemetryEvent {
	name: string
	properties?: Record<string, any>
}

export interface TelemetryProperties {
	[key: string]: any
}

export type TelemetryPropertiesProvider = () => TelemetryProperties | Promise<TelemetryProperties>

export interface StaticAppProperties {
	[key: string]: any
}

export interface DynamicAppProperties {
	[key: string]: any
}

interface TelemetryInitOptions {
	serviceName?: string
	enableOtel?: boolean
	telemetryDir?: string
}

const ALLOWED_KEYS = new Set([
	"taskId", "mode", "tool", "provider", "model", "duration",
	"tokenUsage", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
	"isAutomatic", "hasCustomPrompt", "isSubtask", "attempts", "failures",
	"success", "error_type", "status_code", "event",
])

function sanitize(props: Record<string, any> | undefined): Record<string, any> {
	if (!props) return {}
	const out: Record<string, any> = {}
	for (const [k, v] of Object.entries(props)) {
		if (ALLOWED_KEYS.has(k)) {
			out[k] = v
		}
	}
	return out
}

export class TelemetryService {
	private static _instance: TelemetryService | undefined

	private batcher: TelemetryBatcher | null = null
	private otelEnabled = false
	private otelInitStarted = false
	private otelApi: any = undefined
	private tracer: any = undefined
	private spanStore = new Map<string, any>()

	static get instance(): TelemetryService {
		if (!TelemetryService._instance) {
			TelemetryService._instance = new TelemetryService()
		}
		return TelemetryService._instance
	}

	static hasInstance(): boolean {
		return !!TelemetryService._instance
	}

	static reportError(error: unknown, event: string): void {
		if (TelemetryService._instance) {
			TelemetryService._instance.captureException(error, { event })
		}
	}

	static getInstance(): TelemetryService {
		return TelemetryService.instance
	}

	static createInstance(options?: TelemetryInitOptions): TelemetryService {
		const svc = new TelemetryService()
		if (options?.telemetryDir) {
			const logger = new TelemetryLogger(options.telemetryDir)
			svc.batcher = new TelemetryBatcher(logger)
			svc.batcher.start()
		}
		void svc.initializeOtel(options)
		TelemetryService._instance = svc
		return svc
	}

	private async initializeOtel(options?: TelemetryInitOptions): Promise<void> {
		if (this.otelInitStarted) return
		this.otelInitStarted = true
		if (options?.enableOtel === false) return
		try {
			const dynamicImporter = new Function("m", "return import(m)") as (m: string) => Promise<any>
			const otelApi = await dynamicImporter("@opentelemetry/api")
			this.otelApi = otelApi
			this.tracer = otelApi.trace.getTracer(options?.serviceName || "Njust-AI")
			this.otelEnabled = true
		} catch {
			this.otelEnabled = false
		}
	}

	register(_client: any): void {
		// no-op — reserved for external telemetry clients
	}

	shutdown(): void {
		if (this.batcher) {
			void this.batcher.shutdown()
		}
		for (const [, span] of this.spanStore) {
			try { span.end() } catch { /* no-op */ }
		}
		this.spanStore.clear()
	}

	async sendEvent(name: string, properties?: Record<string, any>): Promise<void> {
		this.captureEvent(name, properties)
	}

	async flush(): Promise<void> {
		if (this.batcher) {
			this.batcher.flush()
		}
	}

	// ─── Span management (OTel) ──────────────────────────────────────

	startSpan(name: string, attrs?: Record<string, any>): { traceId: string; spanId: string } | undefined {
		if (!this.otelEnabled || !this.tracer || !this.otelApi) {
			return undefined
		}
		const span = this.tracer.startSpan(name)
		for (const [k, v] of Object.entries(attrs ?? {})) {
			span.setAttribute?.(k, v)
		}
		const ctx = span.spanContext?.() as { traceId?: string; spanId?: string } | undefined
		const traceId = ctx?.traceId ?? `${Date.now()}-trace`
		const spanId = ctx?.spanId ?? `${Date.now()}-span`
		this.spanStore.set(spanId, span)
		return { traceId, spanId }
	}

	endSpan(spanId: string, status?: "ok" | "error", attrs?: Record<string, any>): void {
		const span = this.spanStore.get(spanId)
		if (!span) return
		for (const [k, v] of Object.entries(attrs ?? {})) {
			span.setAttribute?.(k, v)
		}
		span.setStatus?.({ code: status === "error" ? 2 : 1 })
		span.end()
		this.spanStore.delete(spanId)
	}

	// ─── Core capture ────────────────────────────────────────────────

	private emit(name: string, properties?: Record<string, any>): void {
		const safe = sanitize(properties)

		// File batcher (always available when configured)
		if (this.batcher) {
			this.batcher.enqueue({ t: Date.now(), n: name, p: safe })
		}

		// OTel event (optional)
		if (this.otelEnabled && this.tracer) {
			try {
				const span = this.tracer.startSpan(`event.${name}`)
				for (const [k, v] of Object.entries(safe)) {
					span.setAttribute?.(k, v)
				}
				span.addEvent(name, safe)
				span.end()
			} catch { /* no-op */ }
		}
	}

	// ─── Public capture methods ──────────────────────────────────────

	captureEvent(name: string | { event: string; properties: any }, properties?: Record<string, any>): void {
		const evtName = typeof name === "string" ? name : name.event
		const evtProps = typeof name === "string" ? properties : name.properties
		this.emit(evtName, evtProps)
	}

	captureTitleButtonClicked(button: string): void {
		this.emit("title_button_clicked", { event: button })
	}

	captureTabShown(tab: string): void {
		this.emit("tab_shown", { event: tab })
	}

	captureError(error: any, properties?: Record<string, any>): void {
		this.emit("error", {
			error_type: typeof error === "string" ? error : error?.message ?? String(error),
			...properties,
		})
	}

	captureTelemetrySettingsChanged(previous: string, current: string): void {
		this.emit("telemetry_settings_changed", { previous, current })
	}

	captureModeSettingChanged(mode: string, source?: string): void {
		this.emit("mode_setting_changed", { mode, event: source })
	}

	captureCustomModeCreated(slug: string, name?: string): void {
		this.emit("custom_mode_created", { mode: slug, event: name })
	}

	captureConsecutiveMistakeError(name: string): void {
		this.emit("consecutive_mistake", { event: name })
	}

	captureException(error: any, context?: string | Record<string, any>): void {
		const ctx = typeof context === "string" ? { event: context } : context
		this.emit("exception", {
			error_type: typeof error === "string" ? error : error?.message ?? String(error),
			...ctx,
		})
	}

	captureConversationMessage(taskId: string, role: string): void {
		this.emit("conversation_message", { taskId, event: role })
	}

	captureLlmCompletion(
		taskId: string,
		tokens: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			cost: number
		},
	): void {
		this.emit("llm_completion", {
			taskId,
			inputTokens: tokens.inputTokens,
			outputTokens: tokens.outputTokens,
			cacheWriteTokens: tokens.cacheWriteTokens,
			cacheReadTokens: tokens.cacheReadTokens,
			cost: tokens.cost,
		})
	}

	captureDiffApplicationError(taskId: string, count: number): void {
		this.emit("diff_application_error", { taskId, failures: count })
	}

	captureTaskCompleted(taskId: string | Record<string, any>): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("task_completed", { taskId: id })
	}

	captureTaskCreated(taskId: string): void {
		this.emit("task_created", { taskId })
	}

	captureTaskRestarted(taskId: string): void {
		this.emit("task_restarted", { taskId })
	}

	captureCodeActionUsed(action: string): void {
		this.emit("code_action_used", { event: action })
	}

	captureModeSwitch(taskId: string, mode: string): void {
		this.emit("mode_switch", { taskId, mode })
	}

	captureToolUsage(taskId: string | Record<string, any>, tool?: string): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("tool_usage", { taskId: id, tool })
	}

	captureCheckpointCreated(taskId: string | Record<string, any>): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("checkpoint_created", { taskId: id })
	}

	captureCheckpointRestored(taskId: string | Record<string, any>): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("checkpoint_restored", { taskId: id })
	}

	captureCheckpointDiffed(taskId: string | Record<string, any>): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("checkpoint_diffed", { taskId: id })
	}

	captureContextCondensed(taskId: string, isAutomatic?: boolean, hasCustomPrompt?: boolean): void {
		this.emit("context_condensed", { taskId, isAutomatic, hasCustomPrompt })
	}

	captureSchemaValidationError(properties?: Record<string, any>): void {
		this.emit("schema_validation_error", properties)
	}

	captureSlidingWindowTruncation(taskId: string | Record<string, any>): void {
		const id = typeof taskId === "string" ? taskId : taskId?.taskId ?? "unknown"
		this.emit("sliding_window_truncation", { taskId: id })
	}

	captureShellIntegrationError(error: any): void {
		this.emit("shell_integration_error", {
			error_type: typeof error === "string" ? error : error?.message ?? String(error),
		})
	}

	updateTelemetryState(_isOptedIn: boolean): void {
		// Reserved for future GDPR consent toggling
	}
}
