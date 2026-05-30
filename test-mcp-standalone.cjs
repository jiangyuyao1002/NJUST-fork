/**
 * MCP Tools Server 独立测试（不依赖 VS Code Extension Host）
 *
 * 用法: node test-mcp-standalone.cjs
 *
 * 此脚本在本进程内启动一个简化版 MCP Server，然后用 HTTP 请求验证全部协议流程。
 */

const http = require("http")
const { randomUUID } = require("crypto")
const path = require("path")
const fs = require("fs/promises")
const { exec } = require("child_process")

const PORT = 3200
const BASE_URL = `http://127.0.0.1:${PORT}/mcp`
const WORKSPACE = __dirname

let sessionId = null
let nextId = 1

// ─── Minimal JSON-RPC / MCP Server (no SDK, pure Node.js) ──────────────

const tools = [
	{
		name: "read_file",
		description: "Read file contents",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relative path to file" },
				start_line: { type: "number", description: "Start line (1-based)" },
				end_line: { type: "number", description: "End line (1-based)" },
			},
			required: ["path"],
		},
	},
	{
		name: "list_files",
		description: "List files in directory",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relative directory path" },
			},
			required: ["path"],
		},
	},
	{
		name: "write_to_file",
		description: "Write content to file",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Relative file path" },
				content: { type: "string", description: "File content" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "execute_command",
		description: "Execute a shell command",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command" },
			},
			required: ["command"],
		},
	},
]

async function handleToolCall(name, args) {
	switch (name) {
		case "read_file": {
			const absPath = path.resolve(WORKSPACE, args.path)
			if (!absPath.startsWith(path.resolve(WORKSPACE)))
				return { content: [{ type: "text", text: "Error: path outside workspace" }], isError: true }
			const content = await fs.readFile(absPath, "utf-8")
			const lines = content.split("\n")
			const start = Math.max(1, args.start_line || 1)
			const end = Math.min(lines.length, args.end_line || lines.length)
			const numbered = lines
				.slice(start - 1, end)
				.map((l, i) => `${start + i} | ${l}`)
				.join("\n")
			return { content: [{ type: "text", text: numbered }] }
		}
		case "list_files": {
			const absPath = path.resolve(WORKSPACE, args.path)
			const entries = await fs.readdir(absPath, { withFileTypes: true })
			const list = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n")
			return { content: [{ type: "text", text: list || "(empty)" }] }
		}
		case "write_to_file": {
			const absPath = path.resolve(WORKSPACE, args.path)
			if (!absPath.startsWith(path.resolve(WORKSPACE)))
				return { content: [{ type: "text", text: "Error: path outside workspace" }], isError: true }
			await fs.writeFile(absPath, args.content, "utf-8")
			return { content: [{ type: "text", text: `Written: ${args.path}` }] }
		}
		case "execute_command": {
			return new Promise((resolve) => {
				exec(args.command, { cwd: WORKSPACE, timeout: 10000 }, (err, stdout, stderr) => {
					resolve({
						content: [
							{
								type: "text",
								text: `Exit: ${err ? err.code || "error" : 0}${stdout ? "\nSTDOUT:\n" + stdout : ""}${stderr ? "\nSTDERR:\n" + stderr : ""}`,
							},
						],
					})
				})
			})
		}
		default:
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
	}
}

// Minimal MCP-like JSON-RPC handler
const sessions = new Map()

function createSession() {
	const sid = randomUUID()
	sessions.set(sid, { created: Date.now() })
	return sid
}

async function handleJsonRpc(body, reqSessionId) {
	if (!body || !body.method) return null // notification

	const { id, method, params } = body

	switch (method) {
		case "initialize": {
			const sid = createSession()
			return {
				sid,
				response: {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "njust-ai-tools-test", version: "1.0.0" },
					},
				},
			}
		}
		case "notifications/initialized":
			return null
		case "tools/list":
			return { response: { jsonrpc: "2.0", id, result: { tools } } }
		case "tools/call": {
			try {
				const result = await handleToolCall(params.name, params.arguments || {})
				return { response: { jsonrpc: "2.0", id, result } }
			} catch (e) {
				return {
					response: {
						jsonrpc: "2.0",
						id,
						result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
					},
				}
			}
		}
		default:
			return {
				response: {
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `Method not found: ${method}` },
				},
			}
	}
}

function startServer() {
	return new Promise((resolve) => {
		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id")
			res.setHeader("Access-Control-Expose-Headers", "mcp-session-id")

			if (req.method === "OPTIONS") {
				res.writeHead(204)
				res.end()
				return
			}

			if (req.method !== "POST") {
				res.writeHead(405)
				res.end("Method not allowed")
				return
			}

			let data = ""
			req.on("data", (c) => (data += c))
			req.on("end", async () => {
				try {
					const body = JSON.parse(data)
					const reqSid = req.headers["mcp-session-id"]
					const result = await handleJsonRpc(body, reqSid)

					if (!result) {
						res.writeHead(202)
						res.end()
						return
					}

					if (result.sid) {
						res.setHeader("mcp-session-id", result.sid)
					}

					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify(result.response))
				} catch (e) {
					res.writeHead(400, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }))
				}
			})
		})

		server.listen(PORT, "127.0.0.1", () => resolve(server))
	})
}

