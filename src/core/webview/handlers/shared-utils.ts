import type { MessageHandlerContext } from "./MessageRouter"

export async function resolveIncomingImages(
	context: MessageHandlerContext,
	payload: { text?: string; images?: string[] },
) {
	const { resolveImageMentions } = await import("../../mentions/resolveImageMentions")
	const text = payload.text ?? ""
	const images = payload.images
	const currentTask = context.provider.getCurrentTask()
	const state = await context.provider.getState()
	return resolveImageMentions({
		text,
		images,
		cwd: context.getCurrentCwd(),
		rooIgnoreController: currentTask?.rooIgnoreController,
		maxImageFileSize: state.maxImageFileSize,
		maxTotalImageSize: state.maxTotalImageSize,
	})
}
