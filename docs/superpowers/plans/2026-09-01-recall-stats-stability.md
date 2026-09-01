# Commit 5: Recall Stats & Stability

## Scope

Implement recall statistics for long-term memories selected for and actually injected into production prompts. Keep Commit 4 retrieval, ranking, selection, migration import, and Future Intent lifecycle behavior unchanged.

## Design

1. Add `lib/memory-recall-stats.ts` with pure, testable functions.
   - Treat missing or invalid `accessCount` as `0`.
   - Increment exactly once per committed recall.
   - Set only `lastAccessedAt` to the supplied recall timestamp.
   - Keep `createdAt`, `updatedAt`, and Future Intent lifecycle fields unchanged.
   - Initialize missing stability through the existing compatibility default, then apply a small access-count tiered boost and clamp to `[0, 1]`.

2. Add a storage-layer batch updater in `lib/memory-storage.ts`.
   - Use one read/write IndexedDB transaction against the `by_character_type` index.
   - Update only matching `long_term` records whose IDs were selected.
   - Normalize legacy records before applying the pure stats function.
   - Leave migration restore/import APIs untouched.

3. Add an opt-in recall callback to the single and group prompt assemblers.
   - Trigger only after final payload assembly and only when the `memoryLongTerm` marker produced non-empty content.
   - Keep callback failure isolated with a warning and never await it from synchronous assembly.
   - Production prompt builders pass selected memory IDs; previews, debug snapshots, custom-app memory reads, and other read-only paths do not.

4. Wire the callback through every existing production long-term-memory prompt builder, including chat, group chat, moments, story, VN, reading, Xiaohongshu, adventure, calendar, diary, dwelling, game, co-create, black-market, and cloud prompt paths. Shared builders receive an explicit `recordMemoryRecall` option so preview calls remain read-only.

5. Add focused tests for the pure algorithm, selected-only callback behavior, budget/diversity exclusion, legacy initialization, write failures, Future Intent lifecycle preservation, and migration/debug/dry-run exclusion. Add the test to `npm test`.

## Verification

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- Inspect `git diff`, confirm `feature/sully-migration` is unchanged, and commit only the scoped Commit 5 files.
