import fs from "fs/promises"
import path from "path"
import * as os from "os"
import { Dirent } from "fs"

import { NJUST_AI_CONFIG_DIR } from "@njust-ai/types"

import {
	getRooDirectoriesForCwd,
	getAllRooDirectoriesForCwd,
	getAgentsDirectoriesForCwd,
} from "../../../services/njust-ai-config"

const MAX_DEPTH = 5

/**
 * Safely read a file and return its trimmed content
 */
export async function safeReadFile(filePath: string): Promise<string> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		if (typeof content !== "string") {
			return ""
		}
		return content.trim()
	} catch (err) {
		const errorCode = (err as NodeJS.ErrnoException).code
		if (!errorCode || !["ENOENT", "EISDIR"].includes(errorCode)) {
			throw err
		}
		return ""
	}
}

/**
 * Check if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(dirPath)
		return stats.isDirectory()
	} catch {
		return false
	}
}

/**
 * Recursively resolve directory entries and collect file paths
 */
async function resolveDirectoryEntry(
	entry: Dirent,
	dirPath: string,
	fileInfo: Array<{ originalPath: string; resolvedPath: string }>,
	depth: number,
): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}

	const fullPath = path.resolve(entry.parentPath || dirPath, entry.name)
	if (entry.isFile()) {
		// Regular file - both original and resolved paths are the same
		fileInfo.push({ originalPath: fullPath, resolvedPath: fullPath })
	} else if (entry.isSymbolicLink()) {
		// Await the resolution of the symbolic link
		await resolveSymLink(fullPath, fileInfo, depth + 1)
	}
}

/**
 * Recursively resolve a symbolic link and collect file paths
 */
async function resolveSymLink(
	symlinkPath: string,
	fileInfo: Array<{ originalPath: string; resolvedPath: string }>,
	depth: number,
): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}
	try {
		// Get the symlink target
		const linkTarget = await fs.readlink(symlinkPath)
		// Resolve the target path (relative to the symlink location)
		const resolvedTarget = path.resolve(path.dirname(symlinkPath), linkTarget)

		// Check if the target is a file
		const stats = await fs.stat(resolvedTarget)
		if (stats.isFile()) {
			// For symlinks to files, store the symlink path as original and target as resolved
			fileInfo.push({
				originalPath: symlinkPath,
				resolvedPath: resolvedTarget,
			})
		} else if (stats.isDirectory()) {
			const anotherEntries = await fs.readdir(resolvedTarget, {
				withFileTypes: true,
				recursive: true,
			})
			// Collect promises for recursive calls within the directory
			const directoryPromises: Promise<void>[] = []
			for (const anotherEntry of anotherEntries) {
				directoryPromises.push(resolveDirectoryEntry(anotherEntry, resolvedTarget, fileInfo, depth + 1))
			}
			// Wait for all entries in the resolved directory to be processed
			await Promise.all(directoryPromises)
		} else if (stats.isSymbolicLink()) {
			// Handle nested symlinks by awaiting the recursive call
			await resolveSymLink(resolvedTarget, fileInfo, depth + 1)
		}
	} catch {
		// Skip invalid symlinks
	}
}

/**
 * Read all text files from a directory in alphabetical order
 */
export async function readTextFilesFromDirectory(
	dirPath: string,
): Promise<Array<{ filename: string; content: string }>> {
	try {
		const entries = await fs.readdir(dirPath, {
			withFileTypes: true,
			recursive: true,
		})

		// Process all entries - regular files and symlinks that might point to files
		// Store both original path (for sorting) and resolved path (for reading)
		const fileInfo: Array<{ originalPath: string; resolvedPath: string }> = []
		// Collect promises for the initial resolution calls
		const initialPromises: Promise<void>[] = []

		for (const entry of entries) {
			initialPromises.push(resolveDirectoryEntry(entry, dirPath, fileInfo, 0))
		}

		// Wait for all asynchronous operations (including recursive ones) to complete
		await Promise.all(initialPromises)

		const fileContents = await Promise.all(
			fileInfo.map(async ({ originalPath, resolvedPath }) => {
				try {
					// Check if it's a file (not a directory)
					const stats = await fs.stat(resolvedPath)
					if (stats.isFile()) {
						// Filter out cache files and system files that shouldn't be in rules
						if (!shouldIncludeRuleFile(resolvedPath)) {
							return null
						}
						const content = await safeReadFile(resolvedPath)
						// Use resolvedPath for display to maintain existing behavior
						return { filename: resolvedPath, content, sortKey: originalPath }
					}
					return null
				} catch {
					return null
				}
			}),
		)

		// Filter out null values (directories, failed reads, or excluded files)
		const filteredFiles = fileContents.filter(
			(item): item is { filename: string; content: string; sortKey: string } => item !== null,
		)

		// Sort files alphabetically by the original filename (case-insensitive) to ensure consistent order
		// For symlinks, this will use the symlink name, not the target name
		return filteredFiles
			.sort((a, b) => {
				const filenameA = path.basename(a.sortKey).toLowerCase()
				const filenameB = path.basename(b.sortKey).toLowerCase()
				return filenameA.localeCompare(filenameB)
			})
			.map(({ filename, content }) => ({ filename, content }))
	} catch {
		return []
	}
}

