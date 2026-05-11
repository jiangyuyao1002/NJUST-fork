import fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"
import { isBinaryFile } from "isbinaryfile"

import { mentionRegexGlobal, commandRegexGlobal, unescapeSpaces } from "../../shared/context-mentions"

import { getCommitInfo, getWorkingState } from "../../utils/git"

import { openFile } from "../../integrations/misc/open-file"
import { extractTextFromFileWithMetadata, type ExtractTextResult } from "../../integrations/misc/extract-text"
import { diagnosticsToProblemsString } from "../../integrations/diagnostics"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"

import { FileContextTracker } from "../context-tracking/FileContextTracker"

import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { getCommand, type Command } from "../../services/command/commands"
import { buildSkillResult, resolveSkillContentForMode, type SkillLookup } from "../../services/skills/skillInvocation"
import type { SkillContent } from "../../shared/skills"
import { getErrorMessage } from "../../shared/error-utils"

export async function openMention(cwd: string, mention?: string): Promise<void> {
	if (!mention) {
		return
	}

	if (mention.startsWith("/")) {
		// Slice off the leading slash and unescape any spaces in the path
		const relPath = unescapeSpaces(mention.slice(1))
		const absPath = path.resolve(cwd, relPath)
		if (mention.endsWith("/")) {
			vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(absPath))
		} else {
			void openFile(absPath)
		}
	} else if (mention === "problems") {
		vscode.commands.executeCommand("workbench.actions.view.problems")
	} else if (mention === "terminal") {
		vscode.commands.executeCommand("workbench.action.terminal.focus")
	} else if (mention.startsWith("http")) {
		vscode.env.openExternal(vscode.Uri.parse(mention))
	}
}

/**
 * Represents a content block generated from an @ mention.
 * These are returned separately from the user's text to enable
 * proper formatting as distinct message blocks.
 */
export interface MentionContentBlock {
	type: "file" | "folder" | "url" | "diagnostics" | "git_changes" | "git_commit" | "terminal" | "command"
	/** Path for file/folder mentions */
	path?: string
	/** The content to display */
	content: string
	/** Metadata about truncation (for files) */
	metadata?: {
		totalLines: number
		returnedLines: number
		wasTruncated: boolean
		linesShown?: [number, number]
	}
}

export interface ParseMentionsResult {
	/** User's text with @ mentions replaced by clean path references */
	text: string
	/** Separate content blocks for each mention (file content, URLs, etc.) */
	contentBlocks: MentionContentBlock[]
	slashCommandHelp?: string
	mode?: string // Mode from the first slash command that has one
}

/**
 * Formats file content to look like a read_file tool result.
 * Includes Gemini-style truncation warning when content is truncated.
 */
function formatFileReadResult(filePath: string, result: ExtractTextResult): string {
	const header = `[read_file for '${filePath}']`

	if (result.wasTruncated && result.linesShown) {
		const [start, end] = result.linesShown
		const nextOffset = end + 1
		return `${header}
IMPORTANT: File content truncated.
Status: Showing lines ${start}-${end} of ${result.totalLines} total lines.
To read more: Use the read_file tool with offset=${nextOffset} and limit=${DEFAULT_LINE_LIMIT}.

File: ${filePath}
${result.content}`
	}

	return `${header}
File: ${filePath}
${result.content}`
}

