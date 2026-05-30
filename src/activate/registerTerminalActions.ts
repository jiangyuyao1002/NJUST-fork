import * as vscode from "vscode"

import { TerminalActionId, TerminalActionPromptType } from "@njust-ai/types"

import { getTerminalCommand } from "../utils/commands"
import { handleTerminalAction } from "./providerActionDispatcher"
import { Terminal } from "../integrations/terminal/Terminal"
import { t } from "../i18n"

export const registerTerminalActions = (context: vscode.ExtensionContext) => {
	registerTerminalAction(context, "terminalAddToContext", "TERMINAL_ADD_TO_CONTEXT")
	registerTerminalAction(context, "terminalFixCommand", "TERMINAL_FIX")
	registerTerminalAction(context, "terminalExplainCommand", "TERMINAL_EXPLAIN")
}

const registerTerminalAction = (
	context: vscode.ExtensionContext,
	command: TerminalActionId,
	promptType: TerminalActionPromptType,
) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getTerminalCommand(command), async (args: UnsafeAny) => {
			let content = args?.selection

			if (!content || content === "") {
				content = await Terminal.getTerminalContents(promptType === "TERMINAL_ADD_TO_CONTEXT" ? -1 : 1)
			}

			if (!content) {
				vscode.window.showWarningMessage(t("common:warnings.no_terminal_content"))
				return
			}

			await handleTerminalAction(command, promptType, {
				terminalContent: content,
			})
		}),
	)
}
