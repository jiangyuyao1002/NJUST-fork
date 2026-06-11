import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockRegister, mockRegisterConditional, mockSetToolRegistry, mockPipeline } = vi.hoisted(() => ({
	mockRegister: vi.fn(),
	mockRegisterConditional: vi.fn(),
	mockSetToolRegistry: vi.fn(),
	mockPipeline: vi.fn(),
}))

// ── Tests ────────────────────────────────────────────────────────────────

describe("registerAllTools", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()

		// Mock the pipeline to capture middleware calls
		mockPipeline.mockImplementation((...middlewares: any[]) => {
			return async (context: any) => {
				let index = -1
				const dispatch = async (nextIndex: number): Promise<void> => {
					if (nextIndex <= index) return
					index = nextIndex
					const middleware = middlewares[nextIndex]
					if (!middleware) return
					await middleware(context, () => dispatch(nextIndex + 1))
				}
				await dispatch(0)
			}
		})

		vi.doMock("../ToolRegistrationPipeline", () => ({
			createToolRegistrationPipeline: mockPipeline,
			registerStaticTools: vi.fn((tools: readonly any[]) => async (context: any, next: any) => {
				for (const tool of tools) {
					context.registry.register(tool)
				}
				await next()
			}),
			registerConditionalTools: vi.fn((tools: readonly any[]) => async (context: any, next: any) => {
				for (const entry of tools) {
					context.registry.registerConditional(entry.tool, entry.condition)
				}
				await next()
			}),
			wireToolSearchRegistry: vi.fn((toolSearch: any) => async (context: any, next: any) => {
				toolSearch.setToolRegistry(context.registry)
				await next()
			}),
		}))

		vi.doMock("../ToolRegistry", () => ({
			toolRegistry: {
				register: mockRegister,
				registerConditional: mockRegisterConditional,
				getAllTools: vi.fn(() => []),
				has: vi.fn(() => false),
				get: vi.fn(() => undefined),
			},
		}))

		vi.doMock("../ToolSearchTool", () => ({
			toolSearchTool: {
				name: "tool_search",
				setToolRegistry: mockSetToolRegistry,
			},
		}))

		// Mock all tool singletons
		const makeMockTool = (name: string) => ({
			name,
			aliases: [],
			execute: vi.fn(),
			isConcurrencySafe: () => false,
			isReadOnly: () => false,
			requiresCheckpoint: false,
			shouldDefer: false,
		})

		vi.doMock("../ListFilesTool", () => ({ listFilesTool: makeMockTool("list_files") }))
		vi.doMock("../ReadFileTool", () => ({ readFileTool: makeMockTool("read_file") }))
		vi.doMock("../ReadCommandOutputTool", () => ({ readCommandOutputTool: makeMockTool("read_command_output") }))
		vi.doMock("../WriteToFileTool", () => ({ writeToFileTool: makeMockTool("write_to_file") }))
		vi.doMock("../EditTool", () => ({ editTool: makeMockTool("edit") }))
		vi.doMock("../ApplyPatchTool", () => ({ applyPatchTool: makeMockTool("apply_patch") }))
		vi.doMock("../SearchFilesTool", () => ({ searchFilesTool: makeMockTool("search_files") }))
		vi.doMock("../ExecuteCommandTool", () => ({ executeCommandTool: makeMockTool("execute_command") }))
		vi.doMock("../UseMcpToolTool", () => ({ useMcpToolTool: makeMockTool("use_mcp_tool") }))
		vi.doMock("../accessMcpResourceTool", () => ({ accessMcpResourceTool: makeMockTool("access_mcp_resource") }))
		vi.doMock("../AskFollowupQuestionTool", () => ({
			askFollowupQuestionTool: makeMockTool("ask_followup_question"),
		}))
		vi.doMock("../SwitchModeTool", () => ({ switchModeTool: makeMockTool("switch_mode") }))
		vi.doMock("../AttemptCompletionTool", () => ({ attemptCompletionTool: makeMockTool("attempt_completion") }))
		vi.doMock("../NewTaskTool", () => ({ newTaskTool: makeMockTool("new_task") }))
		vi.doMock("../UpdateTodoListTool", () => ({ updateTodoListTool: makeMockTool("update_todo_list") }))
		vi.doMock("../RunSlashCommandTool", () => ({ runSlashCommandTool: makeMockTool("run_slash_command") }))
		vi.doMock("../SkillTool", () => ({ skillTool: makeMockTool("skill") }))
		vi.doMock("../GenerateImageTool", () => ({ generateImageTool: makeMockTool("generate_image") }))
		vi.doMock("../WebSearchTool", () => ({ webSearchTool: makeMockTool("web_search") }))
		vi.doMock("../WebFetchTool", () => ({ webFetchTool: makeMockTool("web_fetch") }))
		vi.doMock("../CodebaseSearchTool", () => ({ codebaseSearchTool: makeMockTool("codebase_search") }))
		vi.doMock("../GrepTool", () => ({ grepTool: makeMockTool("grep") }))
		vi.doMock("../GlobTool", () => ({ globTool: makeMockTool("glob") }))
		vi.doMock("../LSPTool", () => ({ lspTool: makeMockTool("lsp") }))
		vi.doMock("../SleepTool", () => ({ sleepTool: makeMockTool("sleep") }))
		vi.doMock("../NotebookEditTool", () => ({ notebookEditTool: makeMockTool("notebook_edit") }))
		vi.doMock("../TaskCreateTool", () => ({ taskCreateTool: makeMockTool("task_create") }))
		vi.doMock("../TaskUpdateTool", () => ({ taskUpdateTool: makeMockTool("task_update") }))
		vi.doMock("../TaskListTool", () => ({ taskListTool: makeMockTool("task_list") }))
		vi.doMock("../TaskGetTool", () => ({ taskGetTool: makeMockTool("task_get") }))
		vi.doMock("../TaskStopTool", () => ({ taskStopTool: makeMockTool("task_stop") }))
		vi.doMock("../TaskOutputTool", () => ({ taskOutputTool: makeMockTool("task_output") }))
		vi.doMock("../AgentTool", () => ({ agentTool: makeMockTool("agent") }))
		vi.doMock("../SendMessageTool", () => ({ sendMessageTool: makeMockTool("send_message") }))
		vi.doMock("../BriefTool", () => ({ briefTool: makeMockTool("brief") }))
		vi.doMock("../ConfigTool", () => ({ configTool: makeMockTool("config") }))

		// Mock conditional tool
		vi.doMock("../WorktreeTool", () => ({
			WorktreeTool: class {
				name = "worktree"
				aliases = []
				static isAvailable() {
					return true
				}
			},
		}))
	})

	it("invokes createToolRegistrationPipeline with 3 middlewares", async () => {
		await import("../registerAllTools")
		// Wait for the void async pipeline to settle
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockPipeline).toHaveBeenCalledTimes(1)
		// 3 middlewares: registerStaticTools, wireToolSearchRegistry, registerConditionalTools
		expect(mockPipeline).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.any(Function))
	})

	it("registers all static tools through the registry", async () => {
		await import("../registerAllTools")
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Count tools in the allTools array of registerAllTools.ts: 40 tools
		expect(mockRegister).toHaveBeenCalled()
		const registeredNames = mockRegister.mock.calls.map((call: any) => call[0].name)

		// Verify key tools are present
		const expectedTools = [
			"list_files",
			"read_file",
			"write_to_file",
			"edit",
			"execute_command",
			"search_files",
			"glob",
			"lsp",
			"grep",
			"agent",
			"tool_search",
			"brief",
			"config",
			"read_command_output",
			"apply_patch",
			"use_mcp_tool",
			"access_mcp_resource",
			"ask_followup_question",
			"switch_mode",
			"attempt_completion",
			"new_task",
			"update_todo_list",
			"run_slash_command",
			"skill",
			"generate_image",
			"web_search",
			"web_fetch",
			"codebase_search",
			"sleep",
			"notebook_edit",
			"task_create",
			"task_update",
			"task_list",
			"task_get",
			"task_stop",
			"task_output",
			"send_message",
		]
		for (const name of expectedTools) {
			expect(registeredNames).toContain(name)
		}

		// Should have registered exactly 37 static tools
		expect(mockRegister).toHaveBeenCalledTimes(37)
	})

	it("registers conditional tools (WorktreeTool)", async () => {
		await import("../registerAllTools")
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockRegisterConditional).toHaveBeenCalledTimes(1)
		expect(mockRegisterConditional).toHaveBeenCalledWith(
			expect.objectContaining({ name: "worktree" }),
			expect.any(Function),
		)
	})

	it("wires tool search to the registry", async () => {
		await import("../registerAllTools")
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(mockSetToolRegistry).toHaveBeenCalled()
	})
})
