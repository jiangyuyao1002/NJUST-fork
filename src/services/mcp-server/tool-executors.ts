import * as fs from "fs/promises"
import * as path from "path"
import * as childProcess from "child_process"

import { createDirectoriesForFile, fileExistsAtPath } from "../../utils/fs"
import { regexSearchFiles } from "../../services/ripgrep"
import { listFiles } from "../../services/glob/list-files"
import { checkCommandSafety } from "../../core/tools/helpers/commandSafety"
import { filterSensitiveEnv } from "../../utils/env"
import { getCommandDecision } from "../../core/auto-approval"
import { parseCommand } from "../../shared/parse-command"
import { detectCangjieHome } from "../cangjie-lsp/cangjieToolUtils"
import type { IPathValidator, IWriteProtector } from "../cloud-agent/interfaces/IPathAccessController"

function extractFirstCommandToken(command: string): string {
	const trimmed = command.trim()
	if (trimmed.startsWith('"')) {
		const endQuote = trimmed.indexOf('"', 1)
		return endQuote > 0 ? trimmed.slice(1, endQuote) : trimmed
	}
	if (trimmed.startsWith("'")) {
		const endQuote = trimmed.indexOf("'", 1)
		return endQuote > 0 ? trimmed.slice(1, endQuote) : trimmed
	}
	const spaceIdx = trimmed.search(/\s/)
	return spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed
}

const COMMAND_CHAIN_RE = /(?:^|\s)(?:&&|\|\||[;&|])(?:\s|$)|[\r\n]/

/**
 * Hard defense against command injection via subshell and command substitution.
 * Catches $(), backtick-based substitution, and other shell injection primitives.
 * This check is unconditional — it runs regardless of allowlist/denylist/cangjie SDK path.
 */
