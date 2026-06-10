import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { EventEmitter } from "../classes/EventEmitter.js"
import { ensureDirectoryExists } from "../utils/paths.js"
import type { SecretStorage, SecretStorageChangeEvent } from "../types.js"

const ENCRYPTION_ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/** File name for the random master key (kept beside secrets.json). */
const KEY_FILE_NAME = "secrets.key"

/**
 * File-based implementation of VSCode's SecretStorage interface
 *
 * Stores secrets in an encrypted file on disk using AES-256-GCM encryption.
 * The encryption key is a randomly-generated master key persisted in a
 * sidecar file (`secrets.key`) with restrictive permissions.
 *
 * On first launch after upgrading from the legacy machine-ID-derived key,
 * existing secrets are transparently re-encrypted with the new random key.
 *
 * **Security Notes:**
 * - Secrets are encrypted at rest using AES-256-GCM
 * - Master key is cryptographically random (32 bytes)
 * - File permissions are set restrictive (0600) on Unix-like systems
 * - On Windows, inheritance is disabled and only the current user retains access
 * - For production environments, consider using VS Code's native SecretStorage
 *   which integrates with the OS keychain
 *
 * @example
 * ```typescript
 * const storage = new FileSecretStorage('/path/to/storage')
 *
 * // Store a secret
 * await storage.store('apiKey', 'sk-...')
 *
 * // Retrieve a secret
 * const key = await storage.get('apiKey')
 *
 * // Listen for changes
 * storage.onDidChange((e) => {
 *   console.log(`Secret ${e.key} changed`)
 * })
 * ```
 */
export class FileSecretStorage implements SecretStorage {
	private secrets: Record<string, string> = {}
	private _onDidChange = new EventEmitter<SecretStorageChangeEvent>()
	private filePath: string
	private encryptionKey: Buffer | null = null

	/**
	 * Create a new FileSecretStorage
	 *
	 * @param storagePath - Directory path where secrets.json will be stored
	 */
	constructor(storagePath: string) {
		this.filePath = path.join(storagePath, "secrets.json")
		this.loadFromFile()
	}

	/**
	 * Load secrets from the encrypted JSON file.
	 * Handles transparent migration from the legacy machine-ID-derived key.
	 */
	private loadFromFile(): void {
		try {
			if (fs.existsSync(this.filePath)) {
				const encryptedContent = fs.readFileSync(this.filePath, "utf-8")
				const keyFile = this.getKeyFilePath()

				if (!fs.existsSync(keyFile)) {
					// Migration path: no key file yet — try legacy key first
					try {
						const legacyKey = this.deriveLegacyKey()
						const decrypted = this.decryptWithKey(encryptedContent, legacyKey)
						this.secrets = JSON.parse(decrypted)
						console.log(`Migrating secrets from legacy key to random key at ${keyFile}`)
						// Set a new random key and re-encrypt
						this.persistNewRandomKey()
						this.saveToFile()
						return
					} catch {
						console.warn(`Legacy key migration failed for ${this.filePath}, starting fresh`)
						this.secrets = {}
						this.persistNewRandomKey()
						return
					}
				}

				try {
					const decryptedContent = this.decrypt(encryptedContent)
					this.secrets = JSON.parse(decryptedContent)
				} catch {
					console.warn(`Failed to decrypt secrets from ${this.filePath}, starting fresh`)
					this.secrets = {}
				}
			}
		} catch (error) {
			console.warn(`Failed to load secrets from ${this.filePath}:`, error)
			this.secrets = {}
		}
	}

	/**
	 * Save secrets to the encrypted JSON file with restrictive permissions
	 */
	private saveToFile(): void {
		try {
			// Ensure directory exists
			const dir = path.dirname(this.filePath)
			ensureDirectoryExists(dir)

			// Encrypt the secrets before writing
			const plaintext = JSON.stringify(this.secrets, null, 2)
			const encryptedContent = this.encrypt(plaintext)
			fs.writeFileSync(this.filePath, encryptedContent)

			// Set restrictive permissions (owner read/write only) on Unix-like systems
			if (process.platform !== "win32") {
				try {
					fs.chmodSync(this.filePath, 0o600)
				} catch {
					// Ignore chmod errors (might not be supported on some filesystems)
				}
			}
		} catch (error) {
			console.warn(`Failed to save secrets to ${this.filePath}:`, error)
		}
	}

	/**
	 * Retrieve a secret by key
	 *
	 * @param key - The secret key
	 * @returns The secret value or undefined if not found
	 */
	async get(key: string): Promise<string | undefined> {
		return this.secrets[key]
	}

	/**
	 * Store a secret
	 *
	 * @param key - The secret key
	 * @param value - The secret value
	 */
	async store(key: string, value: string): Promise<void> {
		this.secrets[key] = value
		this.saveToFile()
		this._onDidChange.fire({ key })
	}

