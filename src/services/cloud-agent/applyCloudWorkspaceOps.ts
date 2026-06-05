import { execApplyDiff, execWriteFile } from "../mcp-server/tool-executors"

import type { WorkspaceOp } from "./types"
import { getErrorMessage } from "../../shared/error-utils"
import { allowRooIgnorePathAccess, type RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import type { RooProtectedController } from "../../core/protect/RooProtectedController"

export interface CloudWorkspaceOpResult {
	path: string
	ok: boolean
	message: string
}

export interface ApplyCloudWorkspaceOpsResult {
	results: CloudWorkspaceOpResult[]
	/** Index of first failed op when ok is false (fail-fast). */
	failedAtIndex?: number
	ok: boolean
}

/**
 * Apply a single validated workspace op (write_file or apply_diff).
 */
export async function applySingleCloudWorkspaceOp(
	cwd: string,
	op: WorkspaceOp,
	rooIgnoreController?: RooIgnoreController,
	rooProtectedController?: RooProtectedController,
): Promise<CloudWorkspaceOpResult> {
	try {
		const accessAllowed = allowRooIgnorePathAccess(rooIgnoreController, op.path)
		if (!accessAllowed) {
			return { path: op.path, ok: false, message: `Access denied by .rooignore: ${op.path}` }
		}
		const isWriteProtected = (await rooProtectedController?.isWriteProtected(op.path)) || false
		if (isWriteProtected) {
			return { path: op.path, ok: false, message: `Write protected: ${op.path}` }
		}
		if (op.op === "write_file") {
			const message = await execWriteFile(cwd, { path: op.path, content: op.content }, rooProtectedController)
			return { path: op.path, ok: true, message }
		}
		const message = await execApplyDiff(cwd, { path: op.path, diff: op.diff }, rooProtectedController)
		return { path: op.path, ok: true, message }
	} catch (e) {
		const msg = getErrorMessage(e)
		return { path: op.path, ok: false, message: msg }
	}
}

/**
 * Apply validated workspace ops in order. Fail-fast: stops at first error.
 */
export async function applyCloudWorkspaceOps(
	cwd: string,
	ops: WorkspaceOp[],
	isAborted?: () => boolean,
	rooIgnoreController?: RooIgnoreController,
	rooProtectedController?: RooProtectedController,
): Promise<ApplyCloudWorkspaceOpsResult> {
	const results: CloudWorkspaceOpResult[] = []

	for (let i = 0; i < ops.length; i++) {
		if (isAborted?.()) {
			return {
				results,
				failedAtIndex: i,
				ok: false,
			}
		}

		const op = ops[i]!
		const single = await applySingleCloudWorkspaceOp(cwd, op, rooIgnoreController, rooProtectedController)
		results.push(single)
		if (!single.ok) {
			return { results, failedAtIndex: i, ok: false }
		}
	}

	return { results, ok: true }
}
