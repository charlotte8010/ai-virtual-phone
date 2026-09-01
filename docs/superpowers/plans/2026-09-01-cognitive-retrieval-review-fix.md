# Cognitive Retrieval Review Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Cognitive Retrieval v1 so an empty prompt context still recalls Future Intent and recent memories, while preserving protected-first cluster selection.

**Architecture:** Keep `memory-service.ts` as the orchestration boundary and change only the hybrid retrieval short-circuit: an empty context skips keyword/vector channels but continues Future Intent, recent fallback, ranking, and selection. Extend the existing lightweight script tests with one service-level regression harness and one ranking cross-regression.

**Tech Stack:** TypeScript source, Node.js `.mjs` test scripts, TypeScript `transpileModule`, Node `vm.SourceTextModule` for isolated service dependency boundaries.

**Spec:** User-provided Commit 4 review-fix handoff in `C:\Users\chennuo06\.codex\attachments\232ad255-f740-4598-b90e-7326dfc26204\pasted-text.txt`

## Global Constraints

- Work only on `feature/cognitive-memory`; do not modify or push `feature/sully-migration`.
- Preserve the four candidate channels: vector, keyword, Future Intent, and recent fallback.
- Empty `currentContext` skips vector and keyword generation but still runs Future Intent, recent fallback, ranking, and selection.
- Do not call the embedding API with an empty query.
- Preserve protected Future Intent types as `plan` and `promise`; do not add `goal`, `wish`, or `expectation`.
- Preserve protected-first selection, `maxProtectedFutureIntents`, and ordinary cluster `maxPerCluster` behavior.
- Do not implement access-count/stability writeback, memory graph work, or Sully Migration M2.
- Acceptance commands are `npm test`, the existing TypeScript/typecheck command, and `npm run build`.

---

### Task 1: Empty-context retrieval regression

**Files:**
- Create: `scripts/test-memory-retrieval.mjs`
- Modify: `package.json`
- Modify: `lib/memory-service.ts`

**Interfaces:**
- Consumes: `selectMemoriesForPrompt(characterId, currentContext, options)` and its `MemorySelectionResult.debug` channel counts.
- Produces: an npm test entry that executes the real transpiled `lib/memory-service.ts` with isolated storage/settings/embedding boundary stubs.

- [ ] **Step 1: Write the failing test**

Create a Node script that loads the real service and pure ranking/search dependencies with `vm.SourceTextModule`. Stub only `loadMemoryEntriesByType`, `resolveAuxiliaryApiConfig`, `resolveEmbeddingModel`, `generateEmbedding`, and `cosineSimilarity`. Supply a due-today Future Intent, an overdue Future Intent, and a recent ordinary memory; call:

```js
const result = await service.selectMemoriesForPrompt("char-1", "", {
  config,
  now: new Date("2026-09-01T12:00:00.000Z"),
  timezone: "Asia/Shanghai",
  maxSelected: 10,
});

assert.ok(result.selected.some(entry => entry.id === "due-today"));
assert.ok(result.selected.some(entry => entry.id === "recent"));
assert.equal(result.debug.channelCounts.vector, 0);
assert.equal(result.debug.channelCounts.keyword, 0);
assert.ok(result.debug.channelCounts.future_intent > 0);
assert.ok(result.debug.channelCounts.recent > 0);
assert.deepEqual(embeddingQueries, []);
```

Add `test:memory-retrieval` before `test:memory-ranking` in `npm test`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:memory-retrieval`

Expected: FAIL because the current `memories.length === 0 || !currentContext.trim()` guard returns an empty result before Future Intent/recent candidate generation.

- [ ] **Step 3: Write the minimal implementation**

Change the hybrid guard in `lib/memory-service.ts` to return early only when `memories.length === 0`. Wrap the existing keyword search and vector embedding block in `if (currentContext.trim()) { ... }`, leaving Future Intent, recent fallback, ranking, and selection outside that conditional.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run test:memory-retrieval`

Expected: PASS; selected results include Future Intent and recent memory, vector/keyword channel counts are zero, and the embedding query list is empty.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test-memory-retrieval.mjs lib/memory-service.ts
git commit -m "fix: preserve fallback memory recall for empty context"
```

### Task 2: Protected-first cluster regression

**Files:**
- Modify: `scripts/test-memory-ranking.mjs`

**Interfaces:**
- Consumes: `rankMemoryCandidates()` and `selectRankedMemoryCandidates()`.
- Produces: a regression proving protected Future Intent is attempted before ordinary candidates in the same cluster, while cluster and protected-count caps remain active.

- [ ] **Step 1: Write the failing test**

Add ordinary candidates `ordinary-a` and `ordinary-b` plus a due-today `protected-c` candidate, all with the same `sourceEventSignatures` cluster. Give ordinary candidates higher importance so ranking order alone would place them first. Select with `maxSelected: 3`, `maxProtectedFutureIntents: 1`, and `maxPerCluster: 2`, then assert:

```js
assert.equal(selected[0].memory.id, "protected-c");
assert.equal(selected.filter(item => item.protectedReason).length, 1);
assert.equal(selected.filter(item => item.clusterKey === selected[0].clusterKey).length, 2);
assert.equal(selected.filter(item => item.memory.id.startsWith("ordinary-")).length, 1);
```

The pre-existing implementation should pass this test; retain it as a cross-regression proving the intended algorithm rather than changing the algorithm.

- [ ] **Step 2: Run the ranking test**

Run: `npm run test:memory-ranking`

Expected: PASS with the new protected-first assertions.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-memory-ranking.mjs
git commit -m "test: cover protected intent cluster priority"
```

### Task 3: Full verification and delivery

**Files:**
- Inspect only: all files changed by Tasks 1-2 and generated build/typecheck output.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all memory compatibility, extraction, Future Intent, retrieval, ranking, and migration foundation scripts pass.

- [ ] **Step 2: Run TypeScript/typecheck**

Run: `npx tsc --noEmit`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: exit code 0. If it fails, determine whether the failure is caused by these changes before making any further edit.

- [ ] **Step 4: Inspect final scope and commit status**

Run: `git status --short --branch`, `git diff 8313faa510a104323a2ae77d54e9e6f653d11599 --stat`, and `git log --oneline --decorate -4`.

Expected: only the plan, service fix, package test entry, and focused regression script changes are present; no Sully Migration files or unrelated refactors are included.

- [ ] **Step 5: Commit any final test-only adjustment if needed**

Use a focused commit message and rerun the covering command before reporting completion.
