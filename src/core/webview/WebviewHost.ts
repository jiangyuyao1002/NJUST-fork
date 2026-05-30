/**
 * WebviewHost — Pure webview lifecycle management.
 *
 * Phase 1: Interface definition for the webview lifecycle contract.
 * Phase 2: Extract resolveWebviewView / configureWebviewContent / HTML
 * generation into this concrete class from ClineProvider.
 */

import * as vscode from "vscode"
import type { ExtensionMessage } from "@njust-ai/types"

/**
 * Contract for hosting a webview panel / sidebar view.
 * ClineProvider currently owns this lifecycle inline.
 */
export interface IWebviewHost {
	readonly view: vscode.WebviewView | vscode.WebviewPanel | undefined

	resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel): Promise<void>

	postMessageToWebview(message: ExtensionMessage): Promise<void>

	convertToWebviewUri(filePath: string): string
}
