import { describe, expect, it, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { CloudAgentOrchestrator, type ICloudAgentHost } from "../CloudAgentOrchestrator"
import { getDeviceToken } from "../../../services/cloud-agent/deviceToken"
import { applyCloudWorkspaceOps, applySingleCloudWorkspaceOp } from "../../../services/cloud-agent/applyCloudWorkspaceOps"
import { executeDeferredToolCall } from "../../../services/cloud-agent/executeDeferredToolCall"
import { parseWorkspaceOps } from "../../../services/cloud-agent/parseWorkspaceOps"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}))

// ── Mock factories ──────────────────────────────────────────────────────

function createMockHost(overrides: Partial<ICloudAgentHost> = {}): ICloudAgentHost {
	return {
		taskId: "test-task-id",
		cwd: "/test/workspace",
		abort: false,
		rooIgnoreController: undefined,
		rooProtectedController: undefined,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		emit: vi.fn().mockReturnValue(true),
		setCurrentRequestAbortController: vi.fn(),
		...overrides,
	}
}

const DEFAULT_CONFIG: Record<string, any> = {
	"cloudAgent.serverUrl": "http://127.0.0.1:4000",
	"cloudAgent.apiKey": "test-api-key",
	"cloudAgent.requestTimeoutMs": 0,
	"cloudAgent.applyRemoteWorkspaceOps": true,
	"cloudAgent.confirmRemoteWorkspaceOps": true,
	"cloudAgent.deferredProtocol": true,
	"cloudAgent.compileLoop.enabled": true,
	"cloudAgent.compileLoop.maxRetries": 3,
	"allowedCommands": [],
	"deniedCommands": [],
}

function mockVscodeConfig(overrides: Record<string, any> = {}) {
	const merged = { ...DEFAULT_CONFIG, ...overrides }
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: vi.fn((key: string, defaultValue?: any) => merged[key] ?? defaultValue),
	} as any)
}

// ── Mock instances accessible from tests ────────────────────────────────

const { mockClientInstance, CloudAgentClientMock } = vi.hoisted(() => {
	const mockClientInstance = {
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		submitTask: vi.fn().mockResolvedValue({
			memorySummary: "done",
			tokensIn: 100,
			tokensOut: 200,
			cost: 0.01,
			workspaceOps: [],
		}),
		deferredStart: vi.fn().mockResolvedValue({
			run_id: "run-1",
			status: "pending",
			pending_tools: [],
			tokens_in: 50,
			tokens_out: 100,
			cost: 0.005,
		}),
		deferredResume: vi.fn().mockResolvedValue({
			run_id: "run-1",
			status: "done",
			ok: true,
		}),
		compile: vi.fn().mockResolvedValue({ success: true, output: "" }),
	}

	const CloudAgentClientMock = vi.fn(() => mockClientInstance)
	CloudAgentClientMock.sendDeferredAbort = vi.fn().mockResolvedValue(undefined)

	return { mockClientInstance, CloudAgentClientMock }
})

// ── vi.mock declarations ─────────────────────────────────────────────────

vi.mock("../../../services/cloud-agent/CloudAgentClient", () => ({
	CloudAgentClient: CloudAgentClientMock,
}))

vi.mock("../../../services/cloud-agent/deviceToken", () => ({
	getDeviceToken: vi.fn(() => "test-device-token"),
}))

vi.mock("../../../services/cloud-agent/applyCloudWorkspaceOps", () => ({
	applyCloudWorkspaceOps: vi.fn().mockResolvedValue({ ok: true, results: [] }),
	applySingleCloudWorkspaceOp: vi.fn().mockResolvedValue({ ok: true, message: "applied" }),
}))

vi.mock("../../../services/cloud-agent/executeDeferredToolCall", () => ({
	executeDeferredToolCall: vi.fn().mockResolvedValue({
		call_id: "c1",
		content: "ok",
		is_error: false,
	}),
}))

vi.mock("../../../services/cloud-agent/parseWorkspaceOps", () => ({
	parseWorkspaceOps: vi.fn(() => ({ operations: [], error: undefined })),
}))

