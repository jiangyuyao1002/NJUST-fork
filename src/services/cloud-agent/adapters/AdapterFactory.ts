import type { CloudAgentProfile } from "../types/profile"
import type { IProtocolAdapter } from "./types"
import { RestProtocolAdapter } from "./RestProtocolAdapter"
import { McpProtocolAdapter } from "./McpProtocolAdapter"
import { logger } from "../../../shared/logger"

export class AdapterFactory {
	static create(profile: CloudAgentProfile): IProtocolAdapter {
		let adapter: IProtocolAdapter

		switch (profile.protocolType) {
			case "mcp":
				adapter = new McpProtocolAdapter()
				break
			case "rest":
				adapter = new RestProtocolAdapter()
				break
			default:
				logger.warn("AdapterFactory", `Unknown protocol type "${profile.protocolType}", falling back to REST`)
				adapter = new RestProtocolAdapter()
				break
		}

		adapter.initialize(profile)
		return adapter
	}
}
