import type OpenAI from "openai"

const CONFIG_TOOL_DESCRIPTION = `Read or write VS Code workspace configuration settings under the "Njust-AI" namespace. Use this tool to inspect or modify extension settings at runtime.

Actions:
- "get": Retrieve the value of a specific configuration key.
- "set": Update a configuration key to a new value (requires approval).
- "list": List all configuration keys and their current values.

Parameters:
- action: (required) One of "get", "set", or "list".
- key: (required for "get" and "set") The configuration key name (e.g. "enableAutoSave").
- value: (required for "set") The value to set for the key. Can be string, number, boolean, object, or null.

Example: Get a setting
{ "action": "get", "key": "enableAutoSave", "value": null }

Example: Set a setting
{ "action": "set", "key": "enableAutoSave", "value": true }

Example: List all settings
{ "action": "list", "key": null, "value": null }`

export default {
	type: "function",
	function: {
		name: "config",
		description: CONFIG_TOOL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["get", "set", "list"],
					description: 'The action to perform: "get", "set", or "list".',
				},
				key: {
					type: ["string", "null"],
					description: 'The configuration key name. Required for "get" and "set" actions.',
				},
				value: {
					type: ["string", "number", "boolean", "null"],
					description: 'The value to set. Required for "set" action. Use null for "get" and "list".',
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
