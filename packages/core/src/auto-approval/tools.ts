import type { ClineSayTool } from "@njust-ai-cj/types"

export function isWriteToolAction(tool: ClineSayTool): boolean {
	return ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"].includes(tool.tool)
}

export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	return [
		"readFile",
		"listFiles",
		"listFilesTopLevel",
		"listFilesRecursive",
		"searchFiles",
		"codebaseSearch",
		"runSlashCommand",
		"readCommandOutput",
		"web_search",
		"web_fetch",
		"lsp",
	].includes(tool.tool)
}
