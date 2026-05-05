import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

import { type TaskEvent, NJUST_AI_CJEventName } from "@njust-ai-cj/types"

const execFileAsync = promisify(execFile)

import { findRun, findTask, updateTask } from "../db/index"

import { Logger, getTag, isDockerContainer } from "./utils"
import { redisClient, getPubSubKey, registerRunner, deregisterRunner } from "./redis"
import { runUnitTest } from "./runUnitTest"
import { runTaskWithCli } from "./runTaskInCli"
import { runTaskInVscode } from "./runTaskInVscode"

export const processTask = async ({
	taskId,
	jobToken,
	logger,
}: {
	taskId: number
	jobToken: string | null
	logger?: Logger
}) => {
	const task = await findTask(taskId)
	const { language, exercise } = task
	const run = await findRun(task.runId)
	await registerRunner({ runId: run.id, taskId, timeoutSeconds: (run.timeout || 5) * 60 })

	const containerized = isDockerContainer()

	logger =
		logger ||
		new Logger({
			logDir: containerized ? `/var/log/evals/runs/${run.id}` : `/tmp/evals/runs/${run.id}`,
			filename: `${language}-${exercise}.log`,
			tag: getTag("runTask", { run, task }),
		})

	try {
		const publish = async (e: TaskEvent) => {
			const redis = await redisClient()
			await redis.publish(getPubSubKey(run.id), JSON.stringify(e))
		}

		const executionMethod = run.executionMethod || "vscode"
		logger.info(`running task ${task.id} (${language}/${exercise}) via ${executionMethod}...`)

		if (executionMethod === "cli") {
			await runTaskWithCli({ run, task, jobToken, publish, logger })
		} else {
			await runTaskInVscode({ run, task, jobToken, publish, logger })
		}

		logger.info(`testing task ${task.id} (${language}/${exercise})...`)
		const passed = await runUnitTest({ task, logger })

		logger.info(`task ${task.id} (${language}/${exercise}) -> ${passed}`)
		await updateTask(task.id, { passed })

		await publish({
			eventName: passed ? NJUST_AI_CJEventName.EvalPass : NJUST_AI_CJEventName.EvalFail,
			taskId: task.id,
		})
	} finally {
		await deregisterRunner({ runId: run.id, taskId })
	}
}

export const processTaskInContainer = async ({
	taskId,
	jobToken,
	logger,
	maxRetries = 10,
}: {
	taskId: number
	jobToken: string | null
	logger: Logger
	maxRetries?: number
}) => {
	// Write secrets to a temp env-file so they don't appear in `docker inspect`.
	// The file is removed in the finally block below.
	const envFileLines = ["HOST_EXECUTION_METHOD=docker"]

	if (jobToken) {
		envFileLines.push(`NJUST_AI_CJ_CLOUD_TOKEN=${jobToken}`)
	}

	const apiKeyEnvVars = [
		"OPENROUTER_API_KEY",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"DEEPSEEK_API_KEY",
		"MISTRAL_API_KEY",
	]

	for (const envVar of apiKeyEnvVars) {
		if (process.env[envVar]) {
			envFileLines.push(`${envVar}=${process.env[envVar]}`)
		}
	}

	const envFilePath = path.join(os.tmpdir(), `evals-env-${taskId}-${Date.now()}.env`)
	fs.writeFileSync(envFilePath, envFileLines.join("\n") + "\n", { mode: 0o600 })

	const baseArgs = [
		"--rm",
		"--network", "evals_default",
		"-v", "/tmp/evals:/var/log/evals",
		"--env-file", envFilePath,
	]

	const shellCommand = `pnpm --filter @njust-ai-cj/evals cli --taskId ${taskId}`
	logger.info(shellCommand)

	try {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const containerName = `evals-task-${taskId}.${attempt}`
			const args = ["run", "--name", containerName, "-e", `EVALS_ATTEMPT=${attempt}`, ...baseArgs, "evals-runner", "sh", "-c", shellCommand]
			const isRetry = attempt > 0

			if (isRetry) {
				const delayMs = Math.pow(2, attempt - 1) * 1000 * (0.5 + Math.random())
				logger.info(`retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`)
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}

			logger.info(
				`${isRetry ? "retrying" : "executing"} container command (attempt ${attempt + 1}/${maxRetries + 1})`,
			)

			try {
				await execFileAsync("docker", args, { maxBuffer: 50 * 1024 * 1024 })
				logger.info(`container process completed successfully`)
				return
			} catch (error: unknown) {
				const err = error as { code?: number; status?: number }
				const code = err.code ?? err.status
				if (code !== undefined) {
					logger.error(
						`container process failed with exit code: ${code} (attempt ${attempt + 1}/${maxRetries + 1})`,
					)
				} else {
					logger.error(`container process failed with error: ${error} (attempt ${attempt + 1}/${maxRetries + 1})`)
				}

				if (attempt === maxRetries) {
					break
				}
			}
		}

		logger.error(`all ${maxRetries + 1} attempts failed, giving up`)
	} finally {
		try { fs.unlinkSync(envFilePath) } catch { /* cleanup in finally, ignore errors */ }
	}
}
