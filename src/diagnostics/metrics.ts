export const PERFORMANCE_STAGES = ["recognition", "routing_execution", "snapshot", "planning", "action_execution"] as const;
export type PerformanceStage = typeof PERFORMANCE_STAGES[number];
export interface PerformanceSample { stage: PerformanceStage; durationMs: number; success: boolean; }
/** Bounded, content-free diagnostics. Never stores audio, transcripts, URLs or field values. */
export class PerformanceMetrics {
  private samples: PerformanceSample[] = [];
  add(value: PerformanceSample): void {
    if (!PERFORMANCE_STAGES.includes(value.stage) || !Number.isFinite(value.durationMs) || value.durationMs < 0 || typeof value.success !== "boolean") return;
    this.samples.push({ stage: value.stage, durationMs: Math.round(value.durationMs), success: value.success });
    if (this.samples.length > 200) this.samples.shift();
  }
  snapshot() {
    return { schemaVersion: 1, samples: this.samples.map(sample => ({ ...sample })), summary: PERFORMANCE_STAGES.map(stage => {
      const samples = this.samples.filter(sample => sample.stage === stage);
      const sorted = samples.filter(sample => sample.success).map(sample => sample.durationMs).sort((a, b) => a - b);
      const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
      return { stage, count: samples.length, failures: samples.filter(sample => !sample.success).length, p50: percentile(0.5), p95: percentile(0.95) };
    }) };
  }
}
