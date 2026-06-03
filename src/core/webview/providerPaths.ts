/**
 * Platform-specific directory utilities for MCP servers and settings.
 * Extracted from ClineProvider for reuse across the codebase.
 */
import * as os from "os"
import * as path from "path"
import fs from "fs/promises"

/**
 * Get or create the MCP servers directory for the current platform.
 * - Windows: %APPDATA%\NJUST_AI\MCP
 * - macOS: ~/Documents/Cline/MCP
 * - Linux: ~/.local/share/NJUST_AI/MCP
 */
export async function ensureMcpServersDirectoryExists(): Promise<string> {
	let mcpServersDir: string
	if (process.platform === "win32") {
		mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "NJUST_AI", "MCP")
	} else if (process.platform === "darwin") {
		mcpServersDir = path.join(os.homedir(), "Documents", "Cline", "MCP")
	} else {
		mcpServersDir = path.join(os.homedir(), ".local", "share", "NJUST_AI", "MCP")
	}

	try {
		await fs.mkdir(mcpServersDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), ".Njust-AI", "mcp")
	}
	return mcpServersDir
}

/**
 * Get or create the settings directory.
 */
export async function ensureSettingsDirectoryExists(globalStorageUri: { fsPath: string }): Promise<string> {
	const { getSettingsDirectoryPath } = await import("../../utils/storage")
	return getSettingsDirectoryPath(globalStorageUri.fsPath)
}
