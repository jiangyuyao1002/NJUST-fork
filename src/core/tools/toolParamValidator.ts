/**
 * Tool Parameter Validator
 *
 * Provides runtime validation of tool call parameters using zod schemas.
 * When a model emits a tool call with invalid or missing arguments, this
 * layer catches the error early — before the tool executes — and produces
 * a clear error message that can be fed back to the model for self-correction.
 *
 * All native tools should register their schemas here for unified validation.
 *
 * **Aliases:** Some tool names are aliases of canonical tools (see TOOL_ALIASES).
 * Validation resolves only safe compatibility aliases to the canonical schema.
 */
import { z, type ZodTypeAny } from "zod"

import {
	optionalBooleanCoerced,
	optionalNumberOrNumericString,
	optionalPositiveIntCoerced,
} from "./toolParamZodHelpers"

const pathSchema = z.string().min(1, "path must not be empty")

// ── Unified error format ──────────────────────────────────────────────
export interface ToolValidationIssue {
	field: string
	reason: string
	expected?: string
}

export interface ToolValidationResult {
	valid: boolean
	/** Structured issues for programmatic handling. */
	issues?: ToolValidationIssue[]
	/** Human-readable error for feeding back to the model. */
	error?: string
}

function formatValidationError(toolName: string, issues: ToolValidationIssue[]): string {
	const lines = issues.map((i) => {
		let line = `${i.field}: ${i.reason}`
		if (i.expected) {
			line += ` (expected: ${i.expected})`
		}
		return line
	})
	return `Invalid parameters for tool "${toolName}": ${lines.join("; ")}`
}

function zodIssuesToValidationIssues(zodIssues: z.ZodIssue[]): ToolValidationIssue[] {
	return zodIssues.map((issue) => {
		const detail = issue as unknown as Record<string, unknown>
		const expected = detail?.expected
		const received = detail?.received
		return {
			field: issue.path.join(".") || "<root>",
			reason: issue.message,
			expected:
				expected !== undefined && received !== undefined
					? `${JSON.stringify(expected)}`
					: undefined,
		}
	})
}

// ── Factory ───────────────────────────────────────────────────────────
export interface ToolValidator<T = Record<string, unknown>> {
	validate(params: Record<string, unknown>): ToolValidationResult
	/** Optional: returns the parsed/typed params when valid. */
	parse?(params: Record<string, unknown>): T | undefined
}

/**
 * Create a reusable tool validator from a Zod schema.
 *
 * @param schema - Zod schema describing the tool's parameters
 * @returns ToolValidator with unified error formatting
 */
export function createToolValidator<T = Record<string, unknown>>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): ToolValidator<T> {
	return {
		validate(params) {
			const result = schema.safeParse(params)
			if (result.success) {
				return { valid: true }
			}
			const issues = zodIssuesToValidationIssues(result.error.issues)
			return {
				valid: false,
				issues,
				error: formatValidationError("tool", issues),
			}
		},
		parse(params) {
			const result = schema.safeParse(params)
			return result.success ? result.data : undefined
		},
	}
}

