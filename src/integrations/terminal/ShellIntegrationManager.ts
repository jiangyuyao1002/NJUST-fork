import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"

export class ShellIntegrationManager {
	public static terminalTmpDirs: Map<number, string> = new Map()

	/**
	 * Initialize a temporary directory for ZDOTDIR
	 * @param env The environment variables object to modify
	 * @returns The path to the temporary directory
	 */
	public static zshInitTmpDir(env: Record<string, string>): string {
		// Create a temporary directory with the sticky bit set for security
		const tmpDir = path.join(os.tmpdir(), `njust-ai-zdotdir-${Math.random().toString(36).substring(2, 15)}`)
		logger.info("ShellIntegrationManager", `Creating temporary directory for ZDOTDIR: ${tmpDir}`)

		// Save original ZDOTDIR as NJUST_AI_ZDOTDIR
		if (process.env.ZDOTDIR) {
			env.NJUST_AI_ZDOTDIR = process.env.ZDOTDIR
		}

		// Create the temporary directory
		vscode.workspace.fs
			.createDirectory(vscode.Uri.file(tmpDir))
			.then(() => {
				logger.info("ShellIntegrationManager", `Created temporary directory for ZDOTDIR at ${tmpDir}`)

				// Create .zshrc in the temporary directory
				const zshrcPath = `${tmpDir}/.zshrc`

				// Get the path to the shell integration script
				const shellIntegrationPath = this.getShellIntegrationPath("zsh")

				const zshrcContent = `
	source "${shellIntegrationPath}"
	ZDOTDIR=\${NJUST_AI_ZDOTDIR:-$HOME}
	unset NJUST_AI_ZDOTDIR
	[ -f "$ZDOTDIR/.zshenv" ] && source "$ZDOTDIR/.zshenv"
	[ -f "$ZDOTDIR/.zprofile" ] && source "$ZDOTDIR/.zprofile"
	[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
	[ -f "$ZDOTDIR/.zlogin" ] && source "$ZDOTDIR/.zlogin"
	[ "$ZDOTDIR" = "$HOME" ] && unset ZDOTDIR
	`
				logger.info("ShellIntegrationManager", `Creating .zshrc file at ${zshrcPath} with content:\n${zshrcContent}`)
				vscode.workspace.fs.writeFile(vscode.Uri.file(zshrcPath), Buffer.from(zshrcContent)).then(
					// Success handler
					() => {
						logger.info("ShellIntegrationManager", `Successfully created .zshrc file at ${zshrcPath}`)
					},
					// Error handler
					(error: Error) => {
						logger.error("ShellIntegrationManager", `Error creating .zshrc file at ${zshrcPath}: ${error}`)
					},
				)
			})
			.then(undefined, (error: Error) => {
				logger.error("ShellIntegrationManager", `Error creating temporary directory at ${tmpDir}: ${error}`)
			})

		return tmpDir
	}

	/**
	 * Clean up a temporary directory used for ZDOTDIR
	 */
	public static zshCleanupTmpDir(terminalId: number): boolean {
		const tmpDir = this.terminalTmpDirs.get(terminalId)

		if (!tmpDir) {
			return false
		}

		const logPrefix = `Cleaning up temporary directory for terminal ${terminalId}`
		logger.info("ShellIntegrationManager", `${logPrefix}: ${tmpDir}`)

		try {
			// Remove .zshrc file
			const zshrcPath = path.join(tmpDir, ".zshrc")
			if (fs.existsSync(zshrcPath)) {
				logger.info("ShellIntegrationManager", `Removing .zshrc file at ${zshrcPath}`)
				fs.unlinkSync(zshrcPath)
			}

			// Remove the directory
			if (fs.existsSync(tmpDir)) {
				logger.info("ShellIntegrationManager", `Removing directory at ${tmpDir}`)
				fs.rmdirSync(tmpDir)
			}

			// Remove it from the map
			this.terminalTmpDirs.delete(terminalId)
			logger.info("ShellIntegrationManager", `Removed terminal ${terminalId} from temporary directory map`)

			return true
		} catch (error: unknown) {
			logger.error("ShellIntegrationManager", `Error cleaning up temporary directory ${tmpDir}: ${getErrorMessage(error)}`)
			TelemetryService.reportError(error instanceof Error ? error : new Error(getErrorMessage(error)), TelemetryEventName.UTILITY_ERROR)

			return false
		}
	}

	public static clear() {
		this.terminalTmpDirs.forEach((_, terminalId) => this.zshCleanupTmpDir(terminalId))
		this.terminalTmpDirs.clear()
	}

	/**
	 * Gets the path to the shell integration script for a given shell type
	 * @param shell The shell type
	 * @returns The path to the shell integration script
	 */
	private static getShellIntegrationPath(shell: "bash" | "pwsh" | "zsh" | "fish"): string {
		let filename: string

		switch (shell) {
			case "bash":
				filename = "shellIntegration-bash.sh"
				break
			case "pwsh":
				filename = "shellIntegration.ps1"
				break
			case "zsh":
				filename = "shellIntegration-rc.zsh"
				break
			case "fish":
				filename = "shellIntegration.fish"
				break
			default:
				throw new Error(`Invalid shell type: ${shell}`)
		}

		// This is the same path used by the CLI command
		return path.join(
			vscode.env.appRoot,
			"out",
			"vs",
			"workbench",
			"contrib",
			"terminal",
			"common",
			"scripts",
			filename,
		)
	}
}
