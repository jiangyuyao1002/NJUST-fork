import type { ExtensionState } from "@njust-ai/types"

/** Same shape as ClineProvider.getState() return type. */
export type TaskHostState = Omit<
	ExtensionState,
	"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
>
