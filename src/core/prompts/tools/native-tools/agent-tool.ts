import type OpenAI from "openai"

const AGENT_TOOL_DESCRIPTION = `Spawn an independent sub-agent to perform a specific task with forked context isolation.

The sub-agent operates independently with its own conversation context, separated from the parent task. Use this when you need to delegate a self-contained piece of work (exploration, implementation, verification) without polluting the current context.

Key differences from new_task:
- Always uses forked isolation (independent context, no shared conversation history)
- Specialized agent types with pre-configured tool sets
- Concurrency limit: maximum 3 active sub-agents at a time

CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn.

Example: Create a search agent to explore the codebase
{ "task": "Search the codebase for all usages of the AuthService class and summarize how authentication is implemented.", "agentType": "explore", "maxTurns": null }

Example: Create an agent to implement a feature
{ "task": "Add input validation to the user registration form in src/components/RegisterForm.tsx. Ensure email format and password strength checks.", "agentType": "implement", "maxTurns": 10 }

Example: Create a verification agent to run tests
{ "task": "Run the test suite for src/utils/ and report any failures with details.", "agentType": "verify", "maxTurns": 5 }`

const TASK_PARAMETER_DESCRIPTION = `A clear, detailed description of the task for the sub-agent to perform. Include all necessary context, file paths, and expected outcomes since the agent operates with an independent context.`

const AGENT_TYPE_PARAMETER_DESCRIPTION = `The type of sub-agent to spawn, which determines available tools:
- "explore": Read-only tools for code search and understanding (read_file, search_files, list_files, codebase_search)
- "implement": Full write permissions for code changes (read_file, write_to_file, apply_patch, execute_command, search_files)
- "verify": Testing and validation tools (read_file, execute_command, search_files, list_files)
- "custom": Inherits parent task tools (default)`

const MAX_TURNS_PARAMETER_DESCRIPTION = `Optional maximum number of conversation turns the sub-agent is allowed. Use this to constrain long-running agents. If not specified, no limit is imposed.`

export default {
	type: "function",
	function: {
		name: "agent",
		description: AGENT_TOOL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: TASK_PARAMETER_DESCRIPTION,
				},
				agentType: {
					type: ["string", "null"],
					enum: ["explore", "implement", "verify", "custom", null],
					description: AGENT_TYPE_PARAMETER_DESCRIPTION,
				},
				maxTurns: {
					type: ["integer", "null"],
					description: MAX_TURNS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
