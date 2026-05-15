import { startMockServer } from "./server.js"
import { fileURLToPath } from "url"

export { createMockServer, startMockServer, type MockServerConfig, type MockServerHandle } from "./server.js"
export type { MockProvider, MockScenario, MockScenarioResponse, MockToolCall } from "./scenarios/index.js"

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const port = process.env.MOCK_API_PORT ? Number(process.env.MOCK_API_PORT) : 0
	const handle = await startMockServer({ port })
	console.info(`Mock API server listening on ${handle.url}`)
}
