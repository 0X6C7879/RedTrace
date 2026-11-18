import type { EngineConfig, Worker } from './types.ts'

// Model failures may outlast a short retry burst; task deadlines still end recovery.
export const recoverableModelFailure = (code?: string) => ['PROCESS_EXIT','UNKNOWN','SERVER','TIMEOUT','TRANSPORT','STREAM_CLOSED','EMPTY_RESPONSE','RATE_LIMIT','AUTH','QUOTA_EXCEEDED','MISSING_CREDENTIAL','INVALID_CREDENTIAL','INVALID_REQUEST','PI_AI_ERROR'].includes(code ?? '')
export const modelRecoveryDelay = (failures: number) => Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, failures - 1)))

/** Keep role, capacity and tools on the same Worker; change only its declared model route. */
export function recoveryWorker(config: EngineConfig, worker: Worker, current: {provider?: string; model?: string}): Worker {
  const routes = Object.entries(config.providers ?? {}).flatMap(([provider, profile]) => profile.models.map(model => ({provider, model:model.id})))
  const index = routes.findIndex(route => route.provider === current.provider && route.model === current.model)
  const next = routes.length ? routes[(index + 1) % routes.length] : undefined
  return next ? {...worker, ...next} : worker
}
