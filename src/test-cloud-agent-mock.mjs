/**
 * Mock Cloud Agent — 双协议，用于本地联调插件 Cloud Agent 模式。
 *
 * 用法（与插件默认 CloudAgentClient 一致，推荐）：
 *   1. node src/test-cloud-agent-mock.mjs  （或从仓库根目录: node src/test-cloud-agent-mock.mjs）
 *   2. 设置 "njust-ai.cloudAgent.serverUrl": "http://127.0.0.1:4000"
 *   3. F5 调试扩展，选择 Cloud Agent 模式发消息
 *
 * REST（插件实际调用）：
 *   - GET  /health     → 200 JSON { "status": "ok" }
 *   - POST /v1/run     → 请求体 { goal, session_id, workspace_path?, images? }，响应 CloudRunResponse（含示例 workspace_ops）
 *   - POST /v1/run/deferred/start|resume|abort、POST /v1/run/compile → 与扩展 deferred/compile 协议对齐（本 mock 为极简成功响应）
 *     本地写盘默认在开启 njust-ai.cloudAgent.applyRemoteWorkspaceOps 时生效（默认为 true）；见 AGENTS.md
 *
 * MCP Streamable HTTP（可选，其他客户端）：
 *   - POST /mcp        → MCP 会话；submit_task 工具会模拟通知与 cloudagent/executeTool（插件 REST 路径不会走这里）
 */

import http from "http"
import { randomUUID } from "crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const PORT = 4000
/** 与历史默认服务端一致；本地 mock 接受任意非空 Device-Token，不要求匹配此值 */
const MOCK_EXPECTED_API_KEY = process.env.CLOUD_AGENT_MOCK_API_KEY || ""
const transports = new Map()

function log(tag, msg) {
	const ts = new Date().toISOString().slice(11, 23)
	console.log(`[${ts}] [${tag}] ${msg}`)
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

const ToolResultSchema = z.object({
	content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
	isError: z.boolean().optional(),
})

function createMockServer() {
	const server = new McpServer(
		{ name: "mock-cloud-agent", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	)

	server.tool(
		"submit_task",
		"Submit a coding task. The cloud agent plans and executes it by calling tools on the plugin.",
		{
			sessionId: z.string(),
			message: z.string(),
			workspacePath: z.string().optional(),
		},
		async (params, extra) => {
			log("TASK", `Received task: "${params.message}"`)
			log("TASK", `Session: ${params.sessionId}, Workspace: ${params.workspacePath ?? "N/A"}`)

			// Step 1: Send reasoning notification
			log("SEND", "→ reasoning notification")
			await extra.sendNotification({
				method: "notifications/cloudagent/reasoning",
				params: { content: "让我分析一下这个任务。首先我需要了解项目结构..." },
			})
			await sleep(500)

			// Step 2: Send text notification
			log("SEND", "→ text notification")
			await extra.sendNotification({
				method: "notifications/cloudagent/text",
				params: { content: "好的，我来帮你完成这个任务。让我先看看项目结构。" },
			})
			await sleep(300)

			// Step 3: Call list_files on the plugin
			log("SEND", "→ request: cloudagent/executeTool (list_files)")
			let result
			try {
				result = await extra.sendRequest(
					{
						method: "cloudagent/executeTool",
						params: { name: "list_files", arguments: { path: ".", recursive: false } },
					},
					ToolResultSchema,
				)
				const text = result?.content?.[0]?.text ?? "(empty)"
				log("RECV", `← list_files result (${text.length} chars): ${text.slice(0, 200)}...`)
			} catch (e) {
				log("RECV", `← list_files error: ${e.message}`)
			}
			await sleep(300)

			// Step 4: Send more reasoning
			await extra.sendNotification({
				method: "notifications/cloudagent/reasoning",
				params: { content: "项目结构已了解。现在让我读取 package.json 看看项目配置..." },
			})
			await sleep(300)

			// Step 5: Call read_file on the plugin
			log("SEND", "→ request: cloudagent/executeTool (read_file)")
			try {
				result = await extra.sendRequest(
					{
						method: "cloudagent/executeTool",
						params: { name: "read_file", arguments: { path: "package.json", start_line: 1, end_line: 5 } },
					},
					ToolResultSchema,
				)
				const text = result?.content?.[0]?.text ?? "(empty)"
				log("RECV", `← read_file result: ${text.slice(0, 200)}`)
			} catch (e) {
				log("RECV", `← read_file error: ${e.message}`)
			}
			await sleep(300)

			// Step 6: Send text update
			await extra.sendNotification({
				method: "notifications/cloudagent/text",
				params: { content: "了解了项目配置。现在我来创建一个测试文件。" },
			})
			await sleep(300)

			// Step 7: Call write_to_file on the plugin
			log("SEND", "→ request: cloudagent/executeTool (write_to_file)")
			try {
				result = await extra.sendRequest(
					{
						method: "cloudagent/executeTool",
						params: {
							name: "write_to_file",
							arguments: {
								path: ".cloud-agent-test.md",
								content: "# Cloud Agent Test\n\nThis file was created by the mock cloud agent.\n\nTimestamp: " + new Date().toISOString() + "\n",
							},
						},
					},
					ToolResultSchema,
				)
				const text = result?.content?.[0]?.text ?? "(empty)"
				log("RECV", `← write_to_file result: ${text}`)
			} catch (e) {
				log("RECV", `← write_to_file error: ${e.message}`)
			}
			await sleep(300)

			// Step 8: Call execute_command on the plugin
			log("SEND", "→ request: cloudagent/executeTool (execute_command)")
			try {
				result = await extra.sendRequest(
					{
						method: "cloudagent/executeTool",
						params: {
							name: "execute_command",
							arguments: { command: "echo Cloud Agent says hello!", timeout: 5 },
						},
					},
					ToolResultSchema,
				)
				const text = result?.content?.[0]?.text ?? "(empty)"
				log("RECV", `← execute_command result: ${text.slice(0, 200)}`)
			} catch (e) {
				log("RECV", `← execute_command error: ${e.message}`)
			}
			await sleep(300)

			// Step 9: Send done notification
			log("SEND", "→ done notification")
			await extra.sendNotification({
				method: "notifications/cloudagent/done",
				params: { summary: "任务完成！我已经：\n1. 查看了项目结构\n2. 读取了 package.json\n3. 创建了测试文件 .cloud-agent-test.md\n4. 执行了 echo 命令" },
			})

			log("TASK", "Task completed successfully")
			return {
				content: [{ type: "text", text: "Mock cloud agent task completed successfully." }],
			}
		},
	)

	server.tool(
		"compile",
		"Run compilation on the server side",
		{
			sessionId: z.string(),
			workspacePath: z.string().optional(),
		},
		async (params) => {
			log("COMPILE", `Compile request for session: ${params.sessionId}`)
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						success: true,
						output: "Mock compilation successful.",
					}),
				}],
			}
		},
	)

	return server
}