/**
 * Format content from multiple files with filenames as headers
 * @param files - Array of files with filename (absolute path) and content
 * @param cwd - Current working directory for computing relative paths
 */
export function formatDirectoryContent(files: Array<{ filename: string; content: string }>, cwd: string): string {
	if (files.length === 0) return ""

	return files
		.map((file) => {
			// Compute relative path for display
			const displayPath = path.relative(cwd, file.filename)
			return `# Rules from ${displayPath}:\n${file.content}`
		})
		.join("\n\n")
}

/**
 * Check if a file should be included in rule compilation.
 * Excludes cache files and system files that shouldn't be processed as rules.
 */
export function shouldIncludeRuleFile(filename: string): boolean {
	const basename = path.basename(filename)

	const cachePatterns = [
		"*.DS_Store",
		"*.bak",
		"*.cache",
		"*.crdownload",
		"*.db",
		"*.dmp",
		"*.dump",
		"*.eslintcache",
		"*.lock",
		"*.log",
		"*.old",
		"*.part",
		"*.partial",
		"*.pyc",
		"*.pyo",
		"*.stackdump",
		"*.swo",
		"*.swp",
		"*.temp",
		"*.tmp",
		"Thumbs.db",
	]

	return !cachePatterns.some((pattern) => {
		if (pattern.startsWith("*.")) {
			const extension = pattern.slice(1)
			return basename.endsWith(extension)
		} else {
			return basename === pattern
		}
	})
}

/**
 * Load rule files from global, project-local, and optionally subfolder directories
 * Rules are loaded in order: global first, then project-local, then subfolders (alphabetically)
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include rules from subdirectories (default: false)
 */
export async function loadRuleFiles(cwd: string, enableSubfolderRules: boolean = false): Promise<string> {
	const rules: string[] = []
	// Use recursive discovery only if enableSubfolderRules is true
	const rooDirectories = enableSubfolderRules
		? await getAllRooDirectoriesForCwd(cwd)
		: getRooDirectoriesForCwd(cwd)

	// Check for .njust_ai/rules/ directories in order (global, project-local, and optionally subfolders)
	for (const rooDir of rooDirectories) {
		const rulesDir = path.join(rooDir, "rules")
		if (await directoryExists(rulesDir)) {
			const files = await readTextFilesFromDirectory(rulesDir)
			if (files.length > 0) {
				const content = formatDirectoryContent(files, cwd)
				rules.push(content)
			}
		}
	}

	// If we found rules in config rules/ directories, return them
	if (rules.length > 0) {
		return `\n# Rules from ${NJUST_AI_CONFIG_DIR} directories:\n\n` + rules.join("\n\n")
	}

	// Fall back to existing behavior for legacy .roorules/.clinerules files
	const ruleFiles = [".roorules", ".clinerules"]

	for (const file of ruleFiles) {
		const content = await safeReadFile(path.join(cwd, file))
		if (content) {
			return `\n# Rules from ${file}:\n${content}\n`
		}
	}

	return ""
}

/**
 * Read content from an agent rules file (AGENTS.md, AGENT.md, etc.)
 * Handles symlink resolution.
 *
 * @param filePath - Full path to the agent rules file
 * @returns File content or empty string if file doesn't exist
 */
export async function readAgentRulesFile(filePath: string): Promise<string> {
	let resolvedPath = filePath

	// Check if file exists and handle symlinks
	try {
		const stats = await fs.lstat(filePath)
		if (stats.isSymbolicLink()) {
			// Create a temporary fileInfo array to use with resolveSymLink
			const fileInfo: Array<{
				originalPath: string
				resolvedPath: string
			}> = []

			// Use the existing resolveSymLink function to handle symlink resolution
			await resolveSymLink(filePath, fileInfo, 0)

			// Extract the resolved path from fileInfo
			if (fileInfo.length > 0) {
				resolvedPath = fileInfo[0]!.resolvedPath
			}
		}
	} catch {
		// If lstat fails (file doesn't exist), return empty
		return ""
	}

	// Read the content from the resolved path
	return safeReadFile(resolvedPath)
}