	/**
	 * Delete a secret
	 *
	 * @param key - The secret key to delete
	 */
	async delete(key: string): Promise<void> {
		delete this.secrets[key]
		this.saveToFile()
		this._onDidChange.fire({ key })
	}

	/**
	 * Event fired when a secret changes
	 */
	get onDidChange() {
		return this._onDidChange.event
	}

	/**
	 * Clear all secrets (useful for testing)
	 */
	clearAll(): void {
		this.secrets = {}
		this.saveToFile()
	}

	/**
	 * Derive the legacy machine-ID-based encryption key (for migration only).
	 * Uses hostname and username to create a unique identifier per machine/user,
	 * then derives a key via scrypt.
	 */
	private deriveLegacyKey(): Buffer {
		let machineId: string
		try {
			const hostname = os.hostname() || "unknown-host"
			const username = os.userInfo().username || "unknown-user"
			const platform = process.platform || "unknown-platform"
			machineId = `${username}@${hostname}:${platform}`
		} catch {
			machineId = `unknown@${os.hostname() || "unknown-host"}:${process.platform || "unknown"}`
		}
		return crypto.scryptSync(machineId, "njust-ai-secret-storage-v1", KEY_LENGTH)
	}

	/**
	 * Return the path to the random master key file (kept beside secrets.json).
	 */
	private getKeyFilePath(): string {
		return path.join(path.dirname(this.filePath), KEY_FILE_NAME)
	}

	/**
	 * Generate a new random key, persist it to disk with restrictive
	 * permissions, and cache it as the active encryption key.
	 */
	private persistNewRandomKey(): void {
		const keyFile = this.getKeyFilePath()
		this.encryptionKey = crypto.randomBytes(KEY_LENGTH)
		try {
			// Atomic write: write to temp file, then rename
			const tmpFile = keyFile + ".tmp"
			fs.writeFileSync(tmpFile, this.encryptionKey)
			if (process.platform !== "win32") {
				fs.chmodSync(tmpFile, 0o600)
			}
			fs.renameSync(tmpFile, keyFile)
			// Windows: disable inheritance and grant access only to current user
			if (process.platform === "win32") {
				try {
					execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(R,W)`], {
						timeout: 5000,
						windowsHide: true,
					})
				} catch {
					console.warn(`Failed to set ACL on key file ${keyFile}; using default permissions`)
				}
			}
		} catch (err) {
			console.warn(`Failed to persist encryption key to ${keyFile}:`, err)
		}
	}

	/**
	 * Derive or load the encryption key.
	 *
	 * Prefer a randomly-generated master key persisted in a sidecar file
	 * (`secrets.key`) with 0600 permissions.  This avoids the weakness of
	 * deriving the key solely from predictable machine identifiers
	 * (hostname + username) which any local user can guess.
	 *
	 * Legacy key migration is handled in loadFromFile(); by the time this
	 * method is called during normal operation, the random key already exists.
	 */
	private getEncryptionKey(): Buffer {
		if (!this.encryptionKey) {
			const keyFile = this.getKeyFilePath()
			if (fs.existsSync(keyFile)) {
				// Use persisted random key
				this.encryptionKey = fs.readFileSync(keyFile)
				if (this.encryptionKey.length !== KEY_LENGTH) {
					throw new Error(`Invalid key file length: expected ${KEY_LENGTH}, got ${this.encryptionKey.length}`)
				}
			} else {
				// Fresh install — no secrets.json and no key file
				this.persistNewRandomKey()
			}
		}
		return this.encryptionKey!
	}

	/**
	 * Encrypt plaintext using AES-256-GCM.
	 * Returns a base64-encoded string containing IV, auth tag, and ciphertext.
	 */
	private encrypt(plaintext: string): string {
		const key = this.getEncryptionKey()
		return this.encryptWithKey(plaintext, key)
	}

	/**
	 * Decrypt ciphertext that was encrypted with encrypt().
	 * Returns the original plaintext string.
	 * Throws if decryption fails (e.g., tampered data, wrong key).
	 */
	private decrypt(ciphertext: string): string {
		const key = this.getEncryptionKey()
		return this.decryptWithKey(ciphertext, key)
	}

	/** Encrypt with an explicit key buffer. */
	private encryptWithKey(plaintext: string, key: Buffer): string {
		const iv = crypto.randomBytes(IV_LENGTH)
		const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
		const authTag = cipher.getAuthTag()
		return Buffer.concat([iv, authTag, encrypted]).toString("base64")
	}

	/** Decrypt with an explicit key buffer. */
	private decryptWithKey(ciphertext: string, key: Buffer): string {
		try {
			const data = Buffer.from(ciphertext, "base64")
			const iv = data.subarray(0, IV_LENGTH)
			const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
			const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
			const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
			decipher.setAuthTag(authTag)
			return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
		} catch {
			throw new Error("Failed to decrypt secrets - data may be corrupted or tampered")
		}
	}
}
