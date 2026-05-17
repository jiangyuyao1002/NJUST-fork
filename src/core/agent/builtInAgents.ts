/**
 * Built-in Agent Definitions
 *
 * Defines the standard agent types that ship with Roo-Code.
 * These are the foundation for the Agent system and map to the
 * existing SubAgentType enum during migration.
 */

import type { BuiltInAgentDefinition } from "./types"

const EXPLORE_DESCRIPTION =
	"Fast, read-only agent specialized in code exploration, search, and understanding. " +
	"Uses minimal tools to quickly find information across the codebase."

const IMPLEMENT_DESCRIPTION =
	"Full write-permission agent for implementing code changes. " +
	"Has access to file read/write, execute commands, and search tools."

const VERIFY_DESCRIPTION =
	"Read-only agent specialized in running tests, checks, and verification. " +
	"Focused on validating that changes work correctly."

const CUSTOM_DESCRIPTION =
	"Inherits the parent task's full tool set. " +
	"Used when the user wants to delegate without restricting capabilities."

const READ_ONLY_BYPASS_WARNING =
	"This agent uses bypassPermissions only for read-only tools. It must not modify files or run write operations."

export const BUILT_IN_AGENTS: BuiltInAgentDefinition[] = [
	{
		agentType: "Explore",
		description: EXPLORE_DESCRIPTION,
		source: "built-in",
		tools: ["read_file", "search_files", "list_files", "list_code_definition_names", "codebase_search"],
		permissionMode: "bypassPermissions",
		permissionWarning: READ_ONLY_BYPASS_WARNING,
		model: "inherit",
		isolation: "forked",
		cacheAwareFork: true,
		systemPrompt: `You are a code exploration specialist. Your role is to search, read, and understand code — never to modify it.

When given a task:
1. Search for relevant files and code patterns
2. Read and analyze the code thoroughly
3. Report your findings clearly with file paths and line numbers
4. Be thorough — explore multiple search angles before concluding

CRITICAL: You MUST NOT modify any files. You are read-only.`,
		priority: 100,
	},
	{
		agentType: "Implement",
		description: IMPLEMENT_DESCRIPTION,
		source: "built-in",
		tools: ["read_file", "write_to_file", "apply_diff", "execute_command", "search_files", "list_files"],
		permissionMode: "default",
		model: "inherit",
		isolation: "forked",
		cacheAwareFork: true,
		systemPrompt: `You are an implementation specialist. Your role is to write and modify code based on clear instructions.

When given a task:
1. Read the relevant files first to understand the existing code
2. Plan your changes before writing
3. Make focused, minimal changes — don't refactor unrelated code
4. Verify your changes compile or run correctly after making them
5. Report what you changed and why`,
		priority: 100,
	},
	{
		agentType: "Verify",
		description: VERIFY_DESCRIPTION,
		source: "built-in",
		tools: ["read_file", "execute_command", "search_files", "list_files"],
		permissionMode: "bypassPermissions",
		permissionWarning: READ_ONLY_BYPASS_WARNING,
		model: "inherit",
		isolation: "forked",
		cacheAwareFork: true,
		systemPrompt: `You are a verification specialist. Your role is to test, validate, and check code changes.

When given a task:
1. Run the relevant tests or checks
2. Analyze test failures and report root causes
3. Verify that changes meet the stated requirements
4. Report clear pass/fail results with details

CRITICAL: You MUST NOT modify any files. You are read-only for verification only.`,
		priority: 100,
	},
	{
		agentType: "Custom",
		description: CUSTOM_DESCRIPTION,
		source: "built-in",
		tools: ["*"],
		permissionMode: "default",
		model: "inherit",
		isolation: "forked",
		cacheAwareFork: true,
		systemPrompt(params) {
			return `You are a delegated assistant working on a sub-task in ${params.mode} mode.

Your task: ${params.taskDescription}

Follow the instructions carefully and report your results when done.`
		},
		priority: 100,
	},
]

/** Look up a built-in agent by its agentType. Returns undefined if not found. */
export function getBuiltInAgent(agentType: string): BuiltInAgentDefinition | undefined {
	return BUILT_IN_AGENTS.find((a) => a.agentType === agentType)
}
