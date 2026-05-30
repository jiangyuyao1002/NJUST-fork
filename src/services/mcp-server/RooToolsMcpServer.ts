import * as http from "http"
import crypto, { randomUUID } from "crypto"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import {
	execReadFile,
	execWriteFile,
	execListFiles,
	execSearchFiles,
	execCommand,
	execApplyDiff,
} from "./tool-executors"
import { getErrorMessage } from "../../shared/error-utils"

// ── Token-bucket rate limiter (no external deps) ──────────────────────────

class RateLimiter {
	private tokens: number
	private lastRefill: number

	constructor(
		private maxTokens: number,
		private refillRate: number,
	) {
		this.tokens = maxTokens
		this.lastRefill = Date.now()
	}

	tryConsume(): boolean {
		const now = Date.now()
		const elapsed = (now - this.lastRefill) / 1000
		this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
		this.lastRefill = now
		if (this.tokens >= 1) {
			this.tokens--
			return true
		}
		return false
	}
}

interface RooToolsMcpServerOptions {
	workspacePath: string
	port: number
	bindAddress: string
	authToken?: string
	allowedCommands?: string[]
	deniedCommands?: string[]
}

export class RooToolsMcpServer {
	private httpServer: http.Server | null = null
	private transports = new Map<string, StreamableHTTPServerTransport>()
	private options: RooToolsMcpServerOptions
	// Global rate limiter: 60 requests burst, refills at 10/s
	private readonly globalLimiter = new RateLimiter(60, 10)

	constructor(options: RooToolsMcpServerOptions) {
		this.options = options
	}

	updateWorkspacePath(newPath: string): void {
		this.options.workspacePath = newPath
	}

	private get cwd(): string {
		return this.options.workspacePath
	}

