# Future Intent Lifecycle Semantic Review-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lexical Future Intent terminal decisions with a strict Summary API classifier while preserving deterministic overdue maintenance, pending-only creation, atomic replacement writes, provenance, and failure isolation.

**Architecture:** `future-intent-detector.ts` and `memory-summarizer.ts` own creation and always normalize newly created intents to `pending`. `future-intent-lifecycle.ts` owns existing-intent lifecycle: it builds a bounded high-recall candidate list, asks the existing `memorySummaryApiConfigId` classifier for one semantic action, validates the `F`-index result, and applies only validated transitions. Code remains responsible for time rules, terminal guards, normalization, provenance, and atomic persistence.

**Tech Stack:** TypeScript, existing Memory Summary API adapter, IndexedDB memory store, Node ESM regression scripts.

**Spec:** User request for the C6 Future Intent Lifecycle semantic review-fix, received 2026-09-01.

## Global Constraints

- Do not modify `feature/sully-migration`, `main`, C4 retrieval/ranking, C5 recall stats/stability, Core Memory, or Memory Links.
- C2 periodic extraction and C3 immediate extraction may create Future Intent only with `status: pending`.
- C6 classifier may return only `none`, `fulfilled`, `cancelled`, or `replaced`; `overdue` remains deterministic code maintenance.
- The classifier must receive the exact current event and candidates labeled `F0`, `F1`, and so on without real memory IDs.
- Invalid, ambiguous, unavailable, timed-out, or malformed classifier results are safe no-op for semantic transitions; overdue maintenance still runs.
- Replacement uses existing normalization, writes old/new entries atomically, records current event provenance, and is idempotent.
- Do not rewrite Git history or force-push.

---

### Task 1: Lock semantic contracts with failing tests

**Files:**
- Modify: `scripts/test-future-intent-lifecycle.mjs`
- Modify: `scripts/test-future-intent-detector.mjs`
- Modify: `scripts/test-memory-extraction.mjs`

**Interfaces:**
- `buildFutureIntentLifecyclePrompt(event, timeContext, candidates)` emits a no-ID classifier prompt.
- `parseFutureIntentLifecycleModelOutput(text, candidates, timeContext)` returns a validated `F` index decision or `null`.
- `normalizeFutureIntentCreationCandidate(candidate)` strips lifecycle terminal fields and forces `pending` at creation boundaries.

- [x] **Step 1: Add classifier prompt/parser assertions** for no real IDs, exact-event instructions, allowed actions, invalid index, real-ID injection, malformed JSON, duplicate keys, unsupported action, and replacement validation.
- [x] **Step 2: Add semantic lifecycle assertions** for negative event text, explicit classifier-driven completion/cancellation/replacement, multiple-candidate targeting, ambiguous no-op, terminal immutability, and model-failure overdue fallback.
- [x] **Step 3: Add C2/C3 pending-only and high-recall gate assertions** for terminal model status stripping and natural future constructions.
- [x] **Step 4: Run `npm run test:future-intent-lifecycle`, `npm run test:future-intent-detector`, and `npm run test:memory-extraction` and observe the expected failures before implementation.

### Task 2: Implement strict lifecycle classifier and replacement normalization

**Files:**
- Modify: `lib/future-intent-lifecycle.ts`

**Interfaces:**
- Candidate builders expose only `FutureIntentLifecycleCandidate` fields and temporary `F` references.
- Classifier failures return `null` and never invoke lexical terminal fallback.
- Replacement payloads pass the existing `normalizeFutureIntentCandidate` path before persistence.

- [x] **Step 1: Remove regex, lexical overlap, and first-match terminal authority.** Keep `decideFutureIntentTimeTransition` pure and preserve its exact/day/range/timezone rules.
- [x] **Step 2: Add the classifier prompt and strict JSON parser.** Accept only the four actions, valid `F` references, action-specific keys, valid replacement fields, valid dates/timezone, and one unambiguous action.
- [x] **Step 3: Add bounded high-recall candidate generation.** Pass all unresolved candidates below the bound; above it, shortlist only for model context using broad source/session/text/time signals without deciding lifecycle action.
- [x] **Step 4: Inject classifier output into the existing pure decision function.** Allow `pending` and `overdue` terminal transitions only when the classifier targets that entry; keep terminal statuses immutable and apply at most one semantic transition per event.
- [x] **Step 5: Rebuild replacements with current event `sourceApp`, only current event `sourceMessageIds`, normalized resolved timezone, `pending` status, and existing `replacedByMemoryId` semantics.
- [x] **Step 6: Run the focused lifecycle test and TypeScript check until green.**

### Task 3: Enforce creation ownership and high-recall C3 gate

**Files:**
- Modify: `lib/memory-extraction.ts`
- Modify: `lib/memory-summarizer.ts`
- Modify: `lib/memory-types.ts`
- Modify: `lib/future-intent-detector.ts`

**Interfaces:**
- Periodic and immediate creation paths preserve historical read compatibility but normalize newly persisted Future Intent lifecycle fields to pending-only.
- The local C3 gate only decides whether a model request is worthwhile; the C3 model remains the final creation decision.

- [x] **Step 1: Add `normalizeFutureIntentCreationCandidate` and call it at periodic atomic and immediate entry creation boundaries.**
- [x] **Step 2: Update default and appended periodic prompts to forbid `overdue`, `fulfilled`, and `cancelled` during creation.**
- [x] **Step 3: Broaden the C3 gate to recognize natural future constructions while rejecting clear explanatory/question-only text.**
- [x] **Step 4: Run the C2/C3 focused tests and verify no retrieval, recall, migration, or lifecycle ownership changes leaked into those modules.**

### Task 4: Update engineering documentation

**Files:**
- Modify: `docs/float-cognitive-memory-engineering-plan.md`
- Modify: `docs/superpowers/plans/2026-09-01-future-intent-lifecycle.md`

- [x] **Step 1: Add the Semantic Ownership Principle: LLM interprets semantics; code owns state machine, validation, time, and persistence.**
- [x] **Step 2: Document C2/C3 pending-only creation, C6 semantic actions, and deterministic overdue maintenance.**
- [x] **Step 3: Remove outdated regex terminal and first-match guidance, and record the known single-event multi-intent limitation.**
- [x] **Step 4: Keep the milestone name `C6 — Future Intent Lifecycle`; note that it corresponds to old unified roadmap Commit 9 without rewriting history.**

### Task 5: Full verification and focused commit

**Files:**
- Test: `npm test`
- Test: `npx tsc --noEmit`
- Test: `npm run build`

- [x] **Step 1: Run `npm test`.**
- [x] **Step 2: Run `npx tsc --noEmit`.**
- [x] **Step 3: Run `npm run build`.**
- [x] **Step 4: Run `git diff --check`, inspect scope, and confirm migration files are unchanged.**
- [ ] **Step 5: Commit the semantic review-fix as one focused C6 commit.