/**
 * Load AGENTS.md or AGENT.md file from a specific directory
 * Checks for both AGENTS.md (standard) and AGENT.md (alternative) for compatibility
 * Also loads AGENTS.local.md for personal overrides (not checked in to version control)
 * AGENTS.local.md can be loaded even if AGENTS.md doesn't exist
 *
 * @param directory - Directory to check for AGENTS.md
 * @param showPath - Whether to include the directory path in the header
 * @param cwd - Current working directory for computing relative paths (optional)
 */
export async function loadAgentRulesFileFromDirectory(
	directory: string,
	showPath: boolean = false,
	cwd?: string,
): Promise<string> {
	// Try both filenames - AGENTS.md (standard) first, then AGENT.md (alternative)
	const filenames = ["AGENTS.md", "AGENT.md"]
	const results: string[] = []
	const displayPath = cwd ? path.relative(cwd, directory) : directory

	for (const filename of filenames) {
		try {
			const agentPath = path.join(directory, filename)
			const content = await readAgentRulesFile(agentPath)

			if (content) {
				// Compute relative path for display if cwd is provided
				const header = showPath
					? `# Agent Rules Standard (${filename}) from ${displayPath}:`
					: `# Agent Rules Standard (${filename}):`
				results.push(`${header}\n${content}`)

				// Found a standard file, don't check alternative
				break
			}
		} catch {
			// Silently ignore errors - agent rules files are optional
		}
	}

	// Always try to load AGENTS.local.md for personal overrides (even if AGENTS.md doesn't exist)
	try {
		const localFilename = "AGENTS.local.md"
		const localPath = path.join(directory, localFilename)
		const localContent = await readAgentRulesFile(localPath)

		if (localContent) {
			const localHeader = showPath
				? `# Agent Rules Local (${localFilename}) from ${displayPath}:`
				: `# Agent Rules Local (${localFilename}):`
			results.push(`${localHeader}\n${localContent}`)
		}
	} catch {
		// Silently ignore errors - local agent rules file is optional
	}

	return results.join("\n\n")
}

/**
 * Load all AGENTS.md files from project root and optionally subdirectories with .njust_ai folders
 * Returns combined content with clear path headers for each file
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include AGENTS.md from subdirectories (default: false)
 * @returns Combined AGENTS.md content from all locations
 */
export async function loadAllAgentRulesFiles(
	cwd: string,
	enableSubfolderRules: boolean = false,
): Promise<string> {
	const agentRules: string[] = []

	// When subfolder rules are disabled, only load from root
	if (!enableSubfolderRules) {
		const content = await loadAgentRulesFileFromDirectory(cwd, false, cwd)
		if (content?.trim()) {
			agentRules.push(content.trim())
		}
		return agentRules.join("\n\n")
	}

	// When enabled, load from root and all subdirectories with .njust_ai folders
	const directories = await getAgentsDirectoriesForCwd(cwd)

	for (const directory of directories) {
		// Show path for all directories except the root
		const showPath = directory !== cwd
		const content = await loadAgentRulesFileFromDirectory(directory, showPath, cwd)
		if (content?.trim()) {
			agentRules.push(content.trim())
		}
	}

	return agentRules.join("\n\n")
}

function getGlobalNjustDirectory(): string {
	return path.join(os.homedir(), ".njust")
}

function getProjectNjustDirectory(cwd: string): string {
	return path.join(cwd, ".njust")
}

/**
 * Return .njust directories ordered: global first, then project-local.
 */
function getNjustDirectories(cwd: string): string[] {
	return [getGlobalNjustDirectory(), getProjectNjustDirectory(cwd)]
}

/**
 * Load learned fixes for a specific mode from global (~/.njust) and project-local (.njust) directories.
 * Supports two files per scope:
 *   - learned-fixes/{mode}.md  — structured fix entries
 *   - learned-fixes/{mode}-summary.md — condensed high-frequency patterns (loaded first for priority)
 *
 * These are accumulated error-fix patterns recorded by the AI across sessions,
 * enabling progressive improvement in solving recurring problems.
 */
