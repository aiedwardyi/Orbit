/** Durable, non-actionable projection of one routine run.
 *
 * Upserted into the conversation the routine reports to. A local run's turn
 * follows it there; cloud and webhook runs keep an isolated execution task.
 */
export interface RoutineRunCardData {
  runId: string;
  routineId: string;
  routineName: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "missed";
  runOn?: "maus" | "cloud";
  scheduledFor?: number;
  startedAt?: number;
  finishedAt?: number;
  instruction?: string;
  executionThreadId?: string;
  summary?: string;
  error?: string;
}
