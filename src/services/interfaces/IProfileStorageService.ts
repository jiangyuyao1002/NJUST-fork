import type { CloudAgentProfile } from "../cloud-agent/types/profile"

/**
 * Public surface of ProfileStorageService.
 */
export interface IProfileStorageService {
	getProfiles(): CloudAgentProfile[]
	getActiveProfile(): CloudAgentProfile | undefined
	saveProfile(profile: CloudAgentProfile): Promise<void>
	deleteProfile(id: string): Promise<void>
	setActiveProfileId(id: string, scope?: "global" | "workspace"): Promise<void>
}
