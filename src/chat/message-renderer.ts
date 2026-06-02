import type { ClineMessage } from "@njust-ai/types"

/**
 * Minimal interface required to render ClineMessages.
 * Compatible with vscode.ChatResponseStream.
 */
export interface RenderSink {
	markdown(value: string): void
	progress(value: string): void
}

/**
 * Render a ClineMessage to the given sink.
 *
 * Handles both "say" (informational) and "ask" (approval / follow-up)
 * message types.  Unrecognised categories are silently skipped so that
 * future message types do not cause runtime errors.
 */
export function renderClineMessage(sink: RenderSink, msg: ClineMessage): void {
	if (msg.type === "say") {
		renderSay(sink, msg)
	} else if (msg.type === "ask") {
		renderAsk(sink, msg)
	}
}

function renderSay(sink: RenderSink, msg: ClineMessage): void {
	switch (msg.say) {
		case "text":
			if (msg.text) {
				sink.markdown(msg.text)
			}
			break
		case "tool":
			if (msg.text) {
				try {
					const toolData = JSON.parse(msg.text)
					sink.progress(`Using tool: ${toolData.tool || "unknown"}`)
				} catch {
					sink.progress("Executing tool...")
				}
			}
			break
		case "completion_result":
			if (msg.text) {
				sink.markdown(`\n\n---\n**Result:** ${msg.text}`)
			}
			break
		case "error":
			if (msg.text) {
				sink.markdown(`\n**Error:** ${msg.text}`)
			}
			break
		case "shell_integration_warning":
			// Intentionally skipped — not useful in the chat panel.
			break
		default:
			break
	}
}

function renderAsk(sink: RenderSink, msg: ClineMessage): void {
	switch (msg.ask) {
		case "tool":
			if (msg.text) {
				try {
					const toolData = JSON.parse(msg.text)
					sink.markdown(
						`\n> **Tool approval needed:** ${toolData.tool || "unknown"}\n> Use the Njust-AI sidebar to approve or reject.\n`,
					)
				} catch {
					sink.markdown("\n> **Tool approval needed.** Use the Njust-AI sidebar to approve or reject.\n")
				}
			}
			break
		case "followup":
			if (msg.text) {
				sink.markdown(`\n**Question:** ${msg.text}\n`)
			}
			break
		default:
			break
	}
}
