/**
 * Shared task-event-bus injection point for the api/ layer.
 *
 * Why a global setter instead of constructor injection:
 *   - BaseProvider and ApiRetryWrapper are constructed by provider
 *     registries / ProviderRegistry.createHandler with their own
 *     signatures; threading a 3rd bus dependency through ~30 call sites
 *     is high-risk for a thin refactor.
 *   - The bus is a process-singleton in practice (one TaskEventBus per
 *     extension host), so a global is faithful to the original behavior.
 *
 * Host code (extension.ts) calls setApiEventBus(taskEventBus) once
 * during activation. api-layer call sites use getApiEventBus() and
 * gracefully no-op when no bus has been injected.
 */
import type { ITaskEventBus } from "@njust-ai/core/events"

let bus: ITaskEventBus | undefined

export function setApiEventBus(next: ITaskEventBus | undefined): void {
	bus = next
}

export function getApiEventBus(): ITaskEventBus | undefined {
	return bus
}