const COMMAND_INJECTION_RE = /\$\(|`/

/**
 * Resolves the real path of a file, handling non-existent files by
 * finding the nearest existing parent directory and resolving symlinks.
 */
async function resolveRealPath(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath)
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
				const realParent = await fs.realpath(parent)
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
 * Ensures a resolved path stays within the workspace boundary (after realpath, to reduce symlink escape).
 * Throws if the path attempts to escape.
 */
async function ensureWithinWorkspace(cwd: string, relPath: string): Promise<string> {
	const resolved = path.resolve(cwd, relPath)
	const base = await resolveRealPath(path.resolve(cwd))

	// Validate the resolved path stays within the workspace boundary.
	// On Unix, path.relative is the canonical check since filesystems are case-sensitive.
	// On Windows, NTFS/FAT are case-insensitive so we normalize case before comparing,
	// as path.relative only compares character-by-character.
	const isWithin = (parent: string, child: string): boolean => {
		if (process.platform === "win32") {
			const p = parent.toLowerCase()
			const c = child.toLowerCase()
			return c.startsWith(p + path.sep) || c === p
		}
		const rel = path.relative(parent, child)
		return !rel.startsWith("..") && !path.isAbsolute(rel)
	}

	const target = await resolveRealPath(resolved)
	if (!isWithin(base, target)) {
		throw new Error(`Path escapes workspace boundary: ${relPath}`)
	}
	return target
}

export interface ReadFileParams {
	path: string
	start_line?: number
	end_line?: number
}

export async function execReadFile(cwd: string, params: ReadFileParams): Promise<string> {
	const absPath = await ensureWithinWorkspace(cwd, params.path)

	if (!(await fileExistsAtPath(absPath))) {
		throw new Error(`File not found: ${params.path}`)
	}

	const stat = await fs.stat(absPath)
	if (stat.isDirectory()) {
		throw new Error(`Path is a directory, not a file: ${params.path}`)
	}

	const content = await fs.readFile(absPath, "utf-8")
	const lines = content.split("\n")

	const startLine = Math.max(1, params.start_line ?? 1)
	const endLine = Math.min(lines.length, params.end_line ?? lines.length)

	const selectedLines = lines.slice(startLine - 1, endLine)
	const numbered = selectedLines.map((line, i) => `${startLine + i} | ${line}`).join("\n")

	return numbered
}

export interface WriteFileParams {
	path: string
	content: string
}

export async function execWriteFile(
	cwd: string,
	params: WriteFileParams,
	writeProtector?: IWriteProtector,
): Promise<string> {
	const absPath = await ensureWithinWorkspace(cwd, params.path)
	if (writeProtector && (await writeProtector.isWriteProtected(params.path))) {
		throw new Error(`File is write-protected: ${params.path}`)
	}

	const isNew = !(await fileExistsAtPath(absPath))
	if (isNew) {
		await createDirectoriesForFile(absPath)
	}

	await fs.writeFile(absPath, params.content, "utf-8")

	return isNew ? `Created new file: ${params.path}` : `Updated file: ${params.path}`
}

export interface ListFilesParams {
	path: string
	recursive?: boolean
}

export async function execListFiles(
	cwd: string,
	params: ListFilesParams,
	pathValidator?: IPathValidator,
): Promise<string> {
	const absPath = await ensureWithinWorkspace(cwd, params.path)

	if (!(await fileExistsAtPath(absPath))) {
		throw new Error(`Directory not found: ${params.path}`)
	}

	const [files, didHitLimit] = await listFiles(absPath, params.recursive ?? false, 500)

	const relFiles = files
		.map((f) => path.relative(cwd, f).replace(/\\/g, "/"))
		.filter((relPath) => !pathValidator || pathValidator.validateAccess(relPath))
	let result = relFiles.join("\n")

	if (didHitLimit) {
		result += "\n\n(Results truncated — limit reached)"
	}

	return result || "(Empty directory)"
}

export interface SearchFilesParams {
	path: string
	regex: string
	file_pattern?: string
}

export async function execSearchFiles(
	cwd: string,
	params: SearchFilesParams,
	pathValidator?: IPathValidator,
): Promise<string> {
	const absPath = await ensureWithinWorkspace(cwd, params.path)

	if (!(await fileExistsAtPath(absPath))) {
		throw new Error(`Directory not found: ${params.path}`)
	}

	return await regexSearchFiles(cwd, absPath, params.regex, params.file_pattern, pathValidator)
}

export interface ExecuteCommandParams {
	command: string
	cwd?: string
	timeout?: number
}

export async function execCommand(
	workspaceCwd: string,
	params: ExecuteCommandParams,
	allowedCommands?: string[],
	deniedCommands?: string[],
): Promise<string> {
	let execCwd = workspaceCwd
	if (params.cwd) {
		const resolvedCwd = path.isAbsolute(params.cwd) ? params.cwd : path.resolve(workspaceCwd, params.cwd)
		execCwd = await ensureWithinWorkspace(workspaceCwd, resolvedCwd)
	}

	// Unconditional command injection guard: reject $() and backtick-based
	// command substitution regardless of allowlist, denylist, or cangjie SDK
	// path checks. This is the first line of defense.
	if (COMMAND_INJECTION_RE.test(params.command)) {
		throw new Error(
			`Command injection detected in MCP context: command substitution via $() or backticks is not allowed`,
		)
	}

	// Use the full command decision logic that properly handles:
	// - Command chaining (&&, ||, ;, |, &)
	// - Longest prefix match for allow/deny lists
	// - Conflict resolution between allowed and denied commands
	if (allowedCommands?.length || deniedCommands?.length) {
		const decision = getCommandDecision(params.command, allowedCommands ?? [], deniedCommands ?? [])

		if (decision === "auto_deny") {
			throw new Error(`Command denied by policy: ${params.command}`)
		}

		if (decision === "ask_user") {
			const cangjieHome = detectCangjieHome()
			if (cangjieHome) {
				// 逐命令验证：解析子命令，拒绝多命令链
				const subCommands = parseCommand(params.command)
				if (subCommands.length > 1) {
					throw new Error(`Command requires explicit approval: ${params.command}`)
				}
				if (subCommands.length === 0 || COMMAND_CHAIN_RE.test(params.command)) {
					throw new Error(`Command requires explicit approval: ${params.command}`)
				}
				const firstToken = extractFirstCommandToken(subCommands[0]!)
				const normalizedHome = path.normalize(cangjieHome) + path.sep
				const normalizedToken = path.normalize(firstToken)
				const isSdkCommand =
					process.platform === "win32"
						? normalizedToken.toLowerCase().startsWith(normalizedHome.toLowerCase())
						: normalizedToken.startsWith(normalizedHome)
				if (!isSdkCommand) {
					throw new Error(`Command requires explicit approval: ${params.command}`)
				}
			} else {
				throw new Error(`Command requires explicit approval: ${params.command}`)
			}
		}
	}

	// Run the same security analysis used by the interactive execute_command tool.
	// In MCP context, both forbidden AND dangerous patterns are rejected —
	// there is no interactive user to confirm the risk.
	const safetyCheck = checkCommandSafety(params.command)
	if (safetyCheck.riskLevel === "forbidden" || safetyCheck.riskLevel === "dangerous") {
		throw new Error(`Command blocked for safety (${safetyCheck.riskLevel}): ${safetyCheck.reasons.join("; ")}`)
	}

	// Hard defense: reject command chains even if previous checks were bypassed
	if (COMMAND_CHAIN_RE.test(params.command)) {
		throw new Error(
			`Command contains shell chaining operators (&&, ||, ;, |, &) which are not allowed in MCP context: ${params.command}`,
		)
	}

	const timeoutMs = Math.max(1, Math.min(300, params.timeout ?? 30)) * 1000

	return new Promise<string>((resolve, reject) => {
		const isWindows = process.platform === "win32"
		const shell = isWindows ? "cmd.exe" : "/bin/sh"
		const shellArgs = isWindows ? ["/c", params.command] : ["-c", params.command]

		const proc = childProcess.spawn(shell, shellArgs, {
			cwd: execCwd,
			env: filterSensitiveEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stdout = ""
		let stderr = ""

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString()
		})
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString()
		})

		const timer = setTimeout(() => {
			proc.kill("SIGTERM")
			reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`))
		}, timeoutMs)

		proc.on("close", (code) => {
			clearTimeout(timer)
			const output = [
				`Exit code: ${code ?? "unknown"}`,
				stdout ? `\nSTDOUT:\n${stdout}` : "",
				stderr ? `\nSTDERR:\n${stderr}` : "",
			].join("")

			resolve(output)
		})

		proc.on("error", (err) => {
			clearTimeout(timer)
			reject(new Error(`Failed to execute command: ${err.message}`))
		})
	})
}

export interface ApplyDiffParams {
	path: string
	diff: string
}

export async function execApplyDiff(
	cwd: string,
	params: ApplyDiffParams,
	writeProtector?: IWriteProtector,
): Promise<string> {
	const absPath = await ensureWithinWorkspace(cwd, params.path)
	if (writeProtector && (await writeProtector.isWriteProtected(params.path))) {
		throw new Error(`File is write-protected: ${params.path}`)
	}

	if (!(await fileExistsAtPath(absPath))) {
		throw new Error(`File not found: ${params.path}`)
	}

	const originalContent = await fs.readFile(absPath, "utf-8")

	const { MultiSearchReplaceDiffStrategy } = await import("../../core/diff/strategies/multi-search-replace")
	const strategy = new MultiSearchReplaceDiffStrategy()
	const result = await strategy.applyDiff(originalContent, params.diff)

	if (!result.success) {
		const errorMsg = "error" in result ? result.error : "Diff application failed"
		throw new Error(`Failed to apply diff to ${params.path}: ${errorMsg}`)
	}

	await fs.writeFile(absPath, result.content, "utf-8")
	return `Successfully applied diff to ${params.path}`
}
