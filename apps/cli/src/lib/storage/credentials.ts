import * as crypto from "crypto"
import * as os from "os"
import fs from "fs/promises"
import path from "path"

import { getConfigDir } from "./index.js"

const CREDENTIALS_FILE = path.join(getConfigDir(), "cli-credentials.json")
const CREDENTIALS_ENC_FILE = path.join(getConfigDir(), "cli-credentials.enc")

// Encryption constants (aligned with FileSecretStorage)
const ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const SALT = "njust-ai-cli-credentials-v1"

export interface Credentials {
	token: string
	createdAt: string
	userId?: string
	orgId?: string
}

export async function saveToken(token: string, options?: { userId?: string; orgId?: string }): Promise<void> {
	await fs.mkdir(getConfigDir(), { recursive: true })

	const credentials: Credentials = {
		token,
		createdAt: new Date().toISOString(),
		userId: options?.userId,
		orgId: options?.orgId,
	}

	const plaintext = JSON.stringify(credentials, null, 2)
	const encrypted = encrypt(plaintext)

	await fs.writeFile(CREDENTIALS_ENC_FILE, encrypted, { mode: 0o600 })

	// Clean up legacy plaintext file if it exists
	await unlinkIfExists(CREDENTIALS_FILE)
}

export async function loadToken(): Promise<string | null> {
	const credentials = await loadCredentials()
	return credentials?.token ?? null
}

export async function loadCredentials(): Promise<Credentials | null> {
	// 1. Try encrypted file first
	try {
		const data = await fs.readFile(CREDENTIALS_ENC_FILE, "utf-8")
		const plaintext = decrypt(data)
		return JSON.parse(plaintext) as Credentials
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code !== "ENOENT") {
			// Encrypted file exists but decryption failed — do NOT fall back
			console.warn("Failed to decrypt CLI credentials, discarding corrupted file")
			return null
		}
	}

	// 2. Fall back to legacy plaintext file and auto-migrate
	try {
		const data = await fs.readFile(CREDENTIALS_FILE, "utf-8")
		const credentials = JSON.parse(data) as Credentials

		// Migrate: save encrypted and remove plaintext
		await migrateToEncrypted(credentials)
		console.log("Migrated CLI credentials from plaintext to encrypted storage")
		return credentials
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null
		}
		throw error
	}
}

export async function clearToken(): Promise<void> {
	await unlinkIfExists(CREDENTIALS_ENC_FILE)
	await unlinkIfExists(CREDENTIALS_FILE)
}

export async function hasToken(): Promise<boolean> {
	const token = await loadToken()
	return token !== null
}

export function getCredentialsPath(): string {
	return CREDENTIALS_ENC_FILE
}

/** Path of the legacy plaintext file (for migration tooling / diagnostics). */
export function getLegacyCredentialsPath(): string {
	return CREDENTIALS_FILE
}

// ── Encryption helpers ─────────────────────────────────────────────

async function migrateToEncrypted(credentials: Credentials): Promise<void> {
	await fs.mkdir(getConfigDir(), { recursive: true })

	const plaintext = JSON.stringify(credentials, null, 2)
	const encrypted = encrypt(plaintext)
	await fs.writeFile(CREDENTIALS_ENC_FILE, encrypted, { mode: 0o600 })

	await unlinkIfExists(CREDENTIALS_FILE)
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error
		}
	}
}

function getMachineId(): string {
	try {
		const hostname = os.hostname() || "unknown-host"
		const username = os.userInfo().username || "unknown-user"
		const platform = process.platform || "unknown-platform"
		return `${username}@${hostname}:${platform}`
	} catch {
		return `unknown@${os.hostname() || "unknown-host"}:${process.platform || "unknown"}`
	}
}

function deriveKey(): Buffer {
	return crypto.scryptSync(getMachineId(), SALT, KEY_LENGTH)
}

function encrypt(plaintext: string): string {
	const key = deriveKey()
	const iv = crypto.randomBytes(IV_LENGTH)
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	const authTag = cipher.getAuthTag()
	return Buffer.concat([iv, authTag, encrypted]).toString("base64")
}

function decrypt(ciphertext: string): string {
	const key = deriveKey()
	const data = Buffer.from(ciphertext, "base64")
	const iv = data.subarray(0, IV_LENGTH)
	const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
	const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
	const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
	decipher.setAuthTag(authTag)
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}
