import type OpenAI from "openai"

const EDIT_DESCRIPTION = `Performs exact string replacements in files.

CRITICAL: \`old_string\` must match the file content EXACTLY, including all whitespace, indentation, and line endings. If the match fails, re-read the file to get the exact content before retrying.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.

To be resilient to minor formatting drift, the tool normalizes line endings (CRLF/LF) for matching and may fall back to deterministic matching strategies when an exact literal match fails (exact → whitespace-tolerant match → token-based match). The original file's line endings are preserved when writing.

FILE CREATION:
- To create a new file, set \`old_string\` to an empty string \`""\` and \`new_string\` to the full file content.
- The target file must NOT already exist.

MULTIPLE REPLACEMENTS:
- Use \`replace_all: true\` to replace ALL occurrences of old_string.
- Use \`expected_replacements\` to specify an exact count when you need to replace a specific number of occurrences.`

const edit = {
	type: "function",
	function: {
		name: "edit",
		description: EDIT_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "The path of the file to edit (relative to the working directory)",
				},
				old_string: {
					type: "string",
					description:
						"The exact text to find in the file. Must match exactly, including all whitespace, indentation, and line endings. Use empty string to create a new file.",
				},
				new_string: {
					type: "string",
					description:
						"The replacement text that will replace old_string. Must include all necessary whitespace and indentation.",
				},
				replace_all: {
					type: "boolean",
					description:
						"When true, replaces ALL occurrences of old_string in the file. When false (default), only replaces the first occurrence and errors if multiple matches exist.",
					default: false,
				},
				expected_replacements: {
					type: "number",
					description:
						"Number of replacements expected. Use when you want to replace a specific number of occurrences. Mutually exclusive with replace_all.",
					minimum: 1,
				},
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export default edit
