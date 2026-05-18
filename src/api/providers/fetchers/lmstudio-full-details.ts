import axios from "axios"
import { LMStudioClient } from "@lmstudio/sdk"

import { logger } from "../../../shared/logger"
import { flushModels } from "./modelCache"
import { hasLoadedFullDetails, markFullDetailsLoaded } from "./lmstudio"

export { hasLoadedFullDetails }

export const forceFullModelDetailsLoad = async (baseUrl: string, modelId: string): Promise<void> => {
	try {
		await axios.get(`${baseUrl}/v1/models`)
		const lmsUrl = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")

		const client = new LMStudioClient({ baseUrl: lmsUrl })
		await client.llm.model(modelId)
		await flushModels({ provider: "lmstudio", baseUrl }, true)

		markFullDetailsLoaded(modelId)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
			logger.warn("LMStudio", `Error connecting to LMStudio at ${baseUrl}`)
		} else {
			logger.error(
				"LMStudio",
				`Error refreshing LMStudio model details: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}
}