export async function loadLearnedFixes(cwd: string, mode: string): Promise<string> {
	if (!mode) return ""

	const sections: string[] = []
	const njustDirs = getNjustDirectories(cwd)

	for (const njustDir of njustDirs) {
		const isGlobal = njustDir === getGlobalNjustDirectory()
		const scope = isGlobal ? "global" : "project"
		const fixesDir = path.join(njustDir, "learned-fixes")

		const summaryFile = path.join(fixesDir, `${mode}-summary.md`)
		const summaryContent = await safeReadFile(summaryFile)
		if (summaryContent) {
			sections.push(`<!-- ${scope}: high-frequency summary -->\n${summaryContent}`)
		}

		const fullFile = path.join(fixesDir, `${mode}.md`)
		const fullContent = await safeReadFile(fullFile)
		if (fullContent) {
			sections.push(`<!-- ${scope}: full fix log -->\n${fullContent}`)
		}
	}

	if (sections.length === 0) return ""

	return sections.join("\n\n---\n\n")
}

/**
 * Load mode-specific rule files from rules-{mode} directories and legacy files.
 *
 * @param cwd - Current working directory (project root)
 * @param mode - The mode name (e.g. "code", "architect")
 * @param enableSubfolderRules - Whether to include rules from subdirectories
 * @returns Object with modeRuleContent and usedRuleFile
 */
export async function loadModeRules(
	cwd: string,
	mode: string,
	enableSubfolderRules: boolean = false,
): Promise<{ modeRuleContent: string; usedRuleFile: string }> {
	let modeRuleContent = ""
	let usedRuleFile = ""

	const modeRules: string[] = []
	// Use recursive discovery only if enableSubfolderRules is true
	const rooDirectories = enableSubfolderRules
		? await getAllRooDirectoriesForCwd(cwd)
		: getRooDirectoriesForCwd(cwd)

	// Check for .njust_ai/rules-{mode}/ directories in order (global, project-local, and optionally subfolders)
	for (const rooDir of rooDirectories) {
		const modeRulesDir = path.join(rooDir, `rules-${mode}`)
		if (await directoryExists(modeRulesDir)) {
			const files = await readTextFilesFromDirectory(modeRulesDir)
			if (files.length > 0) {
				const content = formatDirectoryContent(files, cwd)
				modeRules.push(content)
			}
		}
	}

	// Workspace-root `.njust-ai/rules-{mode}/` (parallel to `.njust_ai/rules-{mode}/`) for hot-reload + mirror layouts.
	const legacyRooModeDir = path.join(cwd, ".njust-ai", `rules-${mode}`)
	if (await directoryExists(legacyRooModeDir)) {
		const files = await readTextFilesFromDirectory(legacyRooModeDir)
		if (files.length > 0) {
			modeRules.push(formatDirectoryContent(files, cwd))
		}
	}

	// If we found mode-specific rules in .njust_ai/rules-{mode}/ directories, use them
	if (modeRules.length > 0) {
		modeRuleContent = "\n" + modeRules.join("\n\n")
		usedRuleFile = `rules-${mode} directories`
	} else {
		// Fall back to existing behavior for legacy files
		const rooModeRuleFile = `.roorules-${mode}`
		modeRuleContent = await safeReadFile(path.join(cwd, rooModeRuleFile))
		if (modeRuleContent) {
			usedRuleFile = rooModeRuleFile
		} else {
			const clineModeRuleFile = `.clinerules-${mode}`
			modeRuleContent = await safeReadFile(path.join(cwd, clineModeRuleFile))
			if (modeRuleContent) {
				usedRuleFile = clineModeRuleFile
			}
		}
	}

	return { modeRuleContent, usedRuleFile }
}

/**
 * Load generic rules for the project.
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include rules from subdirectories
 * @returns Generic rules content or empty string
 */
export async function loadGenericRules(cwd: string, enableSubfolderRules: boolean = false): Promise<string> {
	const genericRuleContent = await loadRuleFiles(cwd, enableSubfolderRules)
	return genericRuleContent?.trim() || ""
}

/**
 * Load agent rules if the setting is enabled.
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include rules from subdirectories
 * @param useAgentRules - Whether agent rules are enabled
 * @returns Agent rules content or empty string
 */
export async function loadAgentRulesIfEnabled(
	cwd: string,
	enableSubfolderRules: boolean = false,
	useAgentRules: boolean = true,
): Promise<string> {
	if (!useAgentRules) return ""

	const agentRulesContent = await loadAllAgentRulesFiles(cwd, enableSubfolderRules)
	return agentRulesContent?.trim() || ""
}
