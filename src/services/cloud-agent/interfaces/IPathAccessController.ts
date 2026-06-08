/**
 * Lightweight interfaces for path access control.
 * Decouples services/cloud-agent from core/ignore and core/protect.
 * Uses structural typing so existing RooIgnoreController and
 * RooProtectedController automatically satisfy these interfaces.
 */

export interface IPathValidator {
	validateAccess(filePath: string): boolean
	validateCommand?(command: string): string | undefined
}

export interface IWriteProtector {
	isWriteProtected(filePath: string): Promise<boolean>
}