function handleHealth(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify({ status: "ok" }))
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function checkRestAuth(req, res) {
	const apiKey = req.headers["x-api-key"]
	if (MOCK_EXPECTED_API_KEY && apiKey && apiKey !== MOCK_EXPECTED_API_KEY) {
		res.writeHead(401, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid X-API-Key" }))
		return false
	}
	const deviceToken = req.headers["x-device-token"]
	if (!deviceToken || String(deviceToken).trim() === "") {
		res.writeHead(401, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Missing X-Device-Token" }))
		return false
	}
	return true
}

async function handleV1Run(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}

	if (!checkRestAuth(req, res)) {
		return
	}

	let body
	try {
		body = await parseBody(req)
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid JSON body" }))
		return
	}

	const goal = body?.goal ?? ""
	const sessionId = body?.session_id ?? ""
	const workspacePath = body?.workspace_path
	const images = body?.images
	log("REST", `POST /v1/run session=${sessionId} workspace=${workspacePath ?? "N/A"} goal=${String(goal).slice(0, 80)}…`)
	if (Array.isArray(images) && images.length > 0) {
		log("REST", `  (includes ${images.length} image attachment(s), echoed in logs only)`)
	}

	const logs = [
		`[mock-cloud-agent] Received task for session ${sessionId}.`,
		`[mock-cloud-agent] Workspace: ${workspacePath ?? "(none)"}`,
		`[mock-cloud-agent] Simulated planning step…`,
		`[mock-cloud-agent] Goal: ${goal}`,
	]
	const memory_summary =
		"Mock task finished. In production, logs and summary come from the cloud service. " +
		"(MCP tool callbacks are not used by the extension REST client.)"

	// Optional structured ops for extension when njust-ai.cloudAgent.applyRemoteWorkspaceOps is true.
	const workspace_ops = {
		version: 1,
		operations: [
			{
				op: "write_file",
				path: ".cloud-agent-test.md",
				content: `# Cloud Agent mock\n\nWritten via workspace_ops (goal: ${String(goal).slice(0, 200)})\n`,
			},
		],
	}

	const payload = {
		ok: true,
		user_goal: goal,
		memory_summary,
		logs,
		tokens_in: 10,
		tokens_out: 20,
		cost: 0,
		workspace_ops,
	}

	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify(payload))
}

async function handleDeferredAbort(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}
	if (!checkRestAuth(req, res)) {
		return
	}
	let body
	try {
		body = await parseBody(req)
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid JSON body" }))
		return
	}
	log("REST", `POST /v1/run/deferred/abort session=${body?.session_id ?? ""} run_id=${body?.run_id ?? "(none)"}`)
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify({ ok: true, aborted: true }))
}

async function handleDeferredStart(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}
	if (!checkRestAuth(req, res)) {
		return
	}
	let body
	try {
		body = await parseBody(req)
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid JSON body" }))
		return
	}
	const goal = body?.goal ?? ""
	const sessionId = body?.session_id ?? ""
	log("REST", `POST /v1/run/deferred/start session=${sessionId} goal=${String(goal).slice(0, 80)}…`)
	const runId = randomUUID()
	const payload = {
		run_id: runId,
		status: "done",
		deferred_protocol_version: 1,
		server_revision: "mock-v1",
		ok: true,
		text: "Mock deferred/start completed immediately (no pending tools).",
		tokens_in: 1,
		tokens_out: 2,
		cost: 0,
	}
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify(payload))
}

