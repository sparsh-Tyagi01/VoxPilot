import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedPlanner } from "../src/sw/hosted-planner.js";
import { validateHostedSettings, type HostedPlannerSettings } from "../src/shared/hosted-planner.js";
import type { SiteDecisionRequest } from "../src/shared/site-task.js";
const config: HostedPlannerSettings = { version: 1, enabled: true, endpoint: "https://planner.test/v1/chat/completions", model: "configured-model" };
const request = (): SiteDecisionRequest => ({ taskId: "task", goal: "Find backpacks", history: [], answers: [], remainingMs: 120_000,
  observation: { documentId: "doc", observationId: "obs", stateKey: "state", url: "https://shop.test/search?session=private-query#private-fragment", title: "Store", capturedAt: 1, truncated: false,
    elements: [{ handle: "e1", tag: "input", inputType: "search", label: "Search products", context: "Search", fingerprint: "private-fingerprint", value: "private-field-value", href: "https://shop.test/?token=private-link" }], forms: [], coverage: { candidates: 1, inspected: 1, limited: false, frames: "top_only" } } });
const answer = { kind: "act", action: { type: "type", handle: "e1", text: "backpacks" }, expected: { kind: "control_state" } };
const response = (content = answer, reason = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(content) } }] }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("sends bounded context to the configured endpoint with no cookies, redirects, private field values or URL secrets", async () => {
  const transport = vi.fn(async () => response());
  const planner = new HostedPlanner(async () => ({ config, apiKey: "session-key" }), transport);
  expect(await planner.decide(request(), () => true)).toEqual(answer);
  const [endpoint, options] = transport.mock.calls[0]! as unknown as [string, RequestInit];
  expect(endpoint).toBe(config.endpoint);
  expect(options).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", headers: { Authorization: "Bearer session-key" } });
  const payload = String(options.body);
  expect(payload).toContain("configured-model"); expect(payload).toContain("json_object"); expect(payload).toContain("UNTRUSTED");
  expect(payload).not.toMatch(/private-field-value|private-fingerprint|private-query|private-fragment|private-link|session-key/);
});
it("does not send any request without enabled configuration", async () => {
  const transport = vi.fn(); const planner = new HostedPlanner(async () => ({ config: { ...config, enabled: false }, apiKey: "" }), transport);
  await expect(planner.decide(request(), () => true)).rejects.toThrow("disabled"); expect(transport).not.toHaveBeenCalled();
});
it("does not start networking if cancellation happens during asynchronous configuration lookup", async () => {
  let resolve!: (value: { config: HostedPlannerSettings; apiKey: string }) => void;
  const transport = vi.fn(); const planner = new HostedPlanner(() => new Promise(done => { resolve = done; }), transport);
  const pending = planner.decide(request(), () => true); const rejected = expect(pending).rejects.toThrow("stopped");
  planner.cancel(); resolve({ config, apiKey: "" }); await rejected; expect(transport).not.toHaveBeenCalled();
});
it("aborts in-flight fetch on Stop and rejects late output even if a transport ignores abort", async () => {
  let resolve!: (value: Response) => void;
  const transport = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), transport);
  const pending = planner.decide(request(), () => true); await Promise.resolve();
  const signal = (transport.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  planner.cancel(); expect(signal.aborted).toBe(true); resolve(response());
  await expect(pending).rejects.toThrow("stopped"); expect(transport).toHaveBeenCalledOnce();
});
it("rejects overlapping operations and does not retry an interrupted request", async () => {
  let resolve!: (value: Response) => void;
  const transport = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), transport);
  const first = planner.decide(request(), () => true); await Promise.resolve();
  await expect(planner.decide(request(), () => true)).rejects.toThrow("busy");
  resolve(response()); await first; expect(transport).toHaveBeenCalledOnce();
});
it("releases the request lock on cancellation even if a transport never acknowledges abort", async () => {
  const transport = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(response());
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), transport);
  const pending = planner.decide(request(), () => true); await Promise.resolve();
  const rejected = expect(pending).rejects.toThrow("stopped");
  planner.cancel(); await rejected;
  expect(await planner.decide(request(), () => true)).toEqual(answer);
  expect(transport).toHaveBeenCalledTimes(2);
});
it("bounds the network wait by the remaining task budget", async () => {
  const transport = vi.fn((_url: string | URL | Request, options?: RequestInit) => new Promise<Response>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), transport);
  const pending = planner.decide({ ...request(), remainingMs: 50 }, () => true); const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(51); await rejected; expect(transport).toHaveBeenCalledOnce();
});
it.each([401, 403, 429, 500])("reports HTTP %s without exposing provider response bodies or retrying", async status => {
  const transport = vi.fn(async () => new Response("private provider error and credential", { status }));
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), transport);
  await expect(planner.decide(request(), () => true)).rejects.not.toThrow(/private provider/); expect(transport).toHaveBeenCalledOnce();
});
it.each(["length", "tool_calls", "content_filter"])("rejects incomplete/refused output: %s", async reason => {
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), async () => response(answer, reason));
  await expect(planner.decide(request(), () => true)).rejects.toThrow("complete decision");
});
it("rejects unknown tools and extra fields instead of executing model code", async () => {
  const output = { ...answer, action: { type: "eval", code: "alert(1)" } };
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), async () => response(output as typeof answer));
  await expect(planner.decide(request(), () => true)).rejects.toThrow("invalid site decision");
});
it("bounds streamed response bytes even with no Content-Length", async () => {
  const planner = new HostedPlanner(async () => ({ config, apiKey: "" }), async () => new Response("x".repeat(65_537)));
  await expect(planner.decide(request(), () => true)).rejects.toThrow("size limit");
});
it.each(["http://planner.test/chat", "http://[::1]:8080/v1/chat/completions", "https://user:pass@planner.test/chat", "https://planner.test/chat?key=secret", "https://planner.test/chat#fragment", "javascript:alert(1)"])("rejects unsafe endpoint %s", endpoint => {
  expect(() => validateHostedSettings({ ...config, endpoint })).toThrow();
});
it.each(["http://localhost:8080/v1/chat/completions", "http://127.0.0.1:8080/v1/chat/completions"])("permits an explicitly configured loopback gateway: %s", endpoint => expect(validateHostedSettings({ ...config, endpoint }).endpoint).toBe(endpoint));
