import { NamedError } from "@njust-ai/core/shared"

export class OrganizationAllowListViolationError extends NamedError {
	constructor(message: string) {
		super(message)
	}
}
