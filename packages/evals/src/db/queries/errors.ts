export class RecordNotFoundError extends Error {
	constructor(message?: string) {
		super(message)
		this.name = "RecordNotFoundError"
		Object.setPrototypeOf(this, RecordNotFoundError.prototype)
	}
}

export class RecordNotCreatedError extends Error {
	constructor(message?: string) {
		super(message)
		this.name = "RecordNotCreatedError"
		Object.setPrototypeOf(this, RecordNotCreatedError.prototype)
	}
}
