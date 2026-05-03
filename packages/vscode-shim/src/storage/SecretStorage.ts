import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { EventEmitter } from "../classes/EventEmitter.js"
import { ensureDirectoryExists } from "../utils/paths.js"
import type { SecretStorage, SecretStorageChangeEvent } from "../types.js"

const ENCRYPTION_ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const SALT = "njust-ai-cj-secret-storage-v1"

/**
 * File-based implementation of VSCode's SecretStorage interface
 *
 * Stores secrets in an encrypted file on disk using AES-256-GCM encryption.
 * The encryption key is derived from the machine ID (hostname + username) using scrypt.
 *
 * **Security Notes:**
 * - Secrets are encrypted at rest using AES-256-GCM
 * - Encryption key is derived from machine-specific identifiers
 * - File permissions are set restrictive (0600) on Unix-like systems
 * - On Windows, file ACLs depend on system defaults
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
	 * Load secrets from the encrypted JSON file
	 */
	private loadFromFile(): void {
		try {
			if (fs.existsSync(this.filePath)) {
				const encryptedContent = fs.readFileSync(this.filePath, "utf-8")
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
	 * Generate a machine-specific identifier for encryption key derivation.
	 * Uses hostname and username to create a unique identifier per machine/user.
	 */
	private getMachineId(): string {
		try {
			const hostname = os.hostname() || "unknown-host"
			const username = os.userInfo().username || "unknown-user"
			const platform = process.platform || "unknown-platform"
			return `${username}@${hostname}:${platform}`
		} catch {
			// os.userInfo() can throw on Windows when running as a service
			// account or in containerized environments without a real user.
			return `unknown@${os.hostname() || "unknown-host"}:${process.platform || "unknown"}`
		}
	}

	/**
	 * Derive an encryption key from the machine ID using scrypt.
	 * The key is cached to avoid repeated derivation.
	 */
	private getEncryptionKey(): Buffer {
		if (!this.encryptionKey) {
			const machineId = this.getMachineId()
			this.encryptionKey = crypto.scryptSync(machineId, SALT, KEY_LENGTH)
		}
		return this.encryptionKey
	}

	/**
	 * Encrypt plaintext using AES-256-GCM.
	 * Returns a base64-encoded string containing IV, auth tag, and ciphertext.
	 */
	private encrypt(plaintext: string): string {
		const key = this.getEncryptionKey()
		const iv = crypto.randomBytes(IV_LENGTH)
		const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
		const authTag = cipher.getAuthTag()
		return Buffer.concat([iv, authTag, encrypted]).toString("base64")
	}

	/**
	 * Decrypt ciphertext that was encrypted with encrypt().
	 * Returns the original plaintext string.
	 * Throws if decryption fails (e.g., tampered data, wrong key).
	 */
	private decrypt(ciphertext: string): string {
		try {
			const key = this.getEncryptionKey()
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
