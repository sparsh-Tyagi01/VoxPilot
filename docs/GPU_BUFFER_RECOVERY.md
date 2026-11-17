# GPU buffer readback recovery

Updated 17 November 2026.

The error `Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved` indicates a cancelled pending buffer map. It does not establish that the GPU device was lost. The [WebGPU specification](https://www.w3.org/TR/webgpu/#dom-gpubuffer-unmap) requires pending map promises to reject when their buffer is unmapped. Cancellation, engine teardown and a driver/device failure can overlap, so a log line alone does not identify which one started the failure.

## Runtime handling

- Device loss and buffer invalidation have separate error codes. Ordinary aborts, invalid map ranges and unrelated errors do not trigger GPU recovery.
- A recognized invalid readback retires the worker immediately. The wrapper does not call another native unload or wait for GPU synchronization on that engine. The owner terminates its worker realm; it cannot serve another request.
- Native readback promises can reject outside the generation promise. A worker `unhandledrejection` listener handles only recognized GPU failures, reports retirement once, and prevents late load readiness, tokens and results. Other unhandled rejections remain visible.
- If the user already stopped that generation, buffer invalidation acknowledges cancellation and worker retirement. It does not automatically reload a model or consume the unexpected-failure recovery allowance. This also covers a rejection arriving after the stream acknowledged cancellation. The next complex request can initialize a fresh worker from cached artifacts.
- Unexpected invalidation uses the existing single smaller-model recovery attempt. A second unexpected GPU failure disables complex planning rather than allocating repeatedly. Neither recovery nor cancellation replays the failed browser action. Basic voice controls remain available.
- A late retirement also fails any newer request already sent to that worker, instead of leaving it waiting until its deadline. Messages from terminated workers remain ignored by the owner.

## Verification

Regression tests inject the reported DOMException into generation, background readback, loading and cancellation. They cover invalid-worker reuse rejection, no duplicate retirement, no second unload, suppression of partial/late output, readiness after a failed load, deferred recovery bounds and cancellation/new-request races.

`npm run check` passed with 210 regression tests, TypeScript, the production build and packaged asset verification (16 existing explicit-`any` lint warnings; no lint errors). Reload the unpacked extension at `chrome://extensions`, then refresh target webpages to use the rebuilt code. The tests simulate GPU failure paths; they do not establish that a particular GPU/driver cannot fail again.

For device qualification, start a complex request, stop it during generation, then start a new request. Also switch profiles during loading and repeat microphone pause/resume. Verify that stopped actions never execute, the mic remains usable, retired workers do not return results, and unexpected failures allow at most one automatic recovery. Actual WebLLM/device validation remains required before a production reliability claim.
