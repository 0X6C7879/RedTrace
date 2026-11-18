import type { Store } from './store.ts'

type BenchmarkMetadata = Readonly<{
  flag_count: number | null
  correct_flag_count: number | null
  is_completed: boolean | null
  difficulty: string | null
  total_score: number | null
}>

export function benchmarkMetadata(source: Record<string, unknown>): BenchmarkMetadata {
  const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
  return {
    flag_count: count(source.flag_count),
    correct_flag_count: count(source.correct_flag_count),
    is_completed: typeof source.is_completed === 'boolean' ? source.is_completed : null,
    difficulty: typeof source.difficulty === 'string' && source.difficulty.trim() ? source.difficulty.trim() : null,
    total_score: typeof source.total_score === 'number' && Number.isFinite(source.total_score) ? source.total_score : null,
  }
}

const unknownMetadata = benchmarkMetadata({})

/** Read the last listing observation, not the runtime's completion or classification. */
export function benchmarkPlatformView(store: Store, projectId: string) {
  return Object.fromEntries(store.db.prepare('SELECT task_key,data FROM legion_tasks WHERE project_id=?').all(projectId).map(row => {
    const data = JSON.parse(String(row.data))
    const listed: (BenchmarkMetadata & { title: string }) | undefined = data.platformMetadata
    return [String(row.task_key), {
      ...(listed ?? { ...unknownMetadata, title: null }),
      submitted: !!data.submissionAttemptedAt,
      accepted: data.submissionAccepted === true,
    }] as const
  }))
}
