/**
 * Error thrown when an ask promise is superseded by a newer one.
 *
 * This is used as an internal control flow signal - not an actual error.
 * It occurs when multiple asks are sent in rapid succession and an older
 * ask is invalidated by a newer one (e.g., during streaming updates).
 */
import { NamedError } from "@njust-ai/core/shared"

export class AskIgnoredError extends NamedError {
	constructor(reason?: string) {
		super(reason ? `Ask ignored: ${reason}` : "Ask ignored")
	}
}
