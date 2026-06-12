/**
 * NamedError base class.
 *
 * Provides:
 * - automatic `this.name` assignment from the class name
 * - correct prototype chain for `instanceof` checks in transpiled code
 *
 * Use this as the base for all custom errors instead of extending `Error` directly.
 */
export class NamedError extends Error {
	constructor(message?: string) {
		super(message)
		this.name = this.constructor.name
		Object.setPrototypeOf(this, new.target.prototype)
	}
}
