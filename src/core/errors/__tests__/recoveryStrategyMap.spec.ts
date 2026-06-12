import { describe, expect, it } from "vitest"
import {
	mapErrorToRecoveryAction,
	shouldRetryCapacityError,
	type ApiErrorKind,
	type QuerySource,
} from "../recoveryStrategyMap"

describe("recoveryStrategyMap", () => {
	describe("mapErrorToRecoveryAction", () => {
		const cases: [ApiErrorKind, number, string][] = [
			["prompt_too_long", 0, "reactive_compact_then_retry"],
			["prompt_too_long", 2, "reactive_compact_then_retry"],
			["prompt_too_long", 3, "none"],

			["max_output_tokens", 0, "retry_with_continuation"],
			["max_output_tokens", 2, "retry_with_continuation"],
			["max_output_tokens", 3, "none"],

			["context_window_exceeded", 0, "context_window_recover"],
			["context_window_exceeded", 1, "context_window_recover"],
			["context_window_exceeded", 2, "none"],

			["rate_limit", 0, "backoff_retry"],
			["rate_limit", 9, "backoff_retry"],
			["rate_limit", 10, "none"],

			["capacity", 0, "backoff_retry"],
			["capacity", 4, "backoff_retry"],
			["capacity", 5, "none"],

			["server_error", 0, "server_error_backoff"],
			["server_error", 4, "server_error_backoff"],
			["server_error", 5, "none"],

			["network_error", 0, "backoff_retry"],
			["network_error", 4, "backoff_retry"],
			["network_error", 5, "none"],

			["stale_connection", 0, "immediate_retry"],
			["stale_connection", 2, "immediate_retry"],
			["stale_connection", 3, "none"],

			["timeout", 0, "timeout_degrade"],
			["timeout", 2, "timeout_degrade"],
			["timeout", 3, "model_fallback"],

			["auth_error", 0, "none"],
			["auth_error", 5, "none"],

			["media_too_large", 0, "strip_media_retry"],
			["media_too_large", 1, "strip_media_retry"],
			["media_too_large", 2, "none"],

			["model_overloaded", 0, "overloaded_backoff"],
			["model_overloaded", 2, "overloaded_backoff"],
			["model_overloaded", 3, "model_fallback"],

			["invalid_tool_use", 0, "inject_tool_hint_retry"],
			["invalid_tool_use", 2, "inject_tool_hint_retry"],
			["invalid_tool_use", 3, "none"],

			["content_policy", 0, "content_policy_reject"],
			["content_policy", 10, "content_policy_reject"],

			["partial_response", 0, "partial_continue"],
			["partial_response", 2, "partial_continue"],
			["partial_response", 3, "none"],

			["unknown", 0, "unknown_single_retry"],
			["unknown", 1, "none"],
		]

		it.each(cases)("maps %s at attempt %s to %s", (kind, attempt, expected) => {
			expect(mapErrorToRecoveryAction(kind, attempt)).toBe(expected)
		})

		it("returns none for unrecognized error kinds", () => {
			expect(mapErrorToRecoveryAction("not_a_kind" as ApiErrorKind, 0)).toBe("none")
		})
	})

	describe("shouldRetryCapacityError", () => {
		it.each<[QuerySource, boolean]>([
			["user_query", true],
			["sub_task", true],
			["tool_execution", true],
			["auto_compact", false],
		])("returns %s for %s", (source, expected) => {
			expect(shouldRetryCapacityError(source)).toBe(expected)
		})
	})
})