// ── Native tool schemas ───────────────────────────────────────────────
const toolSchemas = {
	read_file: z.object({
		path: pathSchema,
		offset: optionalPositiveIntCoerced,
		limit: optionalPositiveIntCoerced,
		start_line: optionalPositiveIntCoerced,
		end_line: optionalPositiveIntCoerced,
	}),

	write_to_file: z.object({
		path: pathSchema,
		content: z.string(),
	}),

	apply_diff: z.object({
		path: pathSchema,
		diff: z.string().min(1, "diff must not be empty"),
	}),

	apply_patch: z.object({
		patch: z.string().min(1, "patch must not be empty"),
	}),

	edit: z.object({
		file_path: pathSchema,
		old_string: z.string(),
		new_string: z.string(),
		replace_all: optionalBooleanCoerced,
	}),

	edit_file: z.object({
		file_path: pathSchema,
		old_string: z.string(),
		new_string: z.string(),
		expected_replacements: optionalPositiveIntCoerced,
	}),

	search_and_replace: z.object({
		file_path: pathSchema,
		old_string: z.string(),
		new_string: z.string(),
		replace_all: optionalBooleanCoerced,
	}),

	search_replace: z.object({
		file_path: pathSchema,
		old_string: z.string(),
		new_string: z.string(),
	}),

	execute_command: z.object({
		command: z.string().min(1, "command must not be empty"),
		cwd: z.string().optional().nullable(),
		timeout: optionalNumberOrNumericString,
	}),

	search_files: z.object({
		path: pathSchema,
		regex: z.string().min(1, "regex must not be empty"),
		file_pattern: z.string().optional().nullable(),
	}),

	list_files: z.object({
		path: pathSchema,
		recursive: z.union([z.boolean(), z.string()]).optional(),
	}),

	use_mcp_tool: z.object({
		server_name: z.string().min(1, "server_name must not be empty"),
		tool_name: z.string().min(1, "tool_name must not be empty"),
		arguments: z.record(z.unknown()).optional(),
	}),

	new_task: z.object({
		mode: z.string().min(1, "mode must not be empty"),
		message: z.string().min(1, "message must not be empty"),
	}),

	switch_mode: z.object({
		mode_slug: z.string().min(1, "mode_slug must not be empty"),
		reason: z.string().optional(),
	}),

	codebase_search: z.object({
		query: z.string().min(1, "query must not be empty"),
		path: z.string().optional(),
	}),

	web_search: z.object({
		search_query: z.string().min(1, "search_query must not be empty"),
		count: optionalPositiveIntCoerced,
	}),

	web_fetch: z.object({
		url: z.string().url("url must be a valid URL"),
	}),

	ask_followup_question: z.object({
		question: z.string().min(1, "question must not be empty"),
	}),

	attempt_completion: z.object({
		result: z.string().min(1, "result must not be empty"),
	}),

	// Additional tools migrating from manual if-checks
	brief: z.object({
		message: z.string().min(1, "message must not be empty").optional(),
	}),

	config: z.object({
		key: z.string().min(1, "key must not be empty"),
		value: z.unknown().optional(),
	}),

	generate_image: z.object({
		prompt: z.string().min(1, "prompt must not be empty"),
		model: z.string().optional(),
		size: z.string().optional(),
		quality: z.string().optional(),
		style: z.string().optional(),
	}),

	glob: z.object({
		pattern: z.string().min(1, "Glob pattern is required"),
		path: z.string().optional(),
	}),

	grep: z.object({
		pattern: z.string().min(1, "pattern must not be empty"),
		path: z.string().optional(),
		recursive: optionalBooleanCoerced,
	}),

	lsp: z.object({
		filePath: z.string().min(1, "filePath is required"),
		line: z.number().int().nonnegative().optional(),
		character: z.number().int().nonnegative().optional(),
		symbolName: z.string().optional(),
	}),

	read_command_output: z.object({
		command_id: z.string().min(1, "command_id must not be empty"),
	}),

	run_slash_command: z.object({
		command: z.string().min(1, "command must not be empty"),
		args: z.string().optional(),
	}),

	send_message: z.object({
		message: z.string().min(1, "message must not be empty"),
	}),

	skill: z.object({
		skill_id: z.string().min(1, "skill_id must not be empty"),
		args: z.record(z.unknown()).optional(),
	}),

	sleep: z.object({
		duration: z.union([z.number().positive(), z.string().min(1)]),
	}),

	task_create: z.object({
		title: z.string().min(1, "title must not be empty"),
		description: z.string().optional(),
	}),

	task_get: z.object({
		taskId: z.string().min(1, "taskId must not be empty"),
	}),

	task_list: z.object({}),

	task_output: z.object({
		taskId: z.string().min(1, "taskId must not be empty"),
	}),

	task_stop: z.object({
		taskId: z.string().min(1, "taskId must not be empty"),
	}),

	task_update: z.object({
		taskId: z.string().min(1, "taskId must not be empty"),
		status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]).optional(),
		title: z.string().optional(),
		description: z.string().optional(),
	}),

	update_todo_list: z.object({
		todos: z.string().min(1, "todos must not be empty"),
	}),

	agent: z.object({
		name: z.string().min(1, "name must not be empty"),
		message: z.string().min(1, "message must not be empty"),
	}),

	access_mcp_resource: z.object({
		server_name: z.string().min(1, "server_name must not be empty"),
		uri: z.string().min(1, "uri must not be empty"),
	}),

	notebook_edit: z.object({
		file_path: pathSchema,
		cell_index: optionalPositiveIntCoerced,
		new_source: z.string().optional(),
	}),

	powershell: z.object({
		command: z.string().min(1, "command must not be empty"),
		cwd: z.string().optional().nullable(),
		timeout: optionalNumberOrNumericString,
	}),
} as const satisfies Record<string, z.ZodTypeAny>

type ValidatableToolName = keyof typeof toolSchemas

/**
 * Map alias tool names to a schema key when parameter shapes match.
 * Do not add `edit_file`→`edit` here (different fields).
 */
const VALIDATION_SCHEMA_BY_ALIAS: Partial<Record<string, ValidatableToolName>> = {
	write_file: "write_to_file",
	search_and_replace: "edit",
}

function resolveValidationSchemaKey(toolName: string): ValidatableToolName | undefined {
	if (toolName in toolSchemas) {
		return toolName as ValidatableToolName
	}
	return VALIDATION_SCHEMA_BY_ALIAS[toolName]
}

/**
 * Validate the arguments for a named tool.
 * Returns `{ valid: true }` for tools without a registered schema (pass-through).
 */
export function validateToolParams(toolName: string, params: Record<string, unknown>): ToolValidationResult {
	const schemaKey = resolveValidationSchemaKey(toolName)
	const schema = schemaKey ? toolSchemas[schemaKey] : undefined
	if (!schema) {
		return { valid: true }
	}

	const result = schema.safeParse(params)
	if (result.success) {
		return { valid: true }
	}

	const issues = zodIssuesToValidationIssues(result.error.issues)
	return {
		valid: false,
		issues,
		error: formatValidationError(toolName, issues),
	}
}

/**
 * Returns the list of tool names that have registered validation schemas.
 */
export function getValidatableToolNames(): string[] {
	return Object.keys(toolSchemas)
}