	private createMcpServer(): McpServer {
		const server = new McpServer(
			{ name: "njust-ai-tools", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		)

		server.tool(
			"read_file",
			"Read the contents of a file within the workspace. Returns numbered lines.",
			{
				path: z.string().describe("Relative path to the file within the workspace"),
				start_line: z.number().optional().describe("Starting line number (1-based)"),
				end_line: z.number().optional().describe("Ending line number (1-based, inclusive)"),
			},
			async (params) => {
				try {
					const result = await execReadFile(this.cwd, params)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		server.tool(
			"write_to_file",
			"Write content to a file within the workspace. Creates parent directories if needed.",
			{
				path: z.string().describe("Relative path to the file within the workspace"),
				content: z.string().describe("The full content to write to the file"),
			},
			async (params) => {
				try {
					const result = await execWriteFile(this.cwd, params)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		server.tool(
			"list_files",
			"List files and directories within a directory in the workspace.",
			{
				path: z.string().describe("Relative path to the directory within the workspace"),
				recursive: z.boolean().optional().describe("Whether to list files recursively (default: false)"),
			},
			async (params) => {
				try {
					const result = await execListFiles(this.cwd, params)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		server.tool(
			"search_files",
			"Search for a regex pattern across files in a directory within the workspace.",
			{
				path: z.string().describe("Relative path to the directory to search in"),
				regex: z.string().describe("Regular expression pattern to search for (Rust regex syntax)"),
				file_pattern: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
			},
			async (params) => {
				try {
					const result = await execSearchFiles(this.cwd, params)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		server.tool(
			"execute_command",
			"Execute a shell command in the workspace.",
			{
				command: z.string().describe("The shell command to execute"),
				cwd: z.string().optional().describe("Working directory for the command (relative to workspace)"),
				timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
			},
			async (params) => {
				try {
					const result = await execCommand(
						this.cwd,
						params,
						this.options.allowedCommands,
						this.options.deniedCommands,
					)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		server.tool(
			"apply_diff",
			"Apply a search/replace diff to a file. Uses <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format.",
			{
				path: z.string().describe("Relative path to the file to modify"),
				diff: z.string().describe("The diff content using SEARCH/REPLACE block format"),
			},
			async (params) => {
				try {
					const result = await execApplyDiff(this.cwd, params)
					return { content: [{ type: "text" as const, text: result }] }
				} catch (e: unknown) {
					return { content: [{ type: "text" as const, text: `Error: ${getErrorMessage(e)}` }], isError: true }
				}
			},
		)

		return server
	}

	private isLocalOnly(): boolean {
		const addr = this.options.bindAddress
		return addr === "127.0.0.1" || addr === "localhost" || addr === "::1"
	}

	async start(): Promise<void> {
		const { port, bindAddress, authToken } = this.options

		if (!this.isLocalOnly() && !authToken) {
			throw new Error(
				"Security: authToken is required when binding to a non-localhost address. " +
					"Set njust-ai.mcpServer.authToken in your settings before exposing the MCP server to the network.",
			)
		}

		this.httpServer = http.createServer(async (req, res) => {
			const allowedOrigin = this.isLocalOnly() ? "null" : (req.headers.origin ?? "null")
			res.setHeader("Access-Control-Allow-Origin", allowedOrigin)
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Authorization")
			res.setHeader("Access-Control-Expose-Headers", "mcp-session-id")

			if (req.method === "OPTIONS") {
				res.writeHead(204)
				res.end()
				return
			}

			if (authToken && !this.verifyAuth(req, authToken)) {
				res.writeHead(401, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Unauthorized" }))
				return
			}

			if (!this.globalLimiter.tryConsume()) {
				res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" })
				res.end(JSON.stringify({ error: "Rate limit exceeded. Try again later." }))
				return
			}

			const url = new URL(req.url ?? "/", `http://${bindAddress}:${port}`)
			if (url.pathname !== "/mcp") {
				res.writeHead(404, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Not found" }))
				return
			}

			try {
				if (req.method === "POST") {
					await this.handlePost(req, res)
				} else if (req.method === "GET") {
					await this.handleGet(req, res)
				} else if (req.method === "DELETE") {
					await this.handleDelete(req, res)
				} else {
					res.writeHead(405, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "Method not allowed" }))
				}
			} catch (_error: unknown) {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32603, message: "Internal server error" },
							id: null,
						}),
					)
				}
			}
		})

		return new Promise<void>((resolve, reject) => {
			this.httpServer!.listen(port, bindAddress, () => {
				resolve()
			})
			this.httpServer!.on("error", reject)
		})
	}

	async stop(): Promise<void> {
		for (const [_sessionId, transport] of this.transports) {
			try {
				await transport.close()
			} catch {
				// best-effort cleanup
			}
		}
		this.transports.clear()

		if (this.httpServer) {
			return new Promise<void>((resolve) => {
				this.httpServer!.close(() => resolve())
			})
		}
	}

	private verifyAuth(req: http.IncomingMessage, token: string): boolean {
		const authHeader = req.headers["authorization"]
		if (!authHeader) return false
		const expected = `Bearer ${token}`
		if (authHeader.length !== expected.length) return false
		const a = Buffer.from(authHeader)
		const b = Buffer.from(expected)
		return crypto.timingSafeEqual(a, b)
	}

	private async parseBody(req: http.IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB limit
			let data = ""
			let size = 0
			req.on("data", (chunk) => {
				size += chunk.length
				if (size > MAX_BODY_SIZE) {
					req.destroy()
					reject(new Error("Request body too large"))
					return
				}
				data += chunk
			})
			req.on("end", () => {
				try {
					resolve(data ? JSON.parse(data) : undefined)
				} catch {
					reject(new Error("Invalid JSON body"))
				}
			})
			req.on("error", reject)
		})
	}

	private async handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this.parseBody(req)
		const sessionId = req.headers["mcp-session-id"] as string | undefined

		if (sessionId && this.transports.has(sessionId)) {
			const transport = this.transports.get(sessionId)!
			await transport.handleRequest(req, res, body)
			return
		}

		if (!sessionId && isInitializeRequest(body)) {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					this.transports.set(sid, transport)
				},
			})

			transport.onclose = () => {
				const sid = transport.sessionId
				if (sid) {
					this.transports.delete(sid)
				}
			}

			const mcpServer = this.createMcpServer()
			await mcpServer.connect(transport)
			await transport.handleRequest(req, res, body)
			return
		}

		res.writeHead(400, { "Content-Type": "application/json" })
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Bad Request: No valid session ID provided" },
				id: null,
			}),
		)
	}

	private async handleGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const sessionId = req.headers["mcp-session-id"] as string | undefined
		if (!sessionId || !this.transports.has(sessionId)) {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }))
			return
		}

		const transport = this.transports.get(sessionId)!
		await transport.handleRequest(req, res)
	}

	private async handleDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const sessionId = req.headers["mcp-session-id"] as string | undefined
		if (!sessionId || !this.transports.has(sessionId)) {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }))
			return
		}

		const transport = this.transports.get(sessionId)!
		await transport.handleRequest(req, res)
	}
}
