import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

import { NJUST_AI_CONFIG_DIR } from "@njust-ai/types"

import { getGlobalRooDirectory } from "../njust-ai-config"
import { invalidateCangjieContextSectionCache } from "../../core/prompts/sections/cangjie-context"

/**
 * Watch `.njust_ai/rules-cangjie/**` and legacy `.njust-ai/rules-cangjie/**` so edits apply without
 * reloading the window (system prompt re-reads rules on each request; we only invalidate the
 * separate Cangjie context cache here).
 */
export function registerCangjieRulesHotReload(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): void {
	const notify = () => {
		invalidateCangjieContextSectionCache()
		outputChannel.appendLine(
			`[Cangjie rules] ${NJUST_AI_CONFIG_DIR}/rules-cangjie/ (or .njust-ai/rules-cangjie/) changed — rules reload on the next model request; dynamic Cangjie context cache cleared.`,
		)
	}

	const disposables: vscode.Disposable[] = []

	const watchPattern = (wf: vscode.WorkspaceFolder, subpath: string) => {
		const pattern = new vscode.RelativePattern(wf, subpath)
		const w = vscode.workspace.createFileSystemWatcher(pattern)
		disposables.push(w)
		w.onDidChange(notify)
		w.onDidCreate(notify)
		w.onDidDelete(notify)
	}

	for (const wf of vscode.workspace.workspaceFolders ?? []) {
		watchPattern(wf, `${NJUST_AI_CONFIG_DIR}/rules-cangjie/**`)
		watchPattern(wf, `.njust-ai/rules-cangjie/**`)
	}

	const globalRulesDir = path.join(getGlobalRooDirectory(), "rules-cangjie")
	let globalWatcher: fs.FSWatcher | undefined
	try {
		if (fs.existsSync(globalRulesDir)) {
			globalWatcher = fs.watch(globalRulesDir, { recursive: true }, notify)
		}
	} catch {
		/* ignore */
	}

	context.subscriptions.push({
		dispose: () => {
			for (const d of disposables) d.dispose()
			globalWatcher?.close()
		},
	})
}
