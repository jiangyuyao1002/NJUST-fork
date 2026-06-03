import fs from "fs/promises"
import path from "path"

// Use vi.hoisted to make the test directory available to the mock
// This must return the path synchronously since CREDENTIALS_FILE is computed at import time
const { getTestConfigDir } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require("os")
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const path = require("path")
	const testRunId = Date.now().toString()
	const testConfigDir = path.join(os.tmpdir(), `njust-ai-cli-test-${testRunId}`)
	return { getTestConfigDir: () => testConfigDir }
})

vi.mock("../config-dir.js", () => ({
	getConfigDir: getTestConfigDir,
}))

// Import after mocking
import {
	saveToken,
	loadToken,
	loadCredentials,
	clearToken,
	hasToken,
	getCredentialsPath,
	getLegacyCredentialsPath,
} from "../credentials.js"

// Re-derive the test config dir for use in tests (must match the hoisted one)
const actualTestConfigDir = getTestConfigDir()

describe("Token Storage (encrypted)", () => {
	const expectedEncFile = path.join(actualTestConfigDir, "cli-credentials.enc")
	const legacyFile = path.join(actualTestConfigDir, "cli-credentials.json")

	beforeEach(async () => {
		// Clear test directory before each test
		await fs.rm(actualTestConfigDir, { recursive: true, force: true })
	})

	afterAll(async () => {
		// Clean up test directory
		await fs.rm(actualTestConfigDir, { recursive: true, force: true })
	})

	describe("getCredentialsPath", () => {
		it("should return the encrypted credentials file path", () => {
			expect(getCredentialsPath()).toBe(expectedEncFile)
		})

		it("should return legacy path via getLegacyCredentialsPath", () => {
			expect(getLegacyCredentialsPath()).toBe(legacyFile)
		})
	})

	describe("saveToken", () => {
		it("should save encrypted token to disk", async () => {
			await saveToken("test-token-123")

			const encData = await fs.readFile(expectedEncFile, "utf-8")
			// Encrypted file should NOT be valid JSON
			expect(() => JSON.parse(encData)).toThrow()
			// It should be base64-encoded
			expect(() => Buffer.from(encData, "base64")).not.toThrow()
		})

		it("should create config directory if it doesn't exist", async () => {
			await saveToken("test-token-789")

			const dirStats = await fs.stat(actualTestConfigDir)
			expect(dirStats.isDirectory()).toBe(true)
		})

		// Unix file permissions don't apply on Windows - skip this test
		it.skipIf(process.platform === "win32")("should set restrictive file permissions", async () => {
			await saveToken("test-token-perms")

			const stats = await fs.stat(expectedEncFile)
			const mode = stats.mode & 0o777
			expect(mode).toBe(0o600)
		})

		it("should remove legacy plaintext file on save", async () => {
			// Create a legacy plaintext file
			await fs.mkdir(actualTestConfigDir, { recursive: true })
			await fs.writeFile(legacyFile, JSON.stringify({ token: "old", createdAt: "2024-01-01" }))

			await saveToken("new-token")

			// Legacy file should be gone
			await expect(fs.access(legacyFile)).rejects.toThrow()
		})
	})

	describe("loadToken", () => {
		it("should load saved token", async () => {
			const token = "test-token-abc"
			await saveToken(token)

			const loaded = await loadToken()
			expect(loaded).toBe(token)
		})

		it("should return null if no token exists", async () => {
			const loaded = await loadToken()
			expect(loaded).toBeNull()
		})
	})

	describe("loadCredentials", () => {
		it("should load full credentials", async () => {
			const token = "test-token-def"
			await saveToken(token, { userId: "user_789" })

			const credentials = await loadCredentials()

			expect(credentials).not.toBeNull()
			expect(credentials?.token).toBe(token)
			expect(credentials?.userId).toBe("user_789")
			expect(credentials?.createdAt).toBeDefined()
		})

		it("should return null if no credentials exist", async () => {
			const credentials = await loadCredentials()
			expect(credentials).toBeNull()
		})
	})

	describe("clearToken", () => {
		it("should remove saved token", async () => {
			await saveToken("test-token-ghi")
			await clearToken()

			const loaded = await loadToken()
			expect(loaded).toBeNull()
		})

		it("should not throw if no token exists", async () => {
			await expect(clearToken()).resolves.not.toThrow()
		})

		it("should remove both encrypted and legacy files", async () => {
			await saveToken("test-token")
			// Also create a legacy file
			await fs.writeFile(legacyFile, "legacy")

			await clearToken()

			await expect(fs.access(expectedEncFile)).rejects.toThrow()
			await expect(fs.access(legacyFile)).rejects.toThrow()
		})
	})

	describe("hasToken", () => {
		it("should return true if token exists", async () => {
			await saveToken("test-token-jkl")

			const exists = await hasToken()
			expect(exists).toBe(true)
		})

		it("should return false if no token exists", async () => {
			const exists = await hasToken()
			expect(exists).toBe(false)
		})
	})

	describe("plaintext migration", () => {
		it("should auto-migrate legacy plaintext file to encrypted", async () => {
			// Simulate legacy plaintext credentials
			await fs.mkdir(actualTestConfigDir, { recursive: true })
			const legacyCreds = { token: "legacy-token-xyz", createdAt: "2024-06-01T00:00:00.000Z", userId: "old-user" }
			await fs.writeFile(legacyFile, JSON.stringify(legacyCreds, null, 2))

			// Load should trigger migration
			const loaded = await loadCredentials()

			expect(loaded).not.toBeNull()
			expect(loaded?.token).toBe("legacy-token-xyz")
			expect(loaded?.userId).toBe("old-user")

			// Legacy file should be removed
			await expect(fs.access(legacyFile)).rejects.toThrow()

			// Encrypted file should exist
			await expect(fs.access(expectedEncFile)).resolves.toBeUndefined()

			// Subsequent loads should work from encrypted file
			const reloaded = await loadToken()
			expect(reloaded).toBe("legacy-token-xyz")
		})

		it("should prefer encrypted file over legacy plaintext", async () => {
			// Save via API (creates encrypted file)
			await saveToken("encrypted-token")

			// Create a legacy file with different data
			await fs.writeFile(legacyFile, JSON.stringify({ token: "stale-token", createdAt: "2024-01-01" }))

			const loaded = await loadToken()
			expect(loaded).toBe("encrypted-token")
		})
	})
})
