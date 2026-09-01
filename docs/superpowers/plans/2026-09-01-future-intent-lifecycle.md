# Future Intent Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conservative, idempotent Future Intent lifecycle that derives overdue from valid time windows, derives fulfilled/cancelled/replacement only from the exact current event, and never lets retrieval, recall, preview, or migration mutate lifecycle state.

**Architecture:** Keep C3 creation in `future-intent-detector.ts`. Add `future-intent-lifecycle.ts` with pure time/evidence decisions and a persistence orchestrator that loads unresolved intents from the existing memory store. Use the existing `replacedByMemoryId` field and `cancelled` terminal status for replacements; persist old and new entries in one IndexedDB transaction. Wire the lifecycle before C3 creation for the exact event path, isolating lifecycle failures so chat and creation continue.

**Tech Stack:** TypeScript, IndexedDB storage, Node ESM regression scripts, existing `FutureIntentEvent` and `MemoryEntry` types.

**Spec:** User request for C6 — Future Intent Lifecycle, received 2026-09-01.

## Global Constraints

- Do not modify `feature/sully-migration`.
- Do not modify C4 retrieval/ranking, C5 recall stats/stability, Core Memory, or Memory Links behavior.
- Lifecycle transitions must use the exact current event or an explicit time-maintenance call; retrieval, recall, debug preview, and migration restore remain side-effect free.
- Keep statuses limited to `pending`, `overdue`, `fulfilled`, and `cancelled`.
- Treat malformed or vague temporal data conservatively as no-op.
- Never reverse terminal lifecycle states automatically.

---

### Task 1: Lifecycle decision contract and failing tests

**Files:**
- Create: `lib/future-intent-lifecycle.ts`
- Create: `scripts/test-future-intent-lifecycle.mjs`
- Modify: `package.json`

**Interfaces:**
- `decideFutureIntentTransition(entry, event, options)` returns a pure transition decision without persistence.
- `evaluateFutureIntentTime(entry, now, timezone)` returns a time-only decision.
- `runFutureIntentLifecycle(characterId, event)` loads and persists lifecycle changes.

- [ ] **Step 1: Write failing pure decision tests**
- [ ] **Step 2: Run `npm run test:future-intent-lifecycle` and confirm missing-module failures**

### Task 2: Pure time and event evidence decisions

**Files:**
- Modify: `lib/future-intent-lifecycle.ts`
- Test: `scripts/test-future-intent-lifecycle.mjs`

**Interfaces:**
- Only `pending` may become `overdue` from time.
- `range` uses `targetEndAt`; `day` uses the supplied IANA timezone calendar boundary; vague/unknown/malformed inputs no-op.
- Completion, cancellation, and reschedule require conservative relation plus explicit lexical evidence from the current event.

- [ ] **Step 1: Implement minimal pure time/evidence functions**
- [ ] **Step 2: Run focused lifecycle tests and confirm all decision cases pass**

### Task 3: Persistence and replacement transaction

**Files:**
- Modify: `lib/memory-storage.ts`
- Modify: `lib/future-intent-lifecycle.ts`
- Test: `scripts/test-future-intent-lifecycle.mjs`

**Interfaces:**
- Add a batch memory write using the existing IndexedDB store.
- Record lifecycle source event provenance in `metadata`.
- Replacement marks the old entry `cancelled` with `replacedByMemoryId`, writes the new entry as `pending`, and is idempotent when repeated.

- [ ] **Step 1: Add failing persistence/failure-isolation tests**
- [ ] **Step 2: Implement batch persistence and isolated warnings**
- [ ] **Step 3: Run focused lifecycle tests**

### Task 4: Exact-event integration and boundary regressions

**Files:**
- Modify: `lib/future-intent-detector.ts`
- Modify: `lib/chat-memory-event.ts`
- Modify: `lib/group-chat-engine.ts`
- Modify: `lib/memory-storage.ts`
- Modify: `package.json`
- Test: `scripts/test-future-intent-lifecycle.mjs`

**Interfaces:**
- The existing event counter queues the exact event into lifecycle maintenance before C3 creation; a lifecycle write failure never blocks creation or the chat path.
- C3 creation remains responsible for new Future Intent detection.
- Imported/migration/debug/preview/retrieval/recall paths do not call lifecycle persistence.

- [ ] **Step 1: Add source-boundary and integration assertions**
- [ ] **Step 2: Implement minimal exact-event wiring**
- [ ] **Step 3: Run lifecycle, existing C3/C4/C5 tests**

### Task 5: Full verification and commit

**Files:**
- Test: all existing test scripts

- [ ] **Step 1: Run `npm test`**
- [ ] **Step 2: Run `npx tsc --noEmit`**
- [ ] **Step 3: Run `npm run build`**
- [ ] **Step 4: Check scope, status, and diff**
- [ ] **Step 5: Commit C6 with one focused commit**
