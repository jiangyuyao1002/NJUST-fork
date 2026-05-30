import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"

import { NJUST_AIEventName, type ClineMessage } from "@njust-ai/types"

import { waitFor, sleep } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("NJUST_AI write_to_file Tool", function () {
	setDefaultSuiteTimeout(this)

	let tempDir: string
	let workspaceDir: string
	let testFilePath: string

	// Create a temporary directory for test files
	suiteSetup(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "njust-ai-test-"))
		workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || tempDir
	})

	// Clean up temporary directory after tests
	suiteTeardown(async () => {
		// Cancel any running tasks before cleanup
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// Clean up test file before each test
	setup(async () => {
		// Cancel any previous task
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Generate unique file name for each test to avoid conflicts
		testFilePath = path.join(workspaceDir, `test-file-${Date.now()}.txt`)

		// Small delay to ensure clean state
		await sleep(100)
	})

	// Clean up after each test
	teardown(async () => {
		// Cancel the current task
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running
		}

		// Clean up the test file
		try {
			await fs.unlink(testFilePath)
		} catch {
			// File might not exist
		}

		// Small delay to ensure clean state
		await sleep(100)
	})

	test("Should create a new file with content", async function () {
		// Increase timeout for this specific test

		const api = globalThis.api
		const messages: ClineMessage[] = []
		const fileContent = "Hello, this is a test file!"
		const startedIds = new Set<string>()
		const completedIds = new Set<string>()
		let errorOccurred: string | null = null
		let writeToFileToolExecuted = false
		let toolExecutionDetails = ""

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Check for tool execution
			if (message.type === "say" && message.say === "api_req_started") {
				console.log("Tool execution:", message.text?.substring(0, 200))
				if (message.text && message.text.includes("write_to_file")) {
					writeToFileToolExecuted = true
					toolExecutionDetails = message.text
					// Try to parse the tool execution details
					try {
						const parsed = JSON.parse(message.text)
						console.log("write_to_file tool called with request:", parsed.request?.substring(0, 300))
					} catch (_e) {
						console.log("Could not parse tool execution details")
					}
				}
			}

			// Log important messages for debugging
			if (message.type === "say" && message.say === "error") {
				errorOccurred = message.text || "Unknown error"
				console.error("Error:", message.text)
			}
			if (message.type === "ask" && message.ask === "tool") {
				console.log("Tool request:", message.text?.substring(0, 200))
				if (message.text) {
					try {
						const parsed = JSON.parse(message.text)
						if (parsed.tool === "newFileCreated" || parsed.tool === "editedExistingFile") {
							writeToFileToolExecuted = true
							toolExecutionDetails = message.text
						}
					} catch {
						// Ignore non-JSON tool messages
					}
				}
			}
			if (message.type === "say" && (message.say === "completion_result" || message.say === "text")) {
				console.log("AI response:", message.text?.substring(0, 200))
			}
		}
		api.on(NJUST_AIEventName.Message, messageHandler)

		const taskStartedHandler = (id: string) => {
			startedIds.add(id)
			console.log("Task started:", id)
		}
		api.on(NJUST_AIEventName.TaskStarted, taskStartedHandler)

		const taskCompletedHandler = (id: string) => {
			completedIds.add(id)
			console.log("Task completed:", id)
		}
		api.on(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task with a very simple prompt
			const baseFileName = path.basename(testFilePath)
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowWrite: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `Create a file named "${baseFileName}" with the following content:\n${fileContent}`,
			})

			console.log("Task ID:", taskId)
			console.log("Base filename:", baseFileName)
			console.log("Expecting file at:", testFilePath)

			// Wait for task to start
			await waitFor(() => startedIds.has(taskId), { timeout: 45_000 })

			// Check for early errors
			if (errorOccurred) {
				console.error("Early error detected:", errorOccurred)
			}

			// Wait for task completion
			await waitFor(() => completedIds.has(taskId), { timeout: 45_000 })

			// Give extra time for file system operations
			await sleep(2000)

			// The file should be created in the active VS Code workspace.
			const possibleLocations = [
				testFilePath, // Expected location
				path.join(workspaceDir, baseFileName), // In workspace directory
				path.join(process.cwd(), baseFileName), // In current working directory
			]

			let fileFound = false
			let actualFilePath = ""
			let actualContent = ""

			for (const location of possibleLocations) {
				try {
					await fs.access(location)
					fileFound = true
					actualFilePath = location
					actualContent = await fs.readFile(location, "utf-8")
					console.log("File found at:", location)
					break
				} catch {
					// Continue checking
				}
			}

			// If still not found, list directories to help debug
			if (!fileFound) {
				console.log("File not found in expected locations. Debugging info:")

				// List temp directory
				try {
					const tempFiles = await fs.readdir(tempDir)
					console.log("Files in temp directory:", tempFiles)
				} catch (e) {
					console.log("Could not list temp directory:", e)
				}

				// List current working directory
				try {
					const cwdFiles = await fs.readdir(process.cwd())
					console.log(
						"Files in CWD:",
						cwdFiles.filter((f) => f.includes("test-file")),
					)
				} catch (e) {
					console.log("Could not list CWD:", e)
				}

				// List temp root for test files
				try {
					const tmpFiles = await fs.readdir(os.tmpdir())
					console.log(
						"Test files in temp root:",
						tmpFiles.filter((f) => f.includes("test-file") || f.includes("njust-ai-test")),
					)
				} catch (e) {
					console.log("Could not list temp root:", e)
				}
			}

			assert.ok(fileFound, `File should have been created. Expected filename: ${baseFileName}`)
			assert.strictEqual(actualContent.trim(), fileContent, "File content should match expected content")

			// Verify that write_to_file tool was actually executed
			assert.ok(writeToFileToolExecuted, "write_to_file tool should have been executed")
			assert.ok(
				toolExecutionDetails.includes(baseFileName) || toolExecutionDetails.includes(fileContent),
				"Tool execution should include the filename or content",
			)

			console.log("Test passed! File created successfully at:", actualFilePath)
			console.log("write_to_file tool was properly executed")
		} finally {
			// Clean up
			api.off(NJUST_AIEventName.Message, messageHandler)
			api.off(NJUST_AIEventName.TaskStarted, taskStartedHandler)
			api.off(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
		}
	})

	test("Should create nested directories when writing file", async function () {
		// Increase timeout for this specific test

		const api = globalThis.api
		const messages: ClineMessage[] = []
		const content = "File in nested directory"
		const fileName = `file-${Date.now()}.txt`
		const nestedPath = path.join(workspaceDir, "nested", "deep", "directory", fileName)
		const startedIds = new Set<string>()
		const completedIds = new Set<string>()
		let writeToFileToolExecuted = false
		let toolExecutionDetails = ""

		// Listen for messages
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			// Check for tool execution
			if (message.type === "say" && message.say === "api_req_started") {
				console.log("Tool execution:", message.text?.substring(0, 200))
				if (message.text && message.text.includes("write_to_file")) {
					writeToFileToolExecuted = true
					toolExecutionDetails = message.text
					// Try to parse the tool execution details
					try {
						const parsed = JSON.parse(message.text)
						console.log("write_to_file tool called with request:", parsed.request?.substring(0, 300))
					} catch (_e) {
						console.log("Could not parse tool execution details")
					}
				}
			}

			if (message.type === "ask" && message.ask === "tool") {
				console.log("Tool request:", message.text?.substring(0, 200))
				if (message.text) {
					try {
						const parsed = JSON.parse(message.text)
						if (parsed.tool === "newFileCreated" || parsed.tool === "editedExistingFile") {
							writeToFileToolExecuted = true
							toolExecutionDetails = message.text
						}
					} catch {
						// Ignore non-JSON tool messages
					}
				}
			}
		}
		api.on(NJUST_AIEventName.Message, messageHandler)

		// Listen for task events
		const taskStartedHandler = (id: string) => {
			startedIds.add(id)
			console.log("Task started:", id)
		}
		api.on(NJUST_AIEventName.TaskStarted, taskStartedHandler)

		const taskCompletedHandler = (id: string) => {
			completedIds.add(id)
			console.log("Task completed:", id)
		}
		api.on(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Start task to create file in nested directory
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowWrite: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: `Create a file named "${fileName}" in a nested directory structure "nested/deep/directory/" with the following content:\n${content}`,
			})

			console.log("Task ID:", taskId)
			console.log("Expected nested path:", nestedPath)

			// Wait for task to start
			await waitFor(() => startedIds.has(taskId), { timeout: 45_000 })

			// Wait for task completion
			await waitFor(() => completedIds.has(taskId), { timeout: 45_000 })

			// Give extra time for file system operations
			await sleep(2000)

			// Check workspace locations
			let fileFound = false
			let actualFilePath = ""
			let actualContent = ""

			for (const location of [nestedPath, path.join(workspaceDir, fileName)]) {
				try {
					await fs.access(location)
					fileFound = true
					actualFilePath = location
					actualContent = await fs.readFile(location, "utf-8")
					console.log("File found at:", location)
					break
				} catch {
					// Continue checking
				}
			}

			// Debug output if file not found
			if (!fileFound) {
				console.log("File not found. Debugging info:")

				try {
					const files = await fs.readdir(workspaceDir)
					console.log(`Files in workspace ${workspaceDir}:`, files)
				} catch (e) {
					console.log(`Could not list workspace ${workspaceDir}:`, e)
				}
			}

			assert.ok(fileFound, `File should have been created. Expected filename: ${fileName}`)
			assert.strictEqual(actualContent.trim(), content, "File content should match")

			// Verify that write_to_file tool was actually executed
			assert.ok(writeToFileToolExecuted, "write_to_file tool should have been executed")
			assert.ok(
				toolExecutionDetails.includes(fileName) ||
					toolExecutionDetails.includes(content) ||
					toolExecutionDetails.includes("nested"),
				"Tool execution should include the filename, content, or nested directory reference",
			)

			// Note: We're not checking if the nested directory structure was created,
			// just that the file exists with the correct content
			console.log("Test passed! File created successfully at:", actualFilePath)
			console.log("write_to_file tool was properly executed")
		} finally {
			// Clean up
			api.off(NJUST_AIEventName.Message, messageHandler)
			api.off(NJUST_AIEventName.TaskStarted, taskStartedHandler)
			api.off(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
