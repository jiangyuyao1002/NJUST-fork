import type { CloudAgentProfile } from "../types/profile"
import type { IProtocolAdapter } from "./types"
import { RestProtocolAdapter } from "./RestProtocolAdapter"

export class AdapterFactory {
	static create(profile: CloudAgentProfile): IProtocolAdapter {
		let adapter: IProtocolAdapter

		switch (profile.protocolType) {
			case "rest":
			default:
				adapter = new RestProtocolAdapter()
				break
		}

		adapter.initialize(profile)
		return adapter
	}
}
