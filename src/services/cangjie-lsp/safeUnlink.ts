import * as fs from "fs"

/**
 * Best-effort file deletion — silently ignores failure.
 * Used in finally blocks where cleanup must not propagate errors
 * (temp file may already be gone, never created, or locked).
 */
export function safeUnlink(filePath: string): void {
	try {
		fs.unlinkSync(filePath)
	} catch {
		// Best-effort cleanup — file may not exist or be inaccessible
	}
}
