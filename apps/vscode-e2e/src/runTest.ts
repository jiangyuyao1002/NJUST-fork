import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"

import { runTests } from "@vscode/test-electron"
import { startMockServer } from "../../../packages/mock-api-server/src/runtime.js"

async function main() {
	let testWorkspace: string | undefined
	let exitCode = 0
	const mockHandle = await startMockServer({ port: 0 })
	console.info(`Mock API server started at ${mockHandle.url}`)

	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(process.cwd(), "../../src")

		// The path to the extension test script
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, "./suite/index")

		// Create a temporary workspace folder for tests
		testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-workspace-"))

		// Get test filter from command line arguments or environment variable
		// Usage examples:
		// - npm run test:e2e -- --grep "write-to-file"
		// - TEST_GREP="apply-diff" npm run test:e2e
		// - TEST_FILE="task.test.js" npm run test:e2e
		const testGrep = process.argv.find((arg, i) => process.argv[i - 1] === "--grep") || process.env.TEST_GREP
		const testFile = process.argv.find((arg, i) => process.argv[i - 1] === "--file") || process.env.TEST_FILE

		// Pass test filters as environment variables to the test runner
		const extensionTestsEnv = {
			...process.env,
			MOCK_API_URL: mockHandle.url,
			...(testGrep && { TEST_GREP: testGrep }),
			...(testFile && { TEST_FILE: testFile }),
		}

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [testWorkspace],
			extensionTestsEnv,
			version: process.env.VSCODE_VERSION || "1.101.2",
		})

	} catch (error) {
		console.error("Failed to run tests", error)
		exitCode = 1
	} finally {
		await mockHandle.close()
		if (testWorkspace) {
			await fs.rm(testWorkspace, { recursive: true, force: true })
		}
		if (exitCode !== 0) {
			process.exit(exitCode)
		}
	}
}

main()
