/**
 * Central tool registration module.
 *
 * Imports all tool singletons and registers them with the ToolRegistry.
 * This module is imported once at startup (side-effect import) to populate
 * the registry before any tool dispatch occurs.
 *
 * Adding a new tool requires adding its import and one entry in the list below.
 *
 * Tool registration is routed through ToolRegistrationPipeline middleware.
 */
import { toolRegistry } from "./ToolRegistry"
import {
	createToolRegistrationPipeline,
	registerConditionalTools,
	registerStaticTools,
	wireToolSearchRegistry,
} from "./ToolRegistrationPipeline"

// Tool singletons
import { listFilesTool } from "./ListFilesTool"
import { readFileTool } from "./ReadFileTool"
import { readCommandOutputTool } from "./ReadCommandOutputTool"
import { writeToFileTool } from "./WriteToFileTool"
import { editTool } from "./EditTool"
import { searchReplaceTool } from "./SearchReplaceTool"
import { editFileTool } from "./EditFileTool"
import { applyPatchTool } from "./ApplyPatchTool"
import { applyDiffTool } from "./ApplyDiffTool"
import { searchFilesTool } from "./SearchFilesTool"
import { executeCommandTool } from "./ExecuteCommandTool"
import { useMcpToolTool } from "./UseMcpToolTool"
import { accessMcpResourceTool } from "./accessMcpResourceTool"
import { askFollowupQuestionTool } from "./AskFollowupQuestionTool"
import { switchModeTool } from "./SwitchModeTool"
import { attemptCompletionTool } from "./AttemptCompletionTool"
import { newTaskTool } from "./NewTaskTool"
import { updateTodoListTool } from "./UpdateTodoListTool"
import { runSlashCommandTool } from "./RunSlashCommandTool"
import { skillTool } from "./SkillTool"
import { generateImageTool } from "./GenerateImageTool"
import { webSearchTool } from "./WebSearchTool"
import { webFetchTool } from "./WebFetchTool"
import { codebaseSearchTool } from "./CodebaseSearchTool"
import { grepTool } from "./GrepTool"
import { globTool } from "./GlobTool"
import { lspTool } from "./LSPTool"
import { sleepTool } from "./SleepTool"
import { notebookEditTool } from "./NotebookEditTool"
import { taskCreateTool } from "./TaskCreateTool"
import { taskUpdateTool } from "./TaskUpdateTool"
import { taskListTool } from "./TaskListTool"
import { taskGetTool } from "./TaskGetTool"
import { taskStopTool } from "./TaskStopTool"
import { taskOutputTool } from "./TaskOutputTool"
import { toolSearchTool } from "./ToolSearchTool"
import { agentTool } from "./AgentTool"
import { sendMessageTool } from "./SendMessageTool"
import { briefTool } from "./BriefTool"
import { configTool } from "./ConfigTool"

// Conditional tools
// PowerShellTool deprecated — use execute_command with powershell.exe directly.
// import { PowerShellTool } from "./PowerShellTool"
import { WorktreeTool } from "./WorktreeTool"

// Register all tools with the central registry
const allTools = [
	listFilesTool,
	readFileTool,
	readCommandOutputTool,
	writeToFileTool,
	editTool,
	searchReplaceTool,
	editFileTool,
	applyPatchTool,
	applyDiffTool,
	searchFilesTool,
	executeCommandTool,
	useMcpToolTool,
	accessMcpResourceTool,
	askFollowupQuestionTool,
	switchModeTool,
	attemptCompletionTool,
	newTaskTool,
	updateTodoListTool,
	runSlashCommandTool,
	skillTool,
	generateImageTool,
	webSearchTool,
	webFetchTool,
	codebaseSearchTool,
	grepTool,
	globTool,
	lspTool,
	sleepTool,
	notebookEditTool,
	taskCreateTool,
	taskUpdateTool,
	taskListTool,
	taskGetTool,
	taskStopTool,
	taskOutputTool,
	toolSearchTool,
	agentTool,
	sendMessageTool,
	briefTool,
	configTool,
] as const

const conditionalTools = [
	// PowerShellTool deprecated — use execute_command with powershell.exe directly.
	// { tool: new PowerShellTool(), condition: () => PowerShellTool.isAvailable() },
	{ tool: new WorktreeTool(), condition: () => WorktreeTool.isAvailable() },
] as const

void createToolRegistrationPipeline(
	registerStaticTools(allTools),
	wireToolSearchRegistry(toolSearchTool),
	registerConditionalTools(conditionalTools),
)({ registry: toolRegistry })
