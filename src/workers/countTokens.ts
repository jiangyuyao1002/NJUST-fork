import workerpool from "workerpool"

import { Anthropic } from "@anthropic-ai/sdk"

import { tiktoken } from "../utils/tiktoken"

import { type CountTokensResult } from "./types"
import { getErrorMessage } from "../shared/error-utils"

async function countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<CountTokensResult> {
	try {
		const count = await tiktoken(content)
		return { success: true, count }
	} catch (error) {
		return {
			success: false,
			error: getErrorMessage(error),
		}
	}
}

workerpool.worker({ countTokens })