async function handleDeferredResume(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}
	if (!checkRestAuth(req, res)) {
		return
	}
	let body
	try {
		body = await parseBody(req)
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid JSON body" }))
		return
	}
	const runId = body?.run_id ?? randomUUID()
	const sessionId = body?.session_id ?? ""
	log("REST", `POST /v1/run/deferred/resume session=${sessionId} run_id=${runId}`)
	const payload = {
		run_id: runId,
		status: "done",
		deferred_protocol_version: 1,
		server_revision: "mock-v1",
		ok: true,
		text: "Mock deferred/resume completed immediately.",
		tokens_in: 0,
		tokens_out: 0,
		cost: 0,
	}
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify(payload))
}

async function handleV1RunCompile(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Method not allowed" }))
		return
	}
	if (!checkRestAuth(req, res)) {
		return
	}
	let body
	try {
		body = await parseBody(req)
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Invalid JSON body" }))
		return
	}
	log("REST", `POST /v1/run/compile session=${body?.session_id ?? ""}`)
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(JSON.stringify({ success: true, output: "" }))
}

const httpServer = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	res.setHeader(
		"Access-Control-Allow-Headers",
		"Content-Type, mcp-session-id, Authorization, X-API-Key, X-Device-Token",
	)
	res.setHeader("Access-Control-Expose-Headers", "mcp-session-id")

	if (req.method === "OPTIONS") {
		res.writeHead(204)
		res.end()
		return
	}

	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)

	if (url.pathname === "/health") {
		handleHealth(req, res)
		return
	}

	if (url.pathname === "/v1/run") {
		await handleV1Run(req, res)
		return
	}

	if (url.pathname === "/v1/run/deferred/abort") {
		await handleDeferredAbort(req, res)
		return
	}

	if (url.pathname === "/v1/run/deferred/start") {
		await handleDeferredStart(req, res)
		return
	}

	if (url.pathname === "/v1/run/deferred/resume") {
		await handleDeferredResume(req, res)
		return
	}

	if (url.pathname === "/v1/run/compile") {
		await handleV1RunCompile(req, res)
		return
	}

	if (url.pathname !== "/mcp") {
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(
			JSON.stringify({
				error: "Not found. Use /health, /v1/run, /v1/run/deferred/*, /v1/run/compile, or /mcp",
			}),
		)
		return
	}

	try {
		if (req.method === "POST") {
			const body = await parseBody(req)
			const sessionId = req.headers["mcp-session-id"]

			if (sessionId && transports.has(sessionId)) {
				const transport = transports.get(sessionId)
				await transport.handleRequest(req, res, body)
				return
			}

			if (!sessionId && isInitializeRequest(body)) {
				log("SESSION", "New session initializing...")
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (sid) => {
						transports.set(sid, transport)
						log("SESSION", `Session created: ${sid}`)
					},
				})

				transport.onclose = () => {
					const sid = transport.sessionId
					if (sid) {
						transports.delete(sid)
						log("SESSION", `Session closed: ${sid}`)
					}
				}

				const mcpServer = createMockServer()
				await mcpServer.connect(transport)
				await transport.handleRequest(req, res, body)
				return
			}

			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Bad request: missing session or not initialize" }))
		} else if (req.method === "GET" || req.method === "DELETE") {
			const sessionId = req.headers["mcp-session-id"]
			if (sessionId && transports.has(sessionId)) {
				const transport = transports.get(sessionId)
				await transport.handleRequest(req, res)
			} else {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Invalid session" }))
			}
		} else {
			res.writeHead(405).end()
		}
	} catch (error) {
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: String(error) }))
		}
	}
})

function parseBody(req) {
	return new Promise((resolve, reject) => {
		let data = ""
		req.on("data", (chunk) => (data += chunk))
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : undefined)
			} catch {
				reject(new Error("Invalid JSON"))
			}
		})
		req.on("error", reject)
	})
}

httpServer.listen(PORT, "127.0.0.1", () => {
	console.log("")
	console.log("=".repeat(60))
	console.log("  Mock Cloud Agent (REST + MCP)")
	console.log("=".repeat(60))
	console.log(`  REST:  GET http://127.0.0.1:${PORT}/health`)
	console.log(`         POST http://127.0.0.1:${PORT}/v1/run`)
	console.log(`         POST http://127.0.0.1:${PORT}/v1/run/deferred/start|resume|abort`)
	console.log(`         POST http://127.0.0.1:${PORT}/v1/run/compile`)
	console.log(`  MCP:   POST http://127.0.0.1:${PORT}/mcp`)
	console.log("")
	console.log(`  Set njust-ai.cloudAgent.serverUrl to http://127.0.0.1:${PORT}`)
	console.log("=".repeat(60))
	console.log("")
})
