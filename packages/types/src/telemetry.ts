import type { GitRepositoryInfo } from "./git.js"

/**
 * TelemetrySetting
 *
 * User preference for telemetry: enabled, disabled, or unset (default).
 */
export type TelemetrySetting = "enabled" | "disabled" | "unset"

/**
 * TelemetryEventName
 *
 * Known event names for telemetry. Used in settings tracking and analytics.
 */
export const TelemetryEventName = {
	TELEMETRY_SETTINGS_CHANGED: "telemetry_settings_changed",

	// P0 — actively used
	TASK_LIFECYCLE_ERROR: "task_lifecycle_error",
	API_PROVIDER_ERROR: "api_provider_error",
	MCP_ERROR: "mcp_error",
	ASSISTANT_MESSAGE_ERROR: "assistant_message_error",
	CONDENSE_ERROR: "condense_error",

	// P1 — reserved for cangjie LSP, code index, checkpoints, editor, webview
	CANGJIE_LSP_ERROR: "cangjie_lsp_error",
	CODE_INDEX_ERROR: "code_index_error",
	CHECKPOINT_ERROR: "checkpoint_error",
	EDITOR_ERROR: "editor_error",
	WEBVIEW_ERROR: "webview_error",

	// P2 — reserved for extension init, git, storage, search, parser, utility
	EXTENSION_INIT_ERROR: "extension_init_error",
	GIT_ERROR: "git_error",
	STORAGE_ERROR: "storage_error",
	SEARCH_ERROR: "search_error",
	PARSER_ERROR: "parser_error",
	UTILITY_ERROR: "utility_error",
} as const
export type TelemetryEventName = (typeof TelemetryEventName)[keyof typeof TelemetryEventName]

/**
 * StaticAppProperties
 *
 * Properties that don't change during a session (e.g., extension version).
 */
export interface StaticAppProperties {
	[key: string]: unknown
}

/**
 * DynamicAppProperties
 *
 * Properties that can change during a session (e.g., mode, model).
 */
export interface DynamicAppProperties {
	[key: string]: unknown
}

/**
 * CloudAppProperties
 *
 * Cloud-related properties (auth state, org, etc.). Stub for cloud-stripped builds.
 */
export interface CloudAppProperties {
	[key: string]: unknown
}

/**
 * TaskProperties
 *
 * Task-specific properties (taskId, apiProvider, modelId, etc.).
 */
export interface TaskProperties {
	[key: string]: unknown
}

/**
 * GitProperties
 *
 * Git repository information for telemetry.
 */
export type GitProperties = GitRepositoryInfo

/**
 * TelemetryProperties
 *
 * Combined properties for a telemetry event.
 */
export interface TelemetryProperties {
	[key: string]: unknown
}

/**
 * TelemetryPropertiesProvider
 *
 * Provider that supplies telemetry properties (e.g., ClineProvider).
 * When passing to TelemetryService.setProvider(), wrap as () => provider.getTelemetryProperties().
 */
export interface TelemetryPropertiesProvider {
	getTelemetryProperties(): TelemetryProperties | Promise<TelemetryProperties>
}
