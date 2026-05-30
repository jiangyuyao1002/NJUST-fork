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
		get: vi.fn((key: string, defaultValue?: unknown) => {
			if (store.has(key)) return store.get(key)
			return defaultValue
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (value === undefined) {
				store.delete(key)
			} else {
				store.set(key, value)
			}
		}),
	} as unknown as vscode.Memento
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
	let service: ProfileStorageService

	beforeEach(() => {
		globalState = createMockMemento()
		workspaceState = createMockMemento()
		service = new ProfileStorageService(globalState, workspaceState)
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

		it("returns built-in + user profiles combined", () => {
			const user = createUserProfile()
			globalState = createMockMemento({ "cloudAgent.profiles": [user] })
			service = new ProfileStorageService(globalState, workspaceState)
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
			service = new ProfileStorageService(globalState, workspaceState)
			const active = service.getActiveProfile()
			expect(active?.id).toBe("njust-ai-standard")
		})

		it("falls back to globalState when workspaceState is not set", () => {
			const user = createUserProfile()
			globalState = createMockMemento({
				"cloudAgent.profiles": [user],
				"cloudAgent.activeProfileId": "user-test",
			})
			service = new ProfileStorageService(globalState, workspaceState)
			const active = service.getActiveProfile()
			expect(active?.id).toBe("user-test")
		})

		it("falls back to first built-in when nothing is set", () => {
			const active = service.getActiveProfile()
			expect(active?.id).toBe(BUILT_IN_PROFILES[0].id)
		})
	})

	describe("saveProfile()", () => {
		it("adds a new user profile", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length + 1)
			expect(globalState.update).toHaveBeenCalledWith(
				"cloudAgent.profiles",
				expect.arrayContaining([expect.objectContaining({ id: "user-test" })]),
			)
		})

		it("updates an existing user profile", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			const updated = { ...user, name: "Updated Name" }
			await service.saveProfile(updated)
			const profiles = service.getProfiles()
			const found = profiles.find((p) => p.id === "user-test")
			expect(found?.name).toBe("Updated Name")
			expect(found?.updatedAt).toBeGreaterThan(user.updatedAt)
		})

		it("throws when trying to save a built-in profile", async () => {
			const builtIn = BUILT_IN_PROFILES[0]
			await expect(service.saveProfile(builtIn)).rejects.toThrow("Cannot modify built-in profiles")
		})
	})

	describe("deleteProfile()", () => {
		it("removes a user profile", async () => {
			const user = createUserProfile()
			await service.saveProfile(user)
			await service.deleteProfile("user-test")
			const profiles = service.getProfiles()
			expect(profiles).toHaveLength(BUILT_IN_PROFILES.length)
			expect(profiles.some((p) => p.id === "user-test")).toBe(false)
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

	describe("migrateFromLegacyConfig()", () => {
		it("returns null when no legacy config exists", async () => {
			const result = await service.migrateFromLegacyConfig()
			expect(result).toBeNull()
		})

		it("creates migrated profile from legacy config", async () => {
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn((key: string) => {
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
			// First migration
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn((key: string) => {
					if (key === "cloudAgent.serverUrl") return "http://legacy.example.com"
					return undefined
				}),
			} as unknown as vscode.WorkspaceConfiguration)

			await service.migrateFromLegacyConfig()

			// Second migration should return null
			const result = await service.migrateFromLegacyConfig()
			expect(result).toBeNull()
		})
	})
})

describe("getProfileStorageService() singleton", () => {
	it("throws when not initialized", () => {
		// Reset singleton
		setProfileStorageService(undefined as unknown as ProfileStorageService)
		expect(() => getProfileStorageService()).toThrow(/尚未初始化/)
	})
})
