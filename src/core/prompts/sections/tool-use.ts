export function getSharedToolUseSection(): string {
	return `====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. You must call at least one tool per assistant response. Prefer calling as many tools as are reasonably needed in a single response to reduce back-and-forth and complete tasks faster.

TOOL CALL FORMAT
- Every tool call must be a valid JSON object with all required parameters.
- Optional parameters can be omitted entirely (do not pass null unless the schema requires it).
- Parameter values must match the declared types: use strings for text, numbers for counts, booleans for flags.
- The \`path\` parameter must be a non-empty string pointing to a real file or directory.
- Do NOT include comments, trailing commas, or markdown formatting inside tool call JSON.

COMMON MISTAKES TO AVOID
- {} (empty object) -> Always include all required parameters
- { "path": "" } -> path must be non-empty
- { "file": "app.ts" } -> Use the correct parameter name (check the tool description; common names: "file_path", "path")
- { "path": 123 } -> path must be a string, not a number
- { "recursive": "yes" } -> Use true/false for boolean parameters
- JSON with // comments -> Pure JSON only

TOOL SELECTION GUIDE
- Read a file -> use read_file (not grep or execute_command)
- Edit an existing file -> use the edit tool (preferred) or the appropriate patching tool available to you
- Create a new file -> use write_to_file
- Search code -> use grep or search_files
- List directory -> use list_files (not execute_command with ls/dir)

Note: The exact set of tools available depends on the current mode. Refer to the tool descriptions provided in each request for the tools you can actually use.`
}
