export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.
4. ALWAYS verify that all required parameters are present before submitting a tool call. Missing required parameters will cause the call to fail.
5. For the edit tool: the old_string must match the file content EXACTLY (including whitespace and indentation). If unsure, read the file first to get the exact content.
6. For patching tools: follow the exact format specified in the tool description (e.g., SEARCH/REPLACE blocks or patch format).
7. For the write_to_file tool: you MUST provide the COMPLETE file content. Partial content or placeholders like "// rest unchanged" will overwrite the file with incomplete data.
8. If a tool call fails, read the error message carefully and fix the specific issue before retrying. Do not repeat the same failing call.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}
