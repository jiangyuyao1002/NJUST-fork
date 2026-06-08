import type { CloudAgentProfile } from "../types/profile"
import type { IProtocolAdapter } from "./types"

/**
 * Factory interface for creating protocol adapters.
 * Abstracts the static AdapterFactory to enable dependency injection and testing.
 */
export interface IProtocolAdapterFactory {
	create(profile: CloudAgentProfile): IProtocolAdapter
}
