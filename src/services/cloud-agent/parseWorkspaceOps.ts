import * as path from "path"
import { z } from "zod"

import type { WorkspaceOp } from "./types"

/** Max number of operations per /v1/run response. */
export const WORKSPACE_OPS_MAX_COUNT = 50

/** Max length for path, and for content/diff body fields (chars). */
export const WORKSPACE_OPS_MAX_PATH_LEN = 4096
export const WORKSPACE_OPS_MAX_BODY_CHARS = 1_000_000

/** Validate that a workspace op path is safe: no null bytes, no traversal, no absolute paths. */
function isPathSafe(p: string): boolean {
	if (p.includes("\0")) return false // null byte injection
	if (p.includes("..")) return false // path traversal
	if (path.isAbsolute(p)) return false // absolute path escape
	if (/%2e%2e/i.test(p)) return false // URL-encoded traversal
	return true
}

const safePathMessage = "Invalid path: absolute paths, '..' traversal, null bytes, and encoded traversal are blocked"

const writeFileOpSchema = z.object({
	op: z.literal("write_file"),
	path: z.string().max(WORKSPACE_OPS_MAX_PATH_LEN).refine(isPathSafe, safePathMessage),
	content: z.string().max(WORKSPACE_OPS_MAX_BODY_CHARS),
})

const applyDiffOpSchema = z.object({
	op: z.literal("apply_diff"),
	path: z.string().max(WORKSPACE_OPS_MAX_PATH_LEN).refine(isPathSafe, safePathMessage),
	diff: z.string().max(WORKSPACE_OPS_MAX_BODY_CHARS),
})

const workspaceOpSchema = z.discriminatedUnion("op", [writeFileOpSchema, applyDiffOpSchema])

const workspaceOpsEnvelopeSchema = z.object({
	version: z.literal(1).optional(),
	operations: z.array(workspaceOpSchema).max(WORKSPACE_OPS_MAX_COUNT),
})

export interface ParseWorkspaceOpsResult {
	operations: WorkspaceOp[]
	/** Set when workspace_ops was present but invalid. */
	error?: string
}

/**
 * Extract and validate workspace_ops from a parsed /v1/run JSON object.
 * Never throws; invalid payloads yield empty operations and an error message for logging.
 */
export function parseWorkspaceOps(data: unknown): ParseWorkspaceOpsResult {
	if (data === null || typeof data !== "object") {
		return { operations: [] }
	}

	const record = data as Record<string, unknown>
	const raw = record.workspace_ops
	if (raw === undefined || raw === null) {
		return { operations: [] }
	}

	const parsed = workspaceOpsEnvelopeSchema.safeParse(raw)
	if (!parsed.success) {
		return {
			operations: [],
			error:
				parsed.error.flatten().formErrors.join("; ") ||
				parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") ||
				parsed.error.message,
		}
	}

	return { operations: parsed.data.operations as WorkspaceOp[] }
}
