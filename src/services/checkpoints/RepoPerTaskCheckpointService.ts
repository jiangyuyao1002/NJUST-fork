import * as path from "path"

import { CheckpointServiceOptions } from "./types"
import { ShadowCheckpointService } from "./ShadowCheckpointService"
import { logger } from "../../shared/logger"

export class RepoPerTaskCheckpointService extends ShadowCheckpointService {
	public static create({ taskId, workspaceDir, shadowDir, log = (msg: string) => logger.debug("Checkpoint", msg) }: CheckpointServiceOptions) {
		return new RepoPerTaskCheckpointService(
			taskId,
			path.join(shadowDir, "tasks", taskId, "checkpoints"),
			workspaceDir,
			log,
		)
	}
}