// ─── Test Client ─────────────────────────────────────────────────────────

async function mcpRequest(method, params = {}) {
	const headers = { "Content-Type": "application/json" }
	if (sessionId) headers["mcp-session-id"] = sessionId

	const res = await fetch(BASE_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	})

	const sid = res.headers.get("mcp-session-id")
	if (sid) sessionId = sid

	return await res.json()
}

function section(title) {
	console.log(`\n${"=".repeat(50)}`)
	console.log(`  ${title}`)
	console.log("=".repeat(50))
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
	console.log("Starting MCP protocol test server...")
	const server = await startServer()
	console.log(`Server running at ${BASE_URL}`)
	console.log(`Workspace: ${WORKSPACE}\n`)

	let passed = 0
	let failed = 0

	function check(name, condition) {
		if (condition) {
			console.log(`  PASS: ${name}`)
			passed++
		} else {
			console.log(`  FAIL: ${name}`)
			failed++
		}
	}

	try {
		// 1. Initialize
		section("1. Initialize session")
		const init = await mcpRequest("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0" },
		})
		check("Got session ID", !!sessionId)
		check("Server name", init?.result?.serverInfo?.name === "njust-ai-tools-test")
		check("Has tools capability", !!init?.result?.capabilities?.tools)
		console.log(`  Session: ${sessionId}`)

		// 2. List tools
		section("2. List tools")
		const toolsRes = await mcpRequest("tools/list")
		const toolNames = toolsRes?.result?.tools?.map((t) => t.name) || []
		check("Has tools", toolNames.length === 4)
		check("Has read_file", toolNames.includes("read_file"))
		check("Has list_files", toolNames.includes("list_files"))
		check("Has write_to_file", toolNames.includes("write_to_file"))
		check("Has execute_command", toolNames.includes("execute_command"))
		console.log(`  Tools: ${toolNames.join(", ")}`)

		// 3. read_file
		section("3. read_file (package.json first 3 lines)")
		const read = await mcpRequest("tools/call", {
			name: "read_file",
			arguments: { path: "src/package.json", start_line: 1, end_line: 3 },
		})
		const readText = read?.result?.content?.[0]?.text || ""
		check("Got content", readText.length > 0)
		check("Has line numbers", readText.includes("1 |"))
		check("Has JSON content", readText.includes("{") || readText.includes("name"))
		console.log(`  Content:\n${readText}`)

		// 4. list_files
		section("4. list_files (root)")
		const list = await mcpRequest("tools/call", {
			name: "list_files",
			arguments: { path: "." },
		})
		const listText = list?.result?.content?.[0]?.text || ""
		check("Got listing", listText.length > 0)
		check("Contains src/", listText.includes("src"))
		console.log(`  Entries (first 5): ${listText.split("\n").slice(0, 5).join(", ")}`)

		// 5. execute_command
		section("5. execute_command (echo test)")
		const cmd = await mcpRequest("tools/call", {
			name: "execute_command",
			arguments: { command: "echo MCP_TEST_OK" },
		})
		const cmdText = cmd?.result?.content?.[0]?.text || ""
		check("Got output", cmdText.includes("MCP_TEST_OK"))
		check("Exit code 0", cmdText.includes("Exit: 0"))
		console.log(`  Output: ${cmdText.trim().split("\n")[0]}`)

		// 6. write + read roundtrip
		section("6. write_to_file + read_file roundtrip")
		const stamp = `mcp-test-${Date.now()}`
		const write = await mcpRequest("tools/call", {
			name: "write_to_file",
			arguments: { path: ".mcp-test-tmp.txt", content: stamp },
		})
		check("Write OK", write?.result?.content?.[0]?.text?.includes("Written"))

		const verify = await mcpRequest("tools/call", {
			name: "read_file",
			arguments: { path: ".mcp-test-tmp.txt" },
		})
		check("Read matches", verify?.result?.content?.[0]?.text?.includes(stamp))

		await fs.unlink(path.join(WORKSPACE, ".mcp-test-tmp.txt")).catch(() => {})

		// 7. Error handling: path outside workspace
		section("7. Error handling: path escape")
		const escape = await mcpRequest("tools/call", {
			name: "read_file",
			arguments: { path: "../../etc/passwd" },
		})
		const escapeText = escape?.result?.content?.[0]?.text || ""
		const isBlocked = escapeText.includes("Error") || escape?.result?.isError
		check("Path escape blocked", isBlocked)

		// Summary
		section("RESULTS")
		console.log(`  Passed: ${passed}`)
		console.log(`  Failed: ${failed}`)
		console.log(`  Total:  ${passed + failed}`)
		console.log(failed === 0 ? "\n  ALL TESTS PASSED!\n" : "\n  SOME TESTS FAILED!\n")
	} finally {
		server.close()
	}

	process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
	console.error("Fatal:", err)
	process.exit(1)
})
