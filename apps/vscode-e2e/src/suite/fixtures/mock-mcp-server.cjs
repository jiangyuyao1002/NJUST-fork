const fs = require("fs/promises")
const path = require("path")

const workspaceRoot = path.resolve(process.argv[2] || process.cwd())

const tools = [
	{
		name: "read_file",
		description: "Read a UTF-8 file from the test workspace.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write a UTF-8 file in the test workspace.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		name: "list_directory",
		description: "List immediate directory entries in the test workspace.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
		},
	},
	{
		name: "directory_tree",
		description: "Return a shallow directory tree for the test workspace.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
		},
	},
	{
		name: "get_file_info",
		description: "Return file metadata for a workspace file.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "fail_tool",
		description: "Return a controlled MCP error for E2E tests.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
]

const resolveWorkspacePath = (target = ".") => {
	const resolved = path.resolve(workspaceRoot, target)
	const relative = path.relative(workspaceRoot, resolved)
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Path is outside the test workspace")
	}
	return resolved
}

const textResult = (text, isError = false) => ({
	content: [{ type: "text", text }],
	...(isError ? { isError: true } : {}),
})

async function callTool(name, args = {}) {
	if (name === "fail_tool") {
		return textResult("Error: controlled MCP failure from mock server", true)
	}

	if (name === "read_file") {
		const content = await fs.readFile(resolveWorkspacePath(args.path), "utf8")
		return textResult(content)
	}

	if (name === "write_file") {
		const filePath = resolveWorkspacePath(args.path)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, String(args.content ?? ""), "utf8")
		return textResult(`Successfully written ${args.path}`)
	}

	if (name === "list_directory") {
		const dirPath = resolveWorkspacePath(args.path || ".")
		const entries = await fs.readdir(dirPath, { withFileTypes: true })
		return textResult(
			JSON.stringify(
				entries.map((entry) => ({
					name: entry.name,
					type: entry.isDirectory() ? "directory" : "file",
				})),
				null,
				2,
			),
		)
	}

	if (name === "directory_tree") {
		const dirPath = resolveWorkspacePath(args.path || ".")
		const entries = await fs.readdir(dirPath, { withFileTypes: true })
		return textResult(
			JSON.stringify(
				{
					name: path.basename(dirPath),
					type: "directory",
					children: entries.map((entry) => ({
						name: entry.name,
						type: entry.isDirectory() ? "directory" : "file",
					})),
				},
				null,
				2,
			),
		)
	}

	if (name === "get_file_info") {
		const filePath = resolveWorkspacePath(args.path)
		const stat = await fs.stat(filePath)
		return textResult(
			JSON.stringify(
				{
					size: stat.size,
					created: stat.birthtime.toISOString(),
					modified: stat.mtime.toISOString(),
					accessed: stat.atime.toISOString(),
				},
				null,
				2,
			),
		)
	}

	return textResult(`Unknown tool: ${name}`, true)
}

function respond(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function respondError(id, error) {
	process.stdout.write(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
		}) + "\n",
	)
}

async function handleMessage(message) {
	if (!message || typeof message !== "object" || !message.method) return

	if (message.method === "initialize") {
		respond(message.id, {
			protocolVersion: "2025-03-26",
			capabilities: { tools: { listChanged: false }, resources: {} },
			serverInfo: { name: "filesystem", version: "1.0.0" },
		})
		return
	}

	if (message.method === "tools/list") {
		respond(message.id, { tools })
		return
	}

	if (message.method === "resources/list") {
		respond(message.id, { resources: [] })
		return
	}

	if (message.method === "resources/templates/list") {
		respond(message.id, { resourceTemplates: [] })
		return
	}

	if (message.method === "tools/call") {
		try {
			respond(message.id, await callTool(message.params?.name, message.params?.arguments || {}))
		} catch (error) {
			respond(message.id, textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true))
		}
		return
	}

	if (message.id !== undefined) {
		respondError(message.id, `Unsupported method: ${message.method}`)
	}
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
	buffer += chunk
	let newlineIndex = buffer.indexOf("\n")
	while (newlineIndex >= 0) {
		const line = buffer.slice(0, newlineIndex).trim()
		buffer = buffer.slice(newlineIndex + 1)
		if (line) {
			Promise.resolve()
				.then(() => handleMessage(JSON.parse(line)))
				.catch((error) => console.error(error))
		}
		newlineIndex = buffer.indexOf("\n")
	}
})
