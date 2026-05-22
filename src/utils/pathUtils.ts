import * as vscode from "vscode"
import * as path from "path"
import * as fsSync from "fs"

/**
 * Resolves the real path of a file, handling non-existent files by
 * finding the nearest existing parent directory and resolving symlinks.
 * This prevents symlink-based path traversal attacks where a symlink
 * inside the workspace points to a location outside the workspace.
 */
function resolveRealPath(filePath: string): string {
	try {
		return fsSync.realpathSync(filePath)
	} catch {
		// File doesn't exist - find nearest existing parent and resolve its real path
		let current = filePath
		const missingParts: string[] = []

		while (true) {
			const parent = path.dirname(current)
			if (parent === current) {
				// Reached root, return original
				return filePath
			}

			try {
				const realParent = fsSync.realpathSync(parent)
				// Found existing parent, reconstruct path with real parent.
				// current is the first missing segment below realParent;
				// missingParts are the segments below current (in original order).
				return path.join(realParent, path.basename(current), ...missingParts)
			} catch {
				missingParts.unshift(path.basename(current))
				current = parent
			}
		}
	}
}

/**
 * Checks if a file path is outside all workspace folders.
 * Uses realpath to resolve symlinks and prevent path traversal bypasses.
 * For non-existent files, finds the nearest existing parent directory and
 * resolves its real path to detect symlink escapes.
 *
 * @param filePath The file path to check
 * @returns true if the path is outside all workspace folders, false otherwise
 */
export function isPathOutsideWorkspace(filePath: string): boolean {
	// If there are no workspace folders, consider everything outside workspace for safety
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return true
	}

	// Normalize and resolve the path to handle .. and . components correctly
	const absolutePath = path.resolve(filePath)
	const realTarget = resolveRealPath(absolutePath)

	// Check if the resolved path is within any workspace folder
	return !vscode.workspace.workspaceFolders.some((folder) => {
		const realFolder = resolveRealPath(folder.uri.fsPath)
		return realTarget === realFolder || realTarget.startsWith(realFolder + path.sep)
	})
}
