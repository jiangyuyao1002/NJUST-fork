/** Hard cap on deferred start → resume tool rounds (server and client should stay aligned). */
export const CLOUD_AGENT_DEFERRED_MAX_ITERATIONS = 50

/** Maximum wall-clock duration (120 seconds) for the entire deferred loop to prevent the server from keeping it running indefinitely. */
export const CLOUD_AGENT_DEFERRED_MAX_DURATION_MS = 120_000

/** Maximum automatic recovery attempts when a deferred session expires (HTTP 404). */
export const CLOUD_AGENT_DEFERRED_SESSION_RECOVERY_MAX = 3

/** Minimum `deferred_protocol_version` from the server that this client accepts. */
export const MIN_DEFERRED_PROTOCOL_VERSION = 1

/** Upper bound for `run_id` length after trim (pathological payloads). */
export const MAX_DEFERRED_RUN_ID_LENGTH = 512
