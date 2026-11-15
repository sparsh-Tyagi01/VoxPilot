import { describe, it, expect } from "vitest";
import { PerformanceMetrics } from "../src/diagnostics/metrics.js";
describe("content-free performance diagnostics", () => {
  it("bounds history, rejects invalid values, and calculates nearest-rank percentiles", () => {
    const metrics = new PerformanceMetrics();
    for (let i = 1; i <= 300; i++) metrics.add({ stage: "recognition", durationMs: i, success: true });
    metrics.add({ stage: "recognition", durationMs: NaN, success: true });
    const snapshot = metrics.snapshot();
    expect(snapshot.samples).toHaveLength(200);
    expect(snapshot.summary[0]).toMatchObject({ count: 200, p50: 200, p95: 290 });
  });
  it("never exports extra content fields and separates failures from successful timings", () => {
    const metrics = new PerformanceMetrics();
    metrics.add({ stage: "recognition", durationMs: 10, success: false, transcript: "secret" } as never);
    expect(JSON.stringify(metrics.snapshot())).not.toContain("secret");
    expect(metrics.snapshot().summary[0]).toMatchObject({ failures: 1, p50: null });
  });
});
