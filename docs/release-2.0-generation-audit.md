# Generation lifecycle audit for 2.0

2026-09-06. Scope: base reply/Fix/Hello/Ping, Coach/Help, both Recap sizes, Review, result rendering, and Compare interaction. This is a source and deterministic-test audit, not proof of the deployed browser/provider behavior. No paid generation, fan send, Hub mutation, commit or deployment was performed by this audit worker.

## Confirmed and fixed

`src/background/operations.ts` checked active operation identity immediately after a stream, then awaited a fresh persona check. Cancellation during that read still allowed `operation:complete` for Reply, Coach and Recap. Recap's queued storage predicate checked persona and newest summary token but not whether the operation was cancelled, so a cancelled full/short recap could replace the existing cache once the writer resumed. Content terminal suppression prevented the simplest visible late-result replay, but background success and durable-cache semantics were incorrect.

Five deterministic regressions reproduced the defect before the fix: three deferred final-persona reads (Reply/Coach/Recap), two deferred cache writes (short/full). The fix rechecks active identity after final persona validation, includes active identity in the recap writer predicate, and rechecks after recap awaits before publishing success. The full cached-recap path also rechecks after async Hub-sync eligibility. Existing recap contents remain intact when cancellation precedes the queued writer's actual write.

Limits: an already-submitted `browser.storage.local.set` cannot be cancelled atomically by this patch. The new predicate prevents a queued write from starting after cancellation and the post-write checks prevent late success; it does not roll back a storage write already in flight. No new deletion/rollback path was added.

Changed implementation: `src/background/operations.ts`. Added cases: `tests/operations-suite.ts` (output-and-coach partition). No client prompt assembly or output rewriting introduced.

## Independent coverage

| Surface | Current code path reviewed | Evidence/result |
|---|---|---|
| Base generation | `operations.ts`, `kernel-feature-gateway.ts`, result builder, universal terminal guards | Kernel requests preserve explicit feature/tone/split/draft values; custom DOM fan name stays UI-only. Empty/exhausted output fails before result/cache. Fix single-reply normalization differs from Hello variant parsing and Reply/Ping split parsing. Existing operation tests pass. |
| Coach identity/history | `content/coach-session.ts`, `content/index.ts` completion dispatch and orchestrator | Per-account+group sessions, LRU 5; wire contains completed exchanges only, capped separately from visible feed; stale completion is filtered by active operation before session commit. Failed attempts retain question but not partial answer. Existing session/orchestration tests pass. |
| Live draft and session reseed | `content/index.ts`, `background/coach-transcript-cache.ts` | Draft read at dispatch and reread on Retry; reset/session ID or transcript epoch forces next-turn reseed. Cache refresh replaces covered mutable tail, drops vanished rows, and reloads on lost continuity. Reservation lasts until operation finally settles, so do not infer a concurrent old/new cache writer from cancellation alone. Tests pass. |
| Auto-recap chain | Coach orchestration and decisions E46/E53 | Closed PROCEED allowlist; ambiguous auth/network/acquisition failures STOP. Never-dispatched question/draft intent retained; successful/failed recap feed separate from canonical Coach history. Existing race/STOP/PROCEED tests pass. |
| Two recap sizes | Summary writer/read branches, `completed-overlay-cache.ts`, E82 | Separate full/short cache and completed-view slots. Short never enqueues full dossier sync. Cached-only miss is an explicit no-saved-recap state, not generation. Active/persona/version fences preserved; cancellation hole fixed as above. |
| Help/Coach | `overlay/overlay-controller.ts`, `analysis-blocks.ts`, E79-E81 | Situation chip dispatches preset; two drafts get positional captions only for that exact shape; normal hints only prefill. Legacy Help result remains readable, rerun uses Coach. Advice and fan drafts remain separate. |
| Review/Recap markdown | `analysis-blocks.ts`, `summary-markdown.ts`, E77-E83 | Structured labels require enough matching sections, otherwise plain fallback. Russian replacement-message marker permits bounded parenthetical location. DOM uses element/text construction; raw stored/copy text preserved. Parser/overlay tests pass. |
| Compare/Split | Existing operations and overlay suites | Compare shares per-tab busy gate; result-card parts preserve requested split presentation. Existing lifecycle/compare coverage passes. This pass did not change Compare implementation. |

No additional confirmed defect was found in the reviewed Coach/session/parser paths. This is bounded coverage, not an exhaustive security claim. Generated maps were read as navigation only: the relevant background maps are a 2026-07-07 snapshot at `1586f07`, older than Coach and subsequent decisions; findings above use current source.

## Validation

11 suites, 474 tests passed: `operations-output-coach`, `operations-profiling-summary`, `operations`, `coach-session`, `coach-orchestration`, `coach-transcript-cache`, `coach-overlay`, `summary-markdown`, `analysis-blocks`, `completed-overlay-cache`, `overlay-controller`. `pnpm typecheck` passed. Root owns the combined release `pnpm check` and live Firefox acceptance across all concurrent changes.

## Live acceptance cases for the owner session

1. Ask Coach then switch fan during streaming; return to the original fan. No partial draft should commit or appear in wire history; a typed question remains recoverable. Repeat explicit Cancel without sending any generated message.
2. Type draft A, arm attach, replace it with B before dispatch. Debug prompt should show B. Retry after a failure with draft C must use C. Merely checking attach must not send anything.
3. Generate/open full and short Recap separately, then reopen each. Their contents/age/status must remain independent. A short recap must not replace the full dossier. Existing trusted cache can make reopen checks free.
4. Situation chip and typed Coach question: confirm different intent, sensible progress, canonical preset history, and ready-to-insert draft fences. With a nonempty Fansly composer, insertion must require explicit replacement confirmation.
5. Default reply, Split reply, Fix and Hello: default is usable as one message, requested Split displays parts distinctly, Fix remains one message, Hello variants are choices. Review/Recap text should render with headings and quotes while Copy retains the original text.

The asynchronous cancellation defect is best checked by deterministic tests, not repeated paid generations timed to a millisecond window.

## Proposed decision text for root integration

Generation cancellation now fences post-stream finalization as well as streaming. Fresh persona reads and recap persistence may outlive a Cancel/route change; the coordinator rechecks the same active operation after these awaits and before result delivery, and queued full/short recap writes require it in their existing current-result predicate. A cancelled result cannot newly enter the queued cache writer or publish success after those checks. Existing cache modes, newest-writer/persona fences, human-only insertion, and full-only Hub dossier sync remain unchanged. Five deferred-race regression cases cover Reply, Coach, Recap and both storage slots. This does not claim cancellation of a storage write already submitted to the browser.