export async function parseMentions(
	text: string,
	cwd: string,
	fileContextTracker?: FileContextTracker,
	rooIgnoreController?: RooIgnoreController,
	showRooIgnoredFiles: boolean = false,
	includeDiagnosticMessages: boolean = true,
	maxDiagnosticMessages: number = 50,
	skillsManager?: SkillLookup,
	currentMode: string = "code",
): Promise<ParseMentionsResult> {
	const mentions: Set<string> = new Set()
	const validCommands: Map<string, Command> = new Map()
	const validSkills: Map<string, SkillContent> = new Map()
	const contentBlocks: MentionContentBlock[] = []
	let commandMode: string | undefined // Track mode from the first slash command that has one

	// First pass: check which command mentions exist and cache the results
	const commandMatches = Array.from(text.matchAll(commandRegexGlobal))
	const uniqueCommandNames = new Set(commandMatches.map(([, commandName]) => commandName))

	const commandExistenceChecks = await Promise.all(
		Array.from(uniqueCommandNames).map(async (commandName) => {
			try {
				const command = await getCommand(cwd, commandName)
				if (command) {
					return { commandName, command, skillContent: null }
				}

				const skillContent = await resolveSkillContentForMode(skillsManager, commandName, currentMode)
				return { commandName, command: undefined, skillContent }
			} catch {
				// If there's an error checking command existence, treat it as non-existent
				return { commandName, command: undefined, skillContent: null }
			}
		}),
	)

	// Store valid commands for later use and capture the first mode found
	for (const { commandName, command, skillContent } of commandExistenceChecks) {
		if (command) {
			validCommands.set(commandName, command)
			// Capture the mode from the first command that has one
			if (!commandMode && command.mode) {
				commandMode = command.mode
			}
			continue
		}

		if (skillContent) {
			validSkills.set(commandName, skillContent)
		}
	}

	// Only replace text for commands that actually exist (keep "see below" for commands)
	let parsedText = text
	for (const [match, commandName] of commandMatches) {
		if (validCommands.has(commandName) || validSkills.has(commandName)) {
			parsedText = parsedText.replace(match, `Command '${commandName}' (see below for command content)`)
		}
	}

	// Second pass: handle regular mentions - replace with clean references
	// Content will be provided as separate blocks that look like read_file results
	parsedText = parsedText.replace(mentionRegexGlobal, (match, mention) => {
		mentions.add(mention)
		if (mention.startsWith("http")) {
			return `'${mention}'`
		} else if (mention.startsWith("/")) {
			// Clean path reference - no "see below" since we format like tool results
			const mentionPath = mention.slice(1)
			return mentionPath.endsWith("/") ? `'${mentionPath}'` : `'${mentionPath}'`
		} else if (mention === "problems") {
			return `Workspace Problems (see below for diagnostics)`
		} else if (mention === "git-changes") {
			return `Working directory changes (see below for details)`
		} else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			return `Git commit '${mention}' (see below for commit info)`
		} else if (mention === "terminal") {
			return `Terminal Output (see below for output)`
		}
		return match
	})

	for (const mention of mentions) {
		if (mention.startsWith("/")) {
			const mentionPath = mention.slice(1)
			try {
				const fileResult = await getFileOrFolderContentWithMetadata(
					mentionPath,
					cwd,
					rooIgnoreController,
					showRooIgnoredFiles,
					fileContextTracker,
				)
				contentBlocks.push(fileResult)
			} catch (error) {
				const errorMsg = getErrorMessage(error)
				contentBlocks.push({
					type: mention.endsWith("/") ? "folder" : "file",
					path: mentionPath,
					content: `[read_file for '${mentionPath}']\nError: ${errorMsg}`,
				})
			}
		} else if (mention === "problems") {
			try {
				const problems = await getWorkspaceProblems(cwd, includeDiagnosticMessages, maxDiagnosticMessages)
				parsedText += `\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
			} catch (error) {
				parsedText += `\n\n<workspace_diagnostics>\nError fetching diagnostics: ${getErrorMessage(error)}\n</workspace_diagnostics>`
			}
		} else if (mention === "git-changes") {
			try {
				const workingState = await getWorkingState(cwd)
				parsedText += `\n\n<git_working_state>\n${workingState}\n</git_working_state>`
			} catch (error) {
				parsedText += `\n\n<git_working_state>\nError fetching working state: ${getErrorMessage(error)}\n</git_working_state>`
			}
		} else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			try {
				const commitInfo = await getCommitInfo(mention, cwd)
				parsedText += `\n\n<git_commit hash="${mention}">\n${commitInfo}\n</git_commit>`
			} catch (error) {
				parsedText += `\n\n<git_commit hash="${mention}">\nError fetching commit info: ${getErrorMessage(error)}\n</git_commit>`
			}
		} else if (mention === "terminal") {
			try {
				const terminalOutput = await getLatestTerminalOutput()
				parsedText += `\n\n<terminal_output>\n${terminalOutput}\n</terminal_output>`
			} catch (error) {
				parsedText += `\n\n<terminal_output>\nError fetching terminal output: ${getErrorMessage(error)}\n</terminal_output>`
			}
		}
	}

	// Process valid command mentions using cached results
	let slashCommandHelp = ""
	for (const [commandName, command] of validCommands) {
		try {
			let commandOutput = ""
			if (command.description) {
				commandOutput += `Description: ${command.description}\n\n`
			}
			commandOutput += command.content
			slashCommandHelp += `\n\n<command name="${commandName}">\n${commandOutput}\n</command>`
		} catch (error) {
			slashCommandHelp += `\n\n<command name="${commandName}">\nError loading command '${commandName}': ${getErrorMessage(error)}\n</command>`
		}
	}

	for (const [skillName, skillContent] of validSkills) {
		slashCommandHelp += `\n\n${buildSkillResult(skillName, undefined, skillContent)}`
	}

	return {
		text: parsedText,
		contentBlocks,
		mode: commandMode,
		slashCommandHelp: slashCommandHelp.trim() || undefined,
	}
}

/**
 * Gets file or folder content and returns it as a MentionContentBlock
 * formatted to look like a read_file tool result.
 */
async function getFileOrFolderContentWithMetadata(
	mentionPath: string,
	cwd: string,
	rooIgnoreController?: any,
	showRooIgnoredFiles: boolean = false,
	fileContextTracker?: FileContextTracker,
): Promise<MentionContentBlock> {
	const unescapedPath = unescapeSpaces(mentionPath)
	const absPath = path.resolve(cwd, unescapedPath)
	const isFolder = mentionPath.endsWith("/")

	try {
		const stats = await fs.stat(absPath)

		if (stats.isFile()) {
			// Avoid trying to include image binary content as text context.
			// Image mentions are handled separately via image attachment flow.
			const isBinary = await isBinaryFile(absPath).catch(() => false)
			if (isBinary) {
				return {
					type: "file",
					path: mentionPath,
					content: `[read_file for '${mentionPath}']\nNote: Binary file omitted from context.`,
				}
			}
			if (rooIgnoreController && !rooIgnoreController.validateAccess(unescapedPath)) {
				return {
					type: "file",
					path: mentionPath,
					content: `[read_file for '${mentionPath}']\nNote: File is ignored by .rooignore.`,
				}
			}
			try {
				const result = await extractTextFromFileWithMetadata(absPath)

				// Track file context
				if (fileContextTracker) {
					await fileContextTracker.trackFileContext(mentionPath, "file_mentioned")
				}

				return {
					type: "file",
					path: mentionPath,
					content: formatFileReadResult(mentionPath, result),
					metadata: {
						totalLines: result.totalLines,
						returnedLines: result.returnedLines,
						wasTruncated: result.wasTruncated,
						linesShown: result.linesShown,
					},
				}
			} catch (error) {
				const errorMsg = getErrorMessage(error)
				return {
					type: "file",
					path: mentionPath,
					content: `[read_file for '${mentionPath}']\nError: ${errorMsg}`,
				}
			}
		} else if (stats.isDirectory()) {
			const entries = await fs.readdir(absPath, { withFileTypes: true })
			let folderListing = ""
			const fileReadResults: string[] = []
			const LOCK_SYMBOL = "🔒"
			const MAX_FOLDER_FILES = 200
			const MAX_FOLDER_CONTENT_BYTES = 512 * 1024
			let totalContentBytes = 0

			for (let index = 0; index < entries.length; index++) {
				if (index >= MAX_FOLDER_FILES) {
					folderListing += `... (${entries.length - MAX_FOLDER_FILES} more entries omitted)\n`
					break
				}

				const entry = entries[index]
				const isLast = index === entries.length - 1
				const linePrefix = isLast ? "└── " : "├── "
				const entryPath = path.join(absPath, entry.name)

				let isIgnored = false
				if (rooIgnoreController) {
					isIgnored = !rooIgnoreController.validateAccess(entryPath)
				}

				if (isIgnored && !showRooIgnoredFiles) {
					continue
				}

				const displayName = isIgnored ? `${LOCK_SYMBOL} ${entry.name}` : entry.name

				if (entry.isFile()) {
					folderListing += `${linePrefix}${displayName}\n`
					if (!isIgnored && totalContentBytes < MAX_FOLDER_CONTENT_BYTES) {
						const filePath = path.join(mentionPath, entry.name)
						const absoluteFilePath = path.resolve(absPath, entry.name)
						try {
							const isBinary = await isBinaryFile(absoluteFilePath).catch(() => false)
							if (!isBinary) {
								const result = await extractTextFromFileWithMetadata(absoluteFilePath)
								const formatted = formatFileReadResult(filePath.toPosix(), result)
								totalContentBytes += formatted.length
								fileReadResults.push(formatted)
							}
						} catch {
							// Skip files that can't be read
						}
					}
				} else if (entry.isDirectory()) {
					folderListing += `${linePrefix}${displayName}/\n`
				} else {
					folderListing += `${linePrefix}${displayName}\n`
				}
			}

			// Format folder content similar to read_file output
			let content = `[read_file for folder '${mentionPath}']\nFolder listing:\n${folderListing}`
			if (fileReadResults.length > 0) {
				content += `\n\n--- File Contents ---\n\n${fileReadResults.join("\n\n")}`
			}

			return {
				type: "folder",
				path: mentionPath,
				content,
			}
		} else {
			return {
				type: isFolder ? "folder" : "file",
				path: mentionPath,
				content: `[read_file for '${mentionPath}']\nError: Unable to read (not a file or directory)`,
			}
		}
	} catch (error) {
		const errorMsg = getErrorMessage(error)
		throw new Error(`Failed to access path "${mentionPath}": ${errorMsg}`)
	}
}

async function getWorkspaceProblems(
	cwd: string,
	includeDiagnosticMessages: boolean = true,
	maxDiagnosticMessages: number = 50,
): Promise<string> {
	const diagnostics = vscode.languages.getDiagnostics()
	const result = await diagnosticsToProblemsString(
		diagnostics,
		[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
		cwd,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
	)
	if (!result) {
		return "No errors or warnings detected."
	}
	return result
}

/**
 * Gets the contents of the active terminal
 * @returns The terminal contents as a string
 */
export async function getLatestTerminalOutput(): Promise<string> {
	// SECURITY NOTE: VS Code does not expose a non-clipboard API for reading
	// terminal buffer contents.  During the brief window between writing to the
	// clipboard (steps below) and restoring the original content, any process
	// with clipboard access can observe the terminal output.  This is an
	// inherent limitation of the VS Code extension API.
	const nonce = `__terminal_capture_${Date.now()}_${Math.random().toString(36).slice(2)}__`
	const originalClipboard = await vscode.env.clipboard.readText()

	try {
		// Write nonce so we can tell whether the copy overwrote it.
		await vscode.env.clipboard.writeText(nonce)

		await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
		await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
		await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")

		let terminalContents = (await vscode.env.clipboard.readText()).trim()

		if (terminalContents === nonce) {
			return ""
		}

		const lines = terminalContents.split("\n")
		const lastLine = lines.pop()?.trim()

		if (lastLine) {
			let i = lines.length - 1

			while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
				i--
			}

			terminalContents = lines.slice(Math.max(i, 0)).join("\n")
		}

		return terminalContents
	} finally {
		// Restore original clipboard content as quickly as possible.
		await vscode.env.clipboard.writeText(originalClipboard)
	}
}

// Export processUserContentMentions from its own file
export { processUserContentMentions } from "./processUserContentMentions"
export type { ProcessUserContentMentionsResult } from "./processUserContentMentions"