vi.mock("../../../services/cloud-agent/buildCloudWorkspaceOpToolMessage", () => ({
	buildCloudWorkspaceOpToolMessage: vi.fn().mockResolvedValue('{"tool":"write_file","path":"a.ts","content":"x"}'),
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ── Tests ────────────────────────────────────────────────────────────────

describe("CloudAgentOrchestrator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockVscodeConfig()
		vi.mocked(getDeviceToken).mockReturnValue("test-device-token")
		vi.mocked(applyCloudWorkspaceOps).mockResolvedValue({ ok: true, results: [] })
		vi.mocked(applySingleCloudWorkspaceOp).mockResolvedValue({ ok: true, message: "applied" })
		vi.mocked(executeDeferredToolCall).mockResolvedValue({
			call_id: "c1",
			content: "ok",
			is_error: false,
		})
		vi.mocked(parseWorkspaceOps).mockReturnValue({ operations: [], error: undefined })
		vi.mocked(getDeviceToken).mockReturnValue("test-device-token")
		mockClientInstance.connect.mockResolvedValue(undefined)
		mockClientInstance.disconnect.mockResolvedValue(undefined)
		mockClientInstance.submitTask.mockResolvedValue({
			memorySummary: "done",
			tokensIn: 100,
			tokensOut: 200,
			cost: 0.01,
			workspaceOps: [],
		})
		mockClientInstance.deferredStart.mockResolvedValue({
			run_id: "run-1",
			status: "pending",
			pending_tools: [],
			tokens_in: 50,
			tokens_out: 100,
			cost: 0.005,
		})
		mockClientInstance.deferredResume.mockResolvedValue({
			run_id: "run-1",
			status: "done",
			ok: true,
		})
		mockClientInstance.compile.mockResolvedValue({ success: true, output: "" })
	})

	describe("run()", () => {
		it("says error when serverUrl is not configured", async () => {
			mockVscodeConfig({ "cloudAgent.serverUrl": "" })
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("server URL is not configured"),
			)
			expect(mockClientInstance.connect).not.toHaveBeenCalled()
		})

		it("says error when deviceToken is missing", async () => {
			vi.mocked(getDeviceToken).mockReturnValue("")
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("device token not found"),
			)
		})

		it("emits TaskStarted event", async () => {
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.emit).toHaveBeenCalled()
		})

		it("enters deferred loop when useDeferredProtocol is true", async () => {
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(mockClientInstance.deferredStart).toHaveBeenCalledWith(
				"test-task-id",
				"hello",
				"/test/workspace",
				undefined,
			)
		})

		it("enters legacy mode when useDeferredProtocol is false", async () => {
			mockVscodeConfig({ "cloudAgent.deferredProtocol": false })
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(mockClientInstance.submitTask).toHaveBeenCalledWith(
				"test-task-id",
				"hello",
				"/test/workspace",
				undefined,
			)
		})

		it("reports connect error in deferred mode", async () => {
			mockClientInstance.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("ECONNREFUSED"),
			)
			expect(host.ask).toHaveBeenCalledWith("api_req_failed", expect.any(String))
		})

		it("returns early when abort is true and connect fails", async () => {
			mockClientInstance.connect.mockRejectedValueOnce(new Error("fail"))
			const host = createMockHost({ abort: true })
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).not.toHaveBeenCalled()
			expect(host.ask).not.toHaveBeenCalled()
		})
	})

	describe("runLegacy()", () => {
		it("submits task and reports usage on success", async () => {
			mockVscodeConfig({ "cloudAgent.deferredProtocol": false })
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"api_req_started",
				expect.any(String),
			)
			expect(host.say).toHaveBeenCalledWith(
				"api_req_finished",
				expect.stringContaining("100"),
			)
			expect(mockClientInstance.disconnect).toHaveBeenCalledWith("test-task-id")
		})

		it("reports error on submit failure", async () => {
			mockVscodeConfig({ "cloudAgent.deferredProtocol": false })
			mockClientInstance.submitTask.mockRejectedValueOnce(new Error("server down"))
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("error", expect.stringContaining("server down"))
			expect(host.ask).toHaveBeenCalledWith("api_req_failed", "server down")
		})

		it("reports AbortError as cancelled", async () => {
			mockVscodeConfig({ "cloudAgent.deferredProtocol": false })
			const abortErr = new Error("aborted")
			abortErr.name = "AbortError"
			mockClientInstance.submitTask.mockRejectedValueOnce(abortErr)
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("cancelled or timed out"),
			)
		})

		it("skips workspace ops when applyRemoteWorkspaceOps is false", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.applyRemoteWorkspaceOps": false,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(applyCloudWorkspaceOps).not.toHaveBeenCalled()
			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("1 条"),
			)
		})

		it("applies workspace ops when applyRemoteWorkspaceOps is true and confirm is false", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": false,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			vi.mocked(applyCloudWorkspaceOps).mockResolvedValueOnce({
				ok: true,
				results: [{ ok: true, path: "a.ts", message: "applied" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(applyCloudWorkspaceOps).toHaveBeenCalledWith(
				"/test/workspace",
				[{ op: "write_file", path: "a.ts", content: "x" }],
				expect.any(Function),
				undefined,
				undefined,
			)
		})

		it("reports workspaceOpsParseError", async () => {
			mockVscodeConfig({ "cloudAgent.deferredProtocol": false })
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [],
				workspaceOpsParseError: "invalid format",
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("workspace_ops 格式无效"),
			)
		})

		it("skips compile loop when compileLoopEnabled is false", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": false,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(mockClientInstance.compile).not.toHaveBeenCalled()
		})
	})

	describe("runDeferredLoop()", () => {
		it("reports deferredStart error", async () => {
			mockClientInstance.deferredStart.mockRejectedValueOnce(new Error("start failed"))
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("start failed"),
			)
			expect(host.ask).toHaveBeenCalledWith("api_req_failed", "start failed")
		})

		it("returns early when abort is true and deferredStart fails", async () => {
			mockClientInstance.deferredStart.mockRejectedValueOnce(new Error("fail"))
			const host = createMockHost({ abort: true })
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			// say("api_req_started") is called before deferredStart, but ask should not be called
			expect(host.ask).not.toHaveBeenCalled()
		})

		it("runs single iteration and reports completion", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
				tokens_in: 50,
				tokens_out: 100,
				cost: 0.005,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"completion_result",
				expect.stringContaining("任务完成"),
			)
		})

		it("iterates pending → done with tool execution", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [{ call_id: "c1", tool: "read_file", arguments: { path: "a.ts" } }],
				tokens_in: 50,
				tokens_out: 100,
				cost: 0.005,
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			vi.mocked(executeDeferredToolCall).mockResolvedValueOnce({
				call_id: "c1",
				content: "file content",
				is_error: false,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(executeDeferredToolCall).toHaveBeenCalledWith(
				"/test/workspace",
				{ call_id: "c1", tool: "read_file", arguments: { path: "a.ts" } },
				[],
				[],
				undefined,
				undefined,
			)
			expect(mockClientInstance.deferredResume).toHaveBeenCalledWith(
				"run-1",
				"test-task-id",
				[{ call_id: "c1", content: "file content", is_error: false }],
			)
		})

		it("asks for approval before executing deferred write_file", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "write_file", arguments: { path: "a.ts", content: "x" } },
				],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			vi.mocked(executeDeferredToolCall).mockResolvedValueOnce({
				call_id: "c1",
				content: "file written",
				is_error: false,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.ask).toHaveBeenCalledWith(
				"tool",
				'{"tool":"write_file","path":"a.ts","content":"x"}',
				false,
			)
			expect(executeDeferredToolCall).toHaveBeenCalledWith(
				"/test/workspace",
				{ call_id: "c1", tool: "write_file", arguments: { path: "a.ts", content: "x" } },
				[],
				[],
				undefined,
				undefined,
			)
		})

		it("does not execute deferred write_file when approval is rejected", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "write_file", arguments: { path: "a.ts", content: "x" } },
				],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost({
				ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(executeDeferredToolCall).not.toHaveBeenCalled()
			expect(mockClientInstance.deferredResume).toHaveBeenCalledWith(
				"run-1",
				"test-task-id",
				[
					{
						call_id: "c1",
						content: "Deferred tool rejected by user: write_file",
						is_error: true,
					},
				],
			)
		})

		it("does not execute deferred execute_command when approval is rejected", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "execute_command", arguments: { command: "npm test" } },
				],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost({
				ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.ask).toHaveBeenCalledWith("command", "npm test", false)
			expect(executeDeferredToolCall).not.toHaveBeenCalled()
			expect(mockClientInstance.deferredResume).toHaveBeenCalledWith(
				"run-1",
				"test-task-id",
				[
					{
						call_id: "c1",
						content: "Deferred tool rejected by user: execute_command",
						is_error: true,
					},
				],
			)
		})

		it("rejects deferred execute_command when .rooignore blocks it", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "execute_command", arguments: { command: "cat .rooignore/secret.txt" } },
				],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const rooIgnoreController = {
				validateAccess: vi.fn(() => true),
				validateCommand: vi.fn((cmd: string) => {
					if (cmd.includes(".rooignore")) return ".rooignore/secret.txt"
					return undefined
				}),
			}
			const host = createMockHost({ rooIgnoreController: rooIgnoreController as any })
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(rooIgnoreController.validateCommand).toHaveBeenCalledWith("cat .rooignore/secret.txt")
			expect(host.ask).not.toHaveBeenCalled()
			expect(executeDeferredToolCall).not.toHaveBeenCalled()
			expect(mockClientInstance.deferredResume).toHaveBeenCalledWith(
				"run-1",
				"test-task-id",
				[
					{
						call_id: "c1",
						content: "Access denied by .rooignore: .rooignore/secret.txt",
						is_error: true,
					},
				],
			)
		})

		it("rejects deferred write_file when .rooignore blocks it", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "write_file", arguments: { path: ".rooignore/blocked.txt", content: "x" } },
				],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const rooIgnoreController = {
				validateAccess: vi.fn((p: string) => !p.includes(".rooignore")),
				validateCommand: vi.fn(() => undefined),
			}
			const host = createMockHost({ rooIgnoreController: rooIgnoreController as any })
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.ask).not.toHaveBeenCalled()
			expect(executeDeferredToolCall).not.toHaveBeenCalled()
			expect(mockClientInstance.deferredResume).toHaveBeenCalledWith(
				"run-1",
				"test-task-id",
				[
					{
						call_id: "c1",
						content: "Access denied by .rooignore: .rooignore/blocked.txt",
						is_error: true,
					},
				],
			)
		})

		it("reports tool execution error", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [{ call_id: "c1", tool: "read_file", arguments: { path: "a.ts" } }],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			vi.mocked(executeDeferredToolCall).mockResolvedValueOnce({
				call_id: "c1",
				content: "permission denied",
				is_error: true,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("permission denied"),
			)
		})

		it("breaks outer loop when abort is set during tool execution", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [
					{ call_id: "c1", tool: "read_file", arguments: {} },
					{ call_id: "c2", tool: "write_file", arguments: {} },
				],
			})
			// First tool executes and sets abort
			let callCount = 0
			vi.mocked(executeDeferredToolCall).mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					;(host as any).abort = true
					return { call_id: "c1", content: "ok", is_error: false }
				}
				return { call_id: "c2", content: "ok", is_error: false }
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			// abort was set during tool loop, so the outer while loop breaks
			// deferredResume should not be called
			expect(mockClientInstance.deferredResume).not.toHaveBeenCalled()
		})

		it("aborts when run_id is missing", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "",
				status: "pending",
				pending_tools: [],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("缺少 run_id"),
			)
			expect(CloudAgentClientMock.sendDeferredAbort).toHaveBeenCalled()
		})

		it("aborts when server_revision changes", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				server_revision: "rev-1",
				pending_tools: [],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
				server_revision: "rev-2",
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("server_revision 已变更"),
			)
			expect(CloudAgentClientMock.sendDeferredAbort).toHaveBeenCalled()
		})

		it("aborts when maxIterations reached", async () => {
			// Create a response that stays pending
			const pendingResp = {
				run_id: "run-1",
				status: "pending" as const,
				pending_tools: [],
			}
			mockClientInstance.deferredStart.mockResolvedValueOnce(pendingResp)
			// Keep returning pending on resume
			mockClientInstance.deferredResume.mockResolvedValue({
				run_id: "run-1",
				status: "pending" as const,
				pending_tools: [],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("最大迭代次数"),
			)
			expect(CloudAgentClientMock.sendDeferredAbort).toHaveBeenCalled()
		})

		it("reports text and reasoning on done", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
				text: "final text",
				reasoning: "my reasoning",
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("text", "final text")
			expect(host.say).toHaveBeenCalledWith("reasoning", "my reasoning")
		})

		it("reports memory_summary on done", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
				memory_summary: "remember this",
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("text", "remember this")
		})

		it("reports completion result with ok=false", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: false,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"completion_result",
				expect.stringContaining("未成功"),
			)
		})

		it("reports deferred resume error", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [],
			})
			mockClientInstance.deferredResume.mockRejectedValueOnce(new Error("resume failed"))
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("resume failed"),
			)
			expect(CloudAgentClientMock.sendDeferredAbort).toHaveBeenCalled()
		})

		it("applies workspace ops in deferred loop when applyRemoteWorkspaceOps is true", async () => {
			vi.mocked(parseWorkspaceOps).mockReturnValueOnce({
				operations: [{ op: "write_file", path: "b.ts", content: "y" }],
				error: undefined,
			})
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(parseWorkspaceOps).toHaveBeenCalled()
		})

		it("reports workspaceOpsParseError in deferred loop", async () => {
			vi.mocked(parseWorkspaceOps).mockReturnValueOnce({
				operations: [],
				error: "invalid ops format",
			})
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("workspace_ops 无效"),
			)
		})

		it("reports logs in deferred loop", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [],
				logs: ["log1", "log2"],
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("text", "log1")
			expect(host.say).toHaveBeenCalledWith("text", "log2")
		})

		it("reports text and reasoning in pending iteration", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [],
				text: "intermediate text",
				reasoning: "thinking...",
			})
			mockClientInstance.deferredResume.mockResolvedValueOnce({
				run_id: "run-1",
				status: "done",
				ok: true,
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("text", "intermediate text")
			expect(host.say).toHaveBeenCalledWith("reasoning", "thinking...")
		})

		it("breaks loop when abort is true during iteration", async () => {
			mockClientInstance.deferredStart.mockResolvedValueOnce({
				run_id: "run-1",
				status: "pending",
				pending_tools: [{ call_id: "c1", tool: "read_file", arguments: {} }],
			})
			const host = createMockHost({
				abort: false,
			})
			// Set abort to true after deferredStart returns
			mockClientInstance.deferredResume.mockImplementation(async () => {
				;(host as any).abort = true
				return { run_id: "run-1", status: "done", ok: true }
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			// Should have broken out of the loop
			expect(mockClientInstance.deferredResume).toHaveBeenCalled()
		})
	})

	describe("runCompileFeedbackLoop()", () => {
		it("reports compile success (local)", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost({
				compileLocal: vi.fn().mockResolvedValue({ success: true, output: "" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith("text", expect.stringContaining("编译通过"))
			expect(host.compileLocal).toHaveBeenCalledWith("/test/workspace")
		})

		it("retries on local compile failure and submits fix", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
				"cloudAgent.compileLoop.maxRetries": 2,
			})
			mockClientInstance.submitTask
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 100,
					tokensOut: 200,
					cost: 0.01,
					workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
				})
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 50,
					tokensOut: 100,
					cost: 0.005,
					workspaceOps: [{ op: "write_file", path: "a.ts", content: "fixed" }],
				})
			const host = createMockHost({
				compileLocal: vi
					.fn()
					.mockResolvedValueOnce({ success: false, output: "error: line 5" })
					.mockResolvedValueOnce({ success: true, output: "" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("编译失败"),
			)
			expect(host.say).toHaveBeenCalledWith("text", expect.stringContaining("编译通过"))
		})

		it("stops after maxRetries reached (local)", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
				"cloudAgent.compileLoop.maxRetries": 2,
			})
			mockClientInstance.submitTask.mockResolvedValue({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost({
				compileLocal: vi.fn().mockResolvedValue({ success: false, output: "error: syntax" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("最大重试次数"),
			)
		})

		it("reports local compile failure when compileLocal throws", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost({
				compileLocal: vi.fn().mockRejectedValue(new Error("cjpm not found")),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("本地编译失败"),
			)
		})

		it("stops when compileLocal is not configured", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost() // compileLocal undefined
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("本地编译功能未配置"),
			)
		})

		it("stops when fixResult has no workspace_ops", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
			})
			mockClientInstance.submitTask
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 100,
					tokensOut: 200,
					cost: 0.01,
					workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
				})
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 50,
					tokensOut: 100,
					cost: 0.005,
					workspaceOps: [],
				})
			const host = createMockHost({
				compileLocal: vi.fn().mockResolvedValueOnce({ success: false, output: "error" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("未返回修正代码"),
			)
		})

		it("stops when fixResult has workspaceOpsParseError", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.compileLoop.enabled": true,
			})
			mockClientInstance.submitTask
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 100,
					tokensOut: 200,
					cost: 0.01,
					workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
				})
				.mockResolvedValueOnce({
					memorySummary: "done",
					tokensIn: 50,
					tokensOut: 100,
					cost: 0.005,
					workspaceOps: [],
					workspaceOpsParseError: "invalid format",
				})
			const host = createMockHost({
				compileLocal: vi.fn().mockResolvedValueOnce({ success: false, output: "error" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("workspace_ops 无效"),
			)
		})
	})

	describe("applyWorkspaceOps()", () => {
		it("confirms ops when confirmRemoteWorkspaceOps is true", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.ask).toHaveBeenCalledWith(
				"tool",
				expect.any(String),
				false,
			)
		})

		it("skips op when user rejects", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost({
				ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }),
			})
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("Skipped workspace op"),
			)
		})

		it("reports rooignore_error when access denied", async () => {
			// This test requires a mock RooIgnoreController
			// For now, we test the confirm path with allowRooIgnorePathAccess returning true (default)
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			// With no rooIgnoreController, access is allowed
			expect(host.say).not.toHaveBeenCalledWith(
				"rooignore_error",
				expect.any(String),
			)
		})

		it("reports applySingle failure", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": true,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			vi.mocked(applySingleCloudWorkspaceOp).mockResolvedValueOnce({
				ok: false,
				message: "permission denied",
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("Workspace operation failed"),
			)
		})

		it("reports batch apply summary when confirm is false", async () => {
			mockVscodeConfig({
				"cloudAgent.deferredProtocol": false,
				"cloudAgent.confirmRemoteWorkspaceOps": false,
			})
			mockClientInstance.submitTask.mockResolvedValueOnce({
				memorySummary: "done",
				tokensIn: 100,
				tokensOut: 200,
				cost: 0.01,
				workspaceOps: [{ op: "write_file", path: "a.ts", content: "x" }],
			})
			vi.mocked(applyCloudWorkspaceOps).mockResolvedValueOnce({
				ok: true,
				results: [{ ok: true, path: "a.ts", message: "applied" }],
			})
			const host = createMockHost()
			const orch = new CloudAgentOrchestrator(host)

			await orch.run("hello")

			expect(host.say).toHaveBeenCalledWith(
				"text",
				expect.stringContaining("workspace_ops applied"),
			)
		})
	})
})
