# Site-aware agent implementation

Updated 17 November 2026. This records the first working implementation of the [site-aware architecture](SITE_AWARE_AGENT_ARCHITECTURE.md), its verification and its limits.

## Use

1. Run `npm run check`, reload `dist/` at `chrome://extensions`, and refresh target webpages.
2. In Settings → Model choose **Hosted assist** for explicitly enabled external planning without a device GPU, **Assist CPU** for experimental local planning, or a GPU profile. Essential keeps basic CPU voice controls; it does not initialize a general reasoning model. See [CPU implementation and benchmarking](CPU_PLANNER.md).
3. Start listening on a regular HTTP(S) page and describe a goal. Search requests go through the task loop rather than a typing-only shortcut. General tasks use the selected hosted client, local CPU worker or WebLLM worker. The experimental CPU model has not passed task qualification.
4. Answer clarification by voice or in the popup. Review operation details in the popup for actions requiring approval. A spoken “yes” does not approve a sensitive operation.
5. Close the popup to continue background listening. Stop task, voice “stop”, Pause, or Alt+V cancels future dispatches. Page changes already applied can remain.

This does not guarantee that a selected model will correctly interpret every request. A model that cannot initialize or produce a valid decision yields a limitation instead of an invented action.

Hosted assist setup, credentials, sharing boundaries and qualification limits are documented in [the hosted architecture](HOSTED_PLANNER.md).

## Implemented path

```text
Final speech / typed request
  → complete narrow shortcut, or general task
  → selected-tab and origin binding
  → bounded DOM/form/region observation
  → local model proposes one schema-validated decision
  → coordinator checks target, destination and effect policy
  → trusted popup approval when required
  → live fingerprint/document revalidation
  → one packaged action, journaled before dispatch
  → bounded observation and outcome check
  → next decision, clarification, grounded answer or scoped limitation
```

The coordinator owns the task loop. Inference stays in the offscreen document and worker; the popup owns neither. The general runner does not interpret executable model-generated code or probe hidden site APIs.

### Runtime boundaries

- `shared/site-task.ts` and `site-schema.ts` define task/observation/decision contracts, detailed local validation and a compact serialized generation grammar. Coordinator validation runs again after the offscreen response. Validation interprets only the packaged schema subset, with no `eval` or runtime function compilation, so it respects extension CSP.
- `content/site-observation.ts` extracts field/form relationships, selected options, relevant enclosing text, destinations, opaque form-change tokens, coverage and document identity. Model context omits field values and fingerprint comparison data. Form comparison state stays inside a weakly keyed content-script cache and is never sent to inference or diagnostics.
- `content/site-executor.ts` performs one validated interaction. Field entry and explicit form submission are separate. A changed quantity/variant/form payload invalidates an earlier fingerprint; a changed document rejects execution.
- `offscreen/agent/site-planner.ts` uses a dedicated next-decision grammar, ranked/bounded context and remaining-task/token deadlines. The ordinary legacy planner remains available behind an internal migration switch; shipped General mode uses the new runner.
- `sw/site-policy.ts` enforces observed targets, same-origin destinations, secret-field restrictions and approvals independently of the model. Known payment/sending/destructive commitment controls and routes are manual handoffs until qualified. Labels/paths are conservative evidence, not proof that a website is honest.
- `sw/site-task-runner.ts` limits active work, discovery, questions, model calls and actions, validates evidence quotes, rejects typing-only completion, and stops after an unknown mutation outcome.
- The service worker publishes versioned task state to session storage, including pending questions/approval identifiers. The popup restores these when reopened. Restart interrupts an old task and discards its approval; no old side effect is replayed.

### Verification semantics

Field/select/toggle operations check the resulting control state. Search and other page effects require new observed page content or a matching new phrase; completion/answer claims after mutations need exact current evidence quotes. Entering a query is never treated as a completed search. Acknowledgment, page change and completion remain distinct.

These checks establish observed UI evidence, not a formal proof of the user's business outcome or server state. Model interpretation of that evidence remains fallible. Unrelated page changes, misleading labels and poorly structured pages require further adversarial and real-site evaluation before strong completion claims can be qualified. The runner stops on unverified effects rather than blindly retrying them.

User waiting is excluded from the active-work budget. Initial limits are 12 actions, 16 model decisions, three observation expansions, four clarification answers and 120 seconds of active work. Pending answers and approvals expire after three minutes. These are bounds, not measured latency guarantees.

## Verification performed

`npm run check` passed with 247 tests, TypeScript, ESLint, a production build and packaged asset checks. Regression coverage includes search submission, completion evidence, invented tools/targets, private form fields, cart approval identity, cancellation, stale replies, unknown outcomes, selected-site changes, worker restart and the offscreen planning boundary. Existing explicit `any` integration warnings remain. The separate real-model CPU qualification failed all three synthetic task checks; unit tests do not establish model accuracy.

`npm run test:browser` runs an isolated headless Chrome against local controlled fixtures. Node 22+ with global WebSocket is required for this optional runner; set `CHROME_PATH` if Chrome is not found automatically. It uses a temporary profile and removes its temporary build/profile after completion.

The Chrome fixture tests execute the real snapshot builder, policy, task runner and DOM executor for:

- Decision-schema validation under a restrictive CSP that blocks JavaScript evaluation.
- Search field entry, explicit native form submission and asynchronous result observation.
- Variant selection, operation approval and exactly one cart mutation in the controlled fixture.
- Quantity changes rejecting an earlier target fingerprint before dispatch.
- Password values staying out of observations and stale document rejection.
- Popup clarification submission, operation-bound approval and the 340px layout without horizontal overflow.

The fixture decision provider is scripted to test orchestration. This is not a real-model reasoning benchmark, microphone test, universal exactly-once guarantee or Chrome Web Store qualification. No real purchases or external messages are sent by these tests.

## Remaining architecture work

| Area | Current boundary |
|---|---|
| Model qualification | No representative real-model/hardware scorecard or 120-task held-out-site corpus has been completed. Model/task success rates and latency are unclaimed. |
| Browser coverage | General tasks target the top frame and exposed DOM controls. Cross-origin frames, shadow-root traversal, canvas/vision and debugger/native adapters remain unsupported. Coverage reports this limit. |
| Permissions | Task execution is bound to the selected tab and starting origin, but the existing manifest still declares broad host access. Optional per-origin Chrome grant migration remains separate work. |
| Outcome understanding | UI change checks, control-state checks and quoted evidence are implemented. Qualified business-specific verifiers, signed API adapters and backend reconciliation remain future work. |
| High-consequence flows | Recognized payment, sending and destructive commitment controls/routes hand off to the user. This is a conservative heuristic floor, not comprehensive semantic detection of every possible side effect. |
| Recovery and undo | Session interruption is fail-closed. Automatic continuation after restart, transactional undo and encrypted task history are not implemented. |
| Site skills | Existing macros retain their current limited semantics. No automatically learned site workflows or remotely downloaded scripts are added. |
| Deployment | Existing executable WebLLM artifact packaging/licensing and release review requirements remain documented in the general implementation status. |

Broaden support by adding tested observations/tools/verifiers and qualifying the model on held-out sites. Do not replace these boundaries with permissive prompting or an unverified “done” summary.
