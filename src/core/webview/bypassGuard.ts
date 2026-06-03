import * as vscode from "vscode"

import type { GlobalState } from "@njust-ai/types"

import { computePermissionMode } from "./ClineProviderState"
import { t } from "../../i18n"
import { logger } from "../../shared/logger"

/** bypass 进入确认所需的全部 auto-approval 相关 key */
const BYPASS_KEYS: (keyof GlobalState)[] = [
	"autoApprovalEnabled",
	"alwaysAllowExecute",
	"alwaysAllowWrite",
	"alwaysAllowWriteOutsideWorkspace",
	"alwaysAllowWriteProtected",
	"alwaysAllowReadOnly",
	"alwaysAllowReadOnlyOutsideWorkspace",
	"alwaysAllowMcp",
	"alwaysAllowModeSwitch",
	"alwaysAllowSubtasks",
]

interface BypassGuardDeps {
	getValue: <K extends keyof GlobalState>(key: K) => GlobalState[K] | undefined
	setValue: <K extends keyof GlobalState>(key: K, value: GlobalState[K]) => Promise<void>
}

/**
 * 在设置更新后检查是否进入了 bypass 模式。
 * 如果是从 default → bypass 的转换，弹出确认对话框。
 * 用户取消时自动回退所有 auto-approval 设置。
 *
 * @returns true 如果最终处于 bypass 模式（已确认）或不在 bypass 模式；
 *          false 如果用户取消了切换（设置已回退）
 */
export async function confirmBypassTransition(deps: BypassGuardDeps): Promise<boolean> {
	const state = collectBypassState(deps)
	const newMode = computePermissionMode(state)

	if (newMode !== "bypass") {
		return true // 不在 bypass 模式，无需确认
	}

	// 检查是否是刚进入 bypass（通过检查之前保存的快照）
	// 因为设置已经保存了，我们直接弹确认框让用户确认
	const confirmed = await vscode.window.showWarningMessage(
		t("chat:bypassMode.confirmTitle"),
		{
			modal: true,
			detail: t("chat:bypassMode.confirmDetail"),
		},
		t("chat:bypassMode.confirmAction"),
	)

	if (confirmed) {
		logger.info("BypassGuard", "用户确认进入 bypass 模式")
		return true
	}

	// 用户取消 → 回退所有 bypass 相关设置
	logger.info("BypassGuard", "用户取消 bypass 模式，回退设置")
	await revertBypassSettings(deps)
	return false
}

function collectBypassState(deps: BypassGuardDeps): Parameters<typeof computePermissionMode>[0] {
	return {
		autoApprovalEnabled: deps.getValue("autoApprovalEnabled") as boolean | undefined,
		alwaysAllowExecute: deps.getValue("alwaysAllowExecute") as boolean | undefined,
		alwaysAllowWrite: deps.getValue("alwaysAllowWrite") as boolean | undefined,
		alwaysAllowWriteOutsideWorkspace: deps.getValue("alwaysAllowWriteOutsideWorkspace") as boolean | undefined,
		alwaysAllowWriteProtected: deps.getValue("alwaysAllowWriteProtected") as boolean | undefined,
		alwaysAllowReadOnly: deps.getValue("alwaysAllowReadOnly") as boolean | undefined,
		alwaysAllowReadOnlyOutsideWorkspace: deps.getValue("alwaysAllowReadOnlyOutsideWorkspace") as
			| boolean
			| undefined,
		alwaysAllowMcp: deps.getValue("alwaysAllowMcp") as boolean | undefined,
		alwaysAllowModeSwitch: deps.getValue("alwaysAllowModeSwitch") as boolean | undefined,
		alwaysAllowSubtasks: deps.getValue("alwaysAllowSubtasks") as boolean | undefined,
	}
}

async function revertBypassSettings(deps: BypassGuardDeps): Promise<void> {
	for (const key of BYPASS_KEYS) {
		await deps.setValue(key, false)
	}
}
