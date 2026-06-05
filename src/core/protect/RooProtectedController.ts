import path from "path"
import { promises as fs } from "fs"
import ignore, { Ignore } from "ignore"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"

export const SHIELD_SYMBOL = "\u{1F6E1}"

/**
 * Controls write access to Njust-AI configuration files by enforcing protection patterns.
 * Prevents auto-approved modifications to sensitive Njust-AI configuration files.
 */
export class RooProtectedController {
	private cwd: string
	private ignoreInstance: Ignore

	// Predefined list of protected Njust-AI configuration patterns
	private static readonly PROTECTED_PATTERNS = [
		".rooignore",
		".roomodes",
		".roorules*",
		".clinerules*",
		".njust_ai/**",
		".vscode/**",
		"*.code-workspace",
		".rooprotected", // For future use
		"AGENTS.md",
		"AGENT.md",
	]

	constructor(cwd: string) {
		this.cwd = cwd
		// Initialize ignore instance with protected patterns
		this.ignoreInstance = ignore()
		this.ignoreInstance.add(RooProtectedController.PROTECTED_PATTERNS)
	}

	/**
	 * Check if a file is write-protected
	 * Resolves symlinks to prevent bypass via symlink to protected files.
	 * @param filePath - Path to check (relative to cwd)
	 * @returns true if file is write-protected, false otherwise
	 */
	async isWriteProtected(filePath: string): Promise<boolean> {
		try {
			const absolutePath = path.resolve(this.cwd, filePath)
			// Resolve symlinks to prevent bypass via symlink to protected files
			let realAbsolutePath: string
			try {
				realAbsolutePath = await fs.realpath(absolutePath)
			} catch {
				// File doesn't exist yet — walk up to find existing parent and resolve its realpath
				realAbsolutePath = await this.resolveExistingParentRealpath(absolutePath)
			}
			// Also resolve cwd realpath for consistent comparison
			const realCwd = await fs.realpath(this.cwd).catch(() => this.cwd)
			const relativePath = path.relative(realCwd, realAbsolutePath).toPosix()

			// Paths outside the cwd start with ".." and can't match any protected pattern.
			// The ignore library throws RangeError for such paths, so skip them early.
			if (relativePath.startsWith("..")) {
				return false
			}

			// Use ignore library to check if file matches any protected pattern
			return this.ignoreInstance.ignores(relativePath)
		} catch (error) {
			// Fail-closed: if we can't determine protection status, assume protected
			logger.warn("RooProtectedController", `Error checking protection for ${filePath} (treating as protected):`, error)
			TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
			return true
		}
	}

	/**
	 * Walk up from filePath to find the nearest existing parent directory,
	 * resolve its realpath, then reconstruct the full path.
	 */
	private async resolveExistingParentRealpath(filePath: string): Promise<string> {
		let current = filePath
		while (current !== path.dirname(current)) {
			current = path.dirname(current)
			try {
				const realParent = await fs.realpath(current)
				return path.join(realParent, path.relative(current, filePath))
			} catch {
				continue
			}
		}
		return filePath
	}

	/**
	 * Get set of write-protected files from a list
	 * @param paths - Array of paths to filter (relative to cwd)
	 * @returns Set of protected file paths
	 */
	async getProtectedFiles(paths: string[]): Promise<Set<string>> {
		const protectedFiles = new Set<string>()

		for (const filePath of paths) {
			if (await this.isWriteProtected(filePath)) {
				protectedFiles.add(filePath)
			}
		}

		return protectedFiles
	}

	/**
	 * Filter an array of paths, marking which ones are protected
	 * @param paths - Array of paths to check (relative to cwd)
	 * @returns Array of objects with path and protection status
	 */
	async annotatePathsWithProtection(paths: string[]): Promise<Array<{ path: string; isProtected: boolean }>> {
		return Promise.all(
			paths.map(async (filePath) => ({
				path: filePath,
				isProtected: await this.isWriteProtected(filePath),
			})),
		)
	}

	/**
	 * Get display message for protected file operations
	 */
	getProtectionMessage(): string {
		return "This is a Njust-AI configuration file and requires approval for modifications"
	}

	/**
	 * Get formatted instructions about protected files for the LLM
	 * @returns Formatted instructions about file protection
	 */
	getInstructions(): string {
		const patterns = RooProtectedController.PROTECTED_PATTERNS.join(", ")
		return `# Protected Files\n\n(The following Njust-AI configuration file patterns are write-protected and always require approval for modifications, regardless of autoapproval settings. When using list_files, you'll notice a ${SHIELD_SYMBOL} next to files that are write-protected.)\n\nProtected patterns: ${patterns}`
	}

	/**
	 * Get the list of protected patterns (for testing/debugging)
	 */
	static getProtectedPatterns(): readonly string[] {
		return RooProtectedController.PROTECTED_PATTERNS
	}
}
