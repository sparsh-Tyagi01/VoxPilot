import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), unload: vi.fn(), interrupt: vi.fn(), load: vi.fn() }));
vi.mock("@mlc-ai/web-llm", () => ({
  prebuiltAppConfig: { model_list: [{ model_id: "test" }] },
  CreateMLCEngine: mocks.load,
}));

describe("LLM worker lifecycle", () => {
  let receive: (event: { data: unknown }) => void;
  let post: ReturnType<typeof vi.fn>;
  const send = (data: unknown) => receive({ data });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    post = vi.fn();
    vi.stubGlobal("self", { postMessage: post, addEventListener: (_: string, cb: typeof receive) => { receive = cb; } });
    mocks.load.mockResolvedValue({ chat: { completions: { create: mocks.create } }, unload: mocks.unload, interruptGenerate: mocks.interrupt });
    mocks.unload.mockResolvedValue(undefined);
    mocks.interrupt.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: '{"actions":[]}' }, finish_reason: "stop" }] };
    });
    await import("../src/offscreen/llm/llm-worker.js");
    send({ type: "load", modelId: "test" });
    await settle();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passes an explicit schema string to the native grammar compiler", async () => {
    send({ type: "generate", requestId: "one", messages: [] });
    await settle();
    const options = mocks.create.mock.calls[0]![0];
    expect(options.response_format.type).toBe("json_object");
    expect(JSON.parse(options.response_format.schema).type).toBe("object");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", requestId: "one" }));
    expect(mocks.load.mock.calls[0]![2].context_window_size).toBe(4096);
  });

  it("rejects overlapping engine work and interrupts without returning a partial plan", async () => {
    let release!: (value: unknown) => void;
    mocks.create.mockReturnValue(new Promise(resolve => { release = resolve; }));
    send({ type: "generate", requestId: "one", messages: [] });
    send({ type: "generate", requestId: "two", messages: [] });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", requestId: "two" }));
    send({ type: "abort", requestId: "one" });
    expect(mocks.interrupt).toHaveBeenCalledOnce();
    release((async function* () { yield { choices: [{ delta: { content: "partial" } }] }; })());
    await settle();
    expect(post.mock.calls.some(([msg]) => msg.type === "result")).toBe(false);
  });

  it("disposes a poisoned engine and reloads before the next request", async () => {
    mocks.create.mockRejectedValueOnce(new Error("The current Object has already been disposed"));
    send({ type: "generate", requestId: "one", messages: [] });
    await settle();
    expect(mocks.unload).toHaveBeenCalledOnce();
    send({ type: "generate", requestId: "two", messages: [] });
    await settle();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", requestId: "two" }));
  });

  it("does not return truncated output as a successful plan", async () => {
    mocks.create.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: "{" }, finish_reason: "length" }] };
    });
    send({ type: "generate", requestId: "one", messages: [] });
    await settle();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", requestId: "one", message: expect.stringContaining("output limit") }));
  });
  it("reports mapAsync device loss without waiting for dead GPU cleanup and refuses reuse", async () => {
    mocks.unload.mockReturnValue(new Promise(() => {}));
    mocks.create.mockRejectedValueOnce(new Error("Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost."));
    send({ type: "generate", requestId: "lost", messages: [] });
    await settle();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "GPU_DEVICE_LOST", requestId: "lost" }));
    expect(mocks.unload).not.toHaveBeenCalled();
    send({ type: "generate", requestId: "next", messages: [] });
    await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "GPU_DEVICE_LOST", requestId: "next" }));
  });

});
