import { describe, expect, it, vi, beforeEach } from "vitest"
import { ProfileStorageService, getProfileStorageService, setProfileStorageService } from "../ProfileStorageService"
import type { CloudAgentProfile } from "../types/profile"
import { BUILT_IN_PROFILES } from "../presets/templates"
import * as vscode from "vscode"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

function createMockMemento(initial: Record<string, unknown> = {}): vscode.Memento {
	const store = new Map<string, unknown>(Object.entries(initial))
	return {
		get: vi.fn(function (key: string, defaultValue?: unknown) {
			if (store.has(key)) return store.get(key)
			return defaultValue
		}),
		update: vi.fn(async function (key: string, value: unknown) {
			if (value === undefined) {
				store.delete(key)
			} else {
				store.set(key, value)
			}
		}),
	} as unknown as vscode.Memento
}

function createMockSecretStorage(initial: Record<string, string> = {}): vscode.SecretStorage {
	const store = new Map<string, string>(Object.entries(initial))
	return {
		get: vi.fn(async (key: string) => store.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		onDidChange: vi.fn(),
	} as unknown as vscode.SecretStorage
}

function createUserProfile(overrides?: Partial<CloudAgentProfile>): CloudAgentProfile {
	return {
		id: "user-test",
		name: "User Test",
		protocolType: "rest",
		serverUrl: "http://user.example.com",
		auth: { type: "api-key", apiKey: "user-key" },
		createdAt: 1000,
		updatedAt: 1000,
		isBuiltIn: false,
		...overrides,
	}
}

describe("ProfileStorageService", () => {
	let globalState: vscode.Memento
	let workspaceState: vscode.Memento
	let secrets: vscode.SecretStorage
	let service: ProfileStorageService

	beforeEach(() => {
		globalState = createMockMemento()
		workspaceState = createMockMemento()
		secrets = createMockSecretStorage()
		service = new ProfileStorageService(globalState, workspaceState, secrets)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		} as unknown as vscode.WorkspaceConfiguration)
	})

	describe("getProfiles()", () => {
		it("returns built-in profiles when no user profiles exist", () => {
			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length)
			expect(profiles[0].isBuiltIn).toBe(true)
		})

		it("returns built-in + user profiles combined", async () => {
			const user = createUserProfile()
			globalState = createMockMemento({ "cloudAgent.profiles": [] })
			service = new ProfileStorageService(globalState, workspaceState, secrets)
			await service.saveProfile(user) // triggers SecretStorage + cache
			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length + 1)
			expect(profiles.some((p) => p.id === "user-test")).toBe(true)
		})
	})

	describe("getActiveProfile()", () => {
		it("returns workspaceState profile when set", () => {
			const user = createUserProfile()
			globalState = createMockMemento({
				"cloudAgent.profiles": [user],
				"cloudAgent.activeProfileId": "user-test",
			})
			workspaceState = createMockMemento({
				"cloudAgent.activeProfileId": "njust-ai-standard",
			})
			service = new ProfileStorageService(globalState, workspaceState, secrets)
			const active = service.getActiveProfile()
			expect(active?.id).toBe("njust-ai-standard")
		})

		it("falls back to globalState when workspaceState is not set", () => {
			const user = createUserProfile()
			globalState = createMockMemento({
				"cloudAgent.profiles": [user],
				"cloudAgent.activeProfileId": "user-test",
			})
			service = new ProfileStorageService(globalState, workspaceState, secrets)
			const active = service.getActiveProfile()
			expect(active?.id).toBe("user-test")
		})

		it("falls back to first built-in when nothing is set", () => {
			const active = service.getActiveProfile()
			expect(active?.id).toBe(BUILT_IN_PROFILES[0].id)
		})
	})

	describe("saveProfile()", () => {
		it("adds a new user profile and strips auth from globalState", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)

			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length + 1)

			// Verify auth was stored in SecretStorage
			expect(secrets.store).toHaveBeenCalledWith(
				"cloudAgent.profile.auth.user-test",
				JSON.stringify({ type: "api-key", apiKey: "user-key" }),
			)

			// Verify globalState profile does NOT contain apiKey
			const updateCall = vi
				.mocked(globalState.update)
				.mock.calls.find((call) => call[0] === "cloudAgent.profiles")
			const savedProfiles = updateCall![1] as CloudAgentProfile[]
			const saved = savedProfiles.find((p) => p.id === "user-test")
			expect(saved?.auth?.apiKey).toBeUndefined()
		})

		it("updates an existing user profile", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			const updated = { ...user, name: "Updated Name" }
			await service.saveProfile(updated)
			const profiles = service.getProfiles()
			const found = profiles.find((p) => p.id === "user-test")
			expect(found?.name).toBe("Updated Name")
		})

		it("throws when trying to save a built-in profile", async () => {
			const builtIn = BUILT_IN_PROFILES[0]
			await expect(service.saveProfile(builtIn)).rejects.toThrow("Cannot modify built-in profiles")
		})

		it("rehydrates auth from cache on sync read", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)

			// getProfiles() should rehydrate auth from cache
			const profiles = service.getProfiles()
			const found = profiles.find((p) => p.id === "user-test")
			expect(found?.auth?.apiKey).toBe("user-key")
		})
	})

	describe("deleteProfile()", () => {
		it("removes a user profile and cleans up secrets", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			await service.deleteProfile("user-test")

			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length)
			expect(profiles.some((p) => p.id === "user-test")).toBe(false)
			expect(secrets.delete).toHaveBeenCalledWith("cloudAgent.profile.auth.user-test")
		})

		it("clears active profile when deleting the active one", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			await service.setActiveProfileId("user-test")
			await service.deleteProfile("user-test")
			expect(globalState.update).toHaveBeenCalledWith("cloudAgent.activeProfileId", undefined)
		})
	})

	describe("setActiveProfileId()", () => {
		it("sets global scope by default", async () => {
			await service.setActiveProfileId("test-id")
			expect(globalState.update).toHaveBeenCalledWith("cloudAgent.activeProfileId", "test-id")
		})

		it("sets workspace scope when requested", async () => {
			await service.setActiveProfileId("test-id", "workspace")
			expect(workspaceState.update).toHaveBeenCalledWith("cloudAgent.activeProfileId", "test-id")
		})
	})

	describe("initialize() with legacy migration", () => {
		it("migrates auth from globalState to SecretStorage", async () => {
			// Simulate profiles stored in globalState WITH auth (pre-migration)
			const legacyProfile: CloudAgentProfile = {
				id: "legacy-1",
				name: "Legacy",
				protocolType: "rest",
				serverUrl: "http://example.com",
				auth: { type: "bearer", bearerToken: "secret-token" },
				createdAt: 1000,
				updatedAt: 1000,
				isBuiltIn: false,
			}
			globalState = createMockMemento({ "cloudAgent.profiles": [legacyProfile] })
			service = new ProfileStorageService(globalState, workspaceState, secrets)

			await service.initialize()

			// Auth should now be in SecretStorage
			expect(secrets.store).toHaveBeenCalledWith(
				"cloudAgent.profile.auth.legacy-1",
				JSON.stringify({ type: "bearer", bearerToken: "secret-token" }),
			)

			// globalState profile should have auth stripped
			const updateCall = vi
				.mocked(globalState.update)
				.mock.calls.find((call) => call[0] === "cloudAgent.profiles")
			const savedProfiles = updateCall![1] as CloudAgentProfile[]
			expect(savedProfiles[0].auth?.bearerToken).toBeUndefined()

			// getProfiles() should rehydrate auth from cache
			const profiles = service.getProfiles()
			const found = profiles.find((p) => p.id === "legacy-1")
			expect(found?.auth?.bearerToken).toBe("secret-token")
		})

		it("skips migration when SecretStorage already has auth", async () => {
			const strippedProfile: CloudAgentProfile = {
				id: "already-migrated",
				name: "Migrated",
				protocolType: "rest",
				serverUrl: "http://example.com",
				auth: { type: "api-key" }, // No apiKey present
				createdAt: 1000,
				updatedAt: 1000,
				isBuiltIn: false,
			}
			globalState = createMockMemento({ "cloudAgent.profiles": [strippedProfile] })
			secrets = createMockSecretStorage({
				"cloudAgent.profile.auth.already-migrated": JSON.stringify({
					type: "api-key",
					apiKey: "cached-key",
				}),
			})
			service = new ProfileStorageService(globalState, workspaceState, secrets)

			await service.initialize()

			// Should NOT re-store to secrets (already present)
			const storeCall = vi
				.mocked(secrets.store)
				.mock.calls.find((call) => call[0] === "cloudAgent.profile.auth.already-migrated")
			expect(storeCall).toBeUndefined()

			// Cache should have the stored auth
			const profiles = service.getProfiles()
			const found = profiles.find((p) => p.id === "already-migrated")
			expect(found?.auth?.apiKey).toBe("cached-key")
		})
	})

	describe("migrateFromLegacyConfig()", () => {
		it("returns null when no legacy config exists", async () => {
			const result = await service.migrateFromLegacyConfig()
			expect(result).toBeNull()
		})

		it("creates migrated profile from legacy config", async () => {
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn(function (key: string) {
					if (key === "cloudAgent.serverUrl") return "http://legacy.example.com"
					if (key === "cloudAgent.apiKey") return "legacy-key"
					return undefined
				}),
			} as unknown as vscode.WorkspaceConfiguration)

			const result = await service.migrateFromLegacyConfig()
			expect(result).not.toBeNull()
			expect(result?.id).toBe("migrated-default")
			expect(result?.serverUrl).toBe("http://legacy.example.com")
			expect(result?.auth.type).toBe("api-key")
			expect(result?.auth.apiKey).toBe("legacy-key")
		})

		it("is idempotent — skips if already migrated", async () => {
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn(function (key: string) {
					if (key === "cloudAgent.serverUrl") return "http://legacy.example.com"
					return undefined
				}),
			} as unknown as vscode.WorkspaceConfiguration)

			await service.migrateFromLegacyConfig()
			const result = await service.migrateFromLegacyConfig()
			expect(result).toBeNull()
		})
	})

	describe("backward compatibility (no SecretStorage)", () => {
		it("falls back to storing auth in globalState when secrets not provided", async () => {
			const compatService = new ProfileStorageService(globalState, workspaceState)
			const user = createUserProfile()
			await compatService.saveProfile(user)

			const updateCall = vi
				.mocked(globalState.update)
				.mock.calls.find((call) => call[0] === "cloudAgent.profiles")
			const savedProfiles = updateCall![1] as CloudAgentProfile[]
			const saved = savedProfiles.find((p) => p.id === "user-test")
			// Auth should be preserved in globalState (no stripping)
			expect(saved?.auth?.apiKey).toBe("user-key")
		})
	})
})

describe("getProfileStorageService() singleton", () => {
	it("throws when not initialized", () => {
		setProfileStorageService(undefined as unknown as ProfileStorageService)
		expect(() => getProfileStorageService()).toThrow(/errors\.cloud_agent\.not_initialized/)
	})
})
