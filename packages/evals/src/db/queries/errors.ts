import { NamedError } from "@njust-ai/types"

export class RecordNotFoundError extends NamedError {
	constructor(message?: string) {
		super(message)
	}
}

export class RecordNotCreatedError extends NamedError {
	constructor(message?: string) {
		super(message)
	}
}
