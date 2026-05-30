/**
 * MCP Tools Server 测试脚本
 *
 * 用法:
 *   1. 在 VS Code 设置中启用 mcpServer.enabled = true
 *   2. 重启扩展（或 reload window）
 *   3. 在终端运行: node test-mcp-server.mjs
 *
 * 可选参数:
 *   --port=3100       指定端口（默认 3100）
 *   --token=xxx       如果设置了 authToken
 */

const PORT = getArg("port", "3100")
const TOKEN = getArg("token", "")
const BASE_URL = `http://127.0.0.1:${PORT}/mcp`

function getArg(name, defaultVal) {
	const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
	return arg ? arg.split("=")[1] : defaultVal
}

let sessionId = null
let nextId = 1

async function mcpRequest(method, params = {}) {
	const headers = {
		"Content-Type": "application/json",
		"Accept": "application/json, text/event-stream",
	}
	if (sessionId) headers["mcp-session-id"] = sessionId
	if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`

	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: nextId++,
		method,
		params,
	})

	const res = await fetch(BASE_URL, { method: "POST", headers, body })

	// Capture session ID from response headers
	const sid = res.headers.get("mcp-session-id")
	if (sid) sessionId = sid

	const contentType = res.headers.get("content-type") || ""

	if (contentType.includes("text/event-stream")) {
		// SSE response — read and parse events
		const text = await res.text()
		const events = text
			.split("\n\n")
			.filter((e) => e.trim())
			.map((e) => {
				const dataLine = e.split("\n").find((l) => l.startsWith("data: "))
				if (dataLine) {
					try {
						return JSON.parse(dataLine.slice(6))
					} catch {
						return dataLine.slice(6)
					}
				}
				return null
			})
			.filter(Boolean)

		// Return the last result (typically the actual response)
		return events[events.length - 1] || events
	}

	return await res.json()
}

function printSection(title) {
	console.log(`\n${"=".repeat(60)}`)
	console.log(`  ${title}`)
	console.log("=".repeat(60))
}

function printResult(data) {
	console.log(JSON.stringify(data, null, 2))
}

async function main() {
	console.log(`Testing MCP Tools Server at ${BASE_URL}`)
	console.log(TOKEN ? `Using auth token: ${TOKEN.slice(0, 4)}...` : "No auth token")

	// 1. Initialize
	printSection("1. Initialize")
	const initResult = await mcpRequest("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test-script", version: "1.0.0" },
	})
	printResult(initResult)
	console.log(`\nSession ID: ${sessionId}`)

	if (!sessionId) {
		console.error("ERROR: No session ID received. Is the server running?")
		process.exit(1)
	}

	// Send initialized notification
	await fetch(BASE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"mcp-session-id": sessionId,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	})

	// 2. List tools
	printSection("2. List Tools")
	const toolsResult = await mcpRequest("tools/list")
	if (toolsResult?.result?.tools) {
		console.log(`Found ${toolsResult.result.tools.length} tools:`)
		for (const tool of toolsResult.result.tools) {
			console.log(`  - ${tool.name}: ${tool.description}`)
		}
	} else {
		printResult(toolsResult)
	}

	// 3. Test read_file
	printSection("3. Test read_file (package.json, lines 1-5)")
	const readResult = await mcpRequest("tools/call", {
		name: "read_file",
		arguments: { path: "src/package.json", start_line: 1, end_line: 5 },
	})
	printResult(readResult?.result || readResult)

	// 4. Test list_files
	printSection("4. Test list_files (root directory)")
	const listResult = await mcpRequest("tools/call", {
		name: "list_files",
		arguments: { path: ".", recursive: false },
	})
	printResult(listResult?.result || listResult)

	// 5. Test search_files
	printSection("5. Test search_files (search for 'activate')")
	const searchResult = await mcpRequest("tools/call", {
		name: "search_files",
		arguments: { path: "src", regex: "export async function activate", file_pattern: "*.ts" },
	})
	printResult(searchResult?.result || searchResult)

	// 6. Test execute_command
	printSection("6. Test execute_command (echo hello)")
	const cmdResult = await mcpRequest("tools/call", {
		name: "execute_command",
		arguments: { command: "echo hello from MCP server" },
	})
	printResult(cmdResult?.result || cmdResult)

	// 7. Test write_to_file (create a temp file)
	printSection("7. Test write_to_file (create temp file)")
	const writeResult = await mcpRequest("tools/call", {
		name: "write_to_file",
		arguments: {
			path: ".mcp-test-output.txt",
			content: `MCP Server test at ${new Date().toISOString()}\nThis file can be safely deleted.`,
		},
	})
	printResult(writeResult?.result || writeResult)

	// 8. Read back the temp file to verify
	printSection("8. Verify: read back the temp file")
	const verifyResult = await mcpRequest("tools/call", {
		name: "read_file",
		arguments: { path: ".mcp-test-output.txt" },
	})
	printResult(verifyResult?.result || verifyResult)

	printSection("ALL TESTS COMPLETE")
	console.log("MCP Tools Server is working correctly!\n")
}

main().catch((err) => {
	console.error("Test failed:", err.message)
	if (err.cause?.code === "ECONNREFUSED") {
		console.error("\nMCP Server is not running. Check:")
		console.error('  1. njust-ai.mcpServer.enabled = true in VS Code settings')
		console.error("  2. Reload the VS Code window after enabling")
		console.error(`  3. Port ${PORT} is not occupied by another process`)
	}
	process.exit(1)
})
