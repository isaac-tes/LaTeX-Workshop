# Cache Refactoring Migration Plan

## Status and Authority

This document is the authoritative migration plan for refactoring
`src/core/cache.ts`. Update this document before changing the implementation if
new repository facts conflict with the plan or require a behavioral decision.
Behavior outside the decisions recorded here must not be changed without a new
review.

Current status: **Phase 2 complete; Phase 3 not started.**

The migration must remain incremental and reversible. Structural moves, test
moves, and behavior changes belong in separate commits whenever practical.

## Goals

- Keep `src/core/cache.ts` as the public cache module containing the coordinator
  class and its production singleton.
- Replace the original object-literal implementation with one production
  singleton instance of `Cache`, created at the end of the module.
- Split storage, dependency discovery, bibliography handling, and auxiliary-file
  handling into files with explicit responsibilities.
- Preserve the production API throughout the structural migration.
- Make every `Cache` instance own independent cache state, in-flight state,
  refresh counters, aggressive-refresh timers, and watcher subscriptions.
- Reach 100% statements, branches, functions, and lines coverage for the public
  cache module and every file under `src/core/cache/`.
- Document critical methods and non-obvious ordering, concurrency, recursion,
  ownership, and lifecycle constraints in English.

## Non-goals

- Do not remove `lw` or introduce dependency injection in this refactoring.
  Internal modules may import `lw`, `vscode`, and the existing utility modules.
- Do not refactor project-wide path handling or other core modules. The only
  approved watcher API change is returning disposables from handler
  registration methods as recorded in Phase 1.5.
- Do not support multiple production `Cache` instances. Extra instances exist
  for isolated unit tests; services reached through `lw`, including watchers,
  remain shared globals. Every extra `Cache` instance must be disposed by its
  test.
- Do not add `src/core/cache/index.ts`.
- Do not expose `CacheStore` or extracted helper APIs through the public cache
  module. `Cache` remains exported so tests can construct isolated instances.

## Target Structure

```text
src/core/cache.ts
src/core/cache/store.ts
src/core/cache/dependencies.ts
src/core/cache/bibliography.ts
src/core/cache/auxiliaries.ts

test/units/01_core/cache-lifecycle.test.ts
test/units/01_core/cache.test.ts
test/units/01_core/cache-store.test.ts
test/units/01_core/cache-dependencies.test.ts
test/units/01_core/cache-bibliography.test.ts
test/units/01_core/cache-auxiliaries.test.ts
```

### Public coordinator: `src/core/cache.ts`

This module defines and exports `Cache`. After the class definition, it creates
the single production instance, registers that disposable instance with the
extension lifecycle, and exports it:

```ts
export const cache = new Cache()
lw.onDispose(cache)
```

Production consumers continue to import `cache`. Unit tests that need isolated
instances import `Cache` from this module. The module must not re-export
`CacheStore` or extracted helpers.

The `Cache` constructor subscribes directly to `lw.watcher.src` and owns the
returned disposables. It must not register itself with the extension lifecycle;
the module-level statement after singleton creation alone passes the production
instance to `lw.onDispose`. Tests that construct additional instances must
dispose them in `finally` or teardown.

`Cache` owns the public API and coordinates refresh lifecycle, AST parsing,
completion parsing order, bibliography updates, waiting, resets, disposal, and
aggressive refreshes. Its constructor takes no arguments and may use `lw`
directly.

Each instance owns:

- one `CacheStore`;
- its in-flight and queued-refresh state;
- its active-refresh count;
- its generation/revision state;
- its per-file aggressive-refresh timers;
- its source-watcher subscriptions;
- its disposed state.

Completion parsing order remains explicit in `Cache`. Package parsing must stay
before environment and macro parsing because those parsers depend on package
information.

### Store: `cache/store.ts`

`CacheStore` is a named-export class containing only instance state and storage
operations:

- cached `FileCache` values;
- in-flight task registration and lookup;
- `get`, `set`, `delete`, `clear`, and `paths`.

`CacheStore` must not access `lw`, reset watchers, log, emit events, refresh
files, own refresh counters or timers, or implement timeout behavior.
`Cache.wait()` remains orchestration in `Cache`.

### Dependencies: `cache/dependencies.ts`

This module owns TeX input discovery, `\externaldocument` discovery, included
TeX graph traversal, path de-duplication, and cycle prevention. Use functions
and local types rather than another service class.

During the behavior-preserving extraction, define `DependencyContext` in this
file with exactly `getCache`, `watchSource`, and `refreshSource` callbacks from
the owning `Cache`. Each `Cache` creates one immutable context using arrow
wrappers that dynamically call its instance methods. This temporary
callback-based side-effect model avoids importing the production singleton and
therefore works with isolated `Cache` instances. The module may directly use
`lw` for file I/O, configuration, watcher queries, and logging, but it must never
access `lw.cache`.

Phase 6 removes `DependencyContext` completely: discovery functions return
explicit results, and `Cache` applies cache mutations, watcher registration, and
recursive refresh side effects. The included-TeX graph helper may still receive
one standalone read-only cache lookup callback. Internal modules must not import
each other to reach the production singleton.

### Bibliography: `cache/bibliography.ts`

This module owns BibTeX and glossary resource discovery, registration, and
included-bibliography graph traversal. Use functions and local types. It may
access `lw` directly during this refactoring. `Cache` resolves the default root
before invoking graph queries in the final design.

### Auxiliaries: `cache/auxiliaries.ts`

This module owns both pure `.fls`/`.aux` parsing and the complete
`loadFlsFile`/`getFlsChildren` workflow. Keep pure parsing visibly separated
from I/O and mutation inside the file.

During the behavior-preserving extraction, define its callback context type in
this file. It may call back into the owning `Cache` for cache lookup, source
registration, and recursive refresh. A later phase replaces discovery side
effects with returned results coordinated by `Cache`.

The current AUX behavior is intentional during migration: bibliography entries
found in an AUX file are attached to the current global root cache, which is not
necessarily the FLS owner. Preserve this behavior with a characterization test.
Any owner change requires a separately approved behavior change.

## Public API Contract

The production method names, arguments, and runtime calling conventions remain
compatible:

```ts
add(filePath: string): void
get(filePath: string): FileCache | undefined
paths(): string[]
getIncludedTeX(filePath?: string, includedTeX?: Set<string>): Set<string>
getIncludedBib(filePath?: string): string[]
getIncludedGlossaryBib(filePath?: string): string[]
getFlsChildren(texFile: string): Promise<string[]>
wait(filePath: string, seconds?: number): Promise<void>
reset(): void
dispose(): void
refreshCache(filePath: string, rootPath?: string): Promise<void>
refreshCacheAggressive(filePath: string): void
loadFlsFile(filePath: string): Promise<void>
```

Three approved exceptions are part of this plan, all applied in Phase 8:

1. Normalize the misleading nested asynchronous return types to
   `Promise<void>`.
2. Remove the undocumented second `getIncludedTeX` accumulator argument and
   keep traversal state private to `dependencies.ts`.
3. Remove the test-only `promises` property after its tests have migrated to
   behavior-based assertions.

During the compatibility period, expose `promises` through a getter with the
same mutable `Map<string, Promise<void>>` type and mark it `@deprecated`. Do not
change it to `ReadonlyMap` during the compatibility period. Remove it only in
the dedicated API-cleanup phase.

## Approved Behavioral Changes

The following changes are approved but must not be mixed into the mechanical
file extraction.

### Per-file refresh coalescing

- Only one refresh for a given normalized path runs at a time.
- A refresh request received while that path is running sets one pending-rerun
  flag. Multiple pending requests coalesce into that one rerun.
- Every caller waits until the path's queue becomes stable, including the rerun.
- Different paths may refresh concurrently.
- If the first run fails while a rerun is pending, still execute the rerun and
  log the first failure. The final rerun result determines the callers' final
  result.
- Recursive child refreshes are scheduled by `Cache`, but a parent refresh does
  not await the entire recursive graph. This avoids wait cycles in circular
  input graphs.

### Atomic refresh and failure handling

- Build a local draft and replace the committed cache only after all required
  stages succeed.
- Preserve the last successful cache if a new refresh fails.
- Propagate errors to callers that explicitly await the refresh.
- Always clean in-flight state and active-refresh counts in `finally` paths.
- Do not emit `FileParsed` for a failed refresh.
- Log the file path and a fixed refresh stage:

```ts
type RefreshStage =
    | 'read'
    | 'dependencies'
    | 'ast'
    | 'completion'
    | 'bibliography'
    | 'commit'
```

- Fire-and-forget boundaries, including watcher callbacks, timers, and child
  refresh scheduling, must catch and log rejections through one internal helper.
  They must not cause unhandled promise rejections.
- When all concurrent refreshes finish, reconstruct the outline once if any
  refresh committed successfully. One failed file must not hide successful
  updates from other files.

### Reset, deletion, and disposal

- `reset()` clears caches, resets source/BibTeX/glossary watchers, cancels all
  aggressive-refresh timers, invalidates old work, and leaves the instance
  reusable.
- Use an instance generation or revision so work started before `reset()` cannot
  commit or emit events afterward.
- Source deletion removes the committed entry and invalidates any in-flight or
  queued result for that path. Underlying I/O does not need cancellation.
- `dispose()` performs reset cleanup and permanently marks the instance as
  disposed.
- `reset()` remains idempotent after disposal.
- State-changing methods throw a clear disposed-instance error after disposal.
- `get`, `paths`, and included-file graph queries return empty state after
  disposal.
- `wait`, `getFlsChildren`, and `loadFlsFile` throw after disposal because they
  may perform I/O or mutate state.

### Waiting

- Keep `wait(filePath, seconds = 2)` for API compatibility and convert seconds
  to milliseconds internally.
- Return immediately when a successful committed cache exists and no refresh is
  active for the path.
- Otherwise wait for the path's complete coalesced queue.
- On timeout, force a refresh. Propagate a forced-refresh failure.

### Aggressive refresh

- Replace the single global debounce timer with one timer per file path.
- Changes to one file must not cancel another file's delayed refresh.
- Repeated changes to the same file replace only that file's timer.
- `reset()` and `dispose()` clear every timer.

### Dependency identity and ordering

- Keep `FileCache.children` as an array.
- Normalize cache, in-flight, timer, and dependency identity keys with
  `path.normalize()` in the dedicated behavior phase.
- On Windows, normalize drive-letter case consistently.
- Limit this path-identity change to the cache subsystem; do not refactor
  project-wide path handling.
- Keep source dependencies in textual order and FLS-only dependencies at the
  end.
- De-duplicate by normalized path. Preserve the first meaningful source index;
  do not replace it with the FLS sentinel `Number.MAX_VALUE`.
- Preserve original paths where useful in logs.

### Cache eligibility

- Continue reading `latex.watch.files.ignore` dynamically for every exclusion
  decision.
- Preserve the current substring-based `expl3-code.tex` exclusion during the
  structural migration.
- In the behavior phase, change it to an exact basename comparison and add
  Windows and case-sensitivity tests.

## Commenting Standard

All new comments are written in English. Comments explain contracts, reasons,
ordering, ownership, side effects, concurrency, and non-obvious invariants. They
must not narrate straightforward assignments or repeat the implementation line
by line.

- Public methods receive concise JSDoc describing their contract, important
  side effects, and return/error semantics.
- Complex flows receive a short block comment explaining their phases and why
  that order matters.
- Simple getters, setters, and obvious mappings do not require comments.

At minimum, add design comments for:

- `Cache.refreshCache` and its read-to-commit stage order;
- the per-file queue and coalescing behavior;
- `Cache.wait`;
- generation invalidation in `reset()` and `dispose()`;
- per-file aggressive-refresh debounce;
- dependency discovery and recursive scheduling;
- external-document ownership;
- completion parser ordering;
- FLS input/output processing;
- current-root ownership of AUX bibliography data;
- graph traversal and cycle prevention;
- atomic cache commit and failure handling.

## Testing and Coverage Policy

Tests remain flat under `test/units/01_core/`:

- `cache-lifecycle.test.ts`: singleton export and extension-disposal wiring;
- `cache.test.ts`: `Cache` orchestration and public behavior;
- `cache-store.test.ts`: isolated `CacheStore` behavior;
- `cache-dependencies.test.ts`: input/XR discovery and TeX graph traversal;
- `cache-bibliography.test.ts`: BibTeX/glossary discovery and traversal;
- `cache-auxiliaries.test.ts`: FLS/AUX parsing and workflows.

`cache-store.test.ts` uses only in-memory `FileCache` values and has no fixture
directory. The dependency, bibliography, and auxiliary test files explicitly
share `test/units/01_core/cache/`; they must not call `get.fixture(__filename)`,
which would resolve to separate non-existent directories.

Export only internal units with an independent contract. Use named exports such
as `Cache`, `CacheStore`, pure FLS/AUX parsers, and graph traversal functions.
Do not export every helper merely to make coverage easier; private branches are
covered through public behavior.

Every migration phase must leave `src/core/cache.ts` and every implemented file
under `src/core/cache/` at exactly 100% for all four metrics:

- statements;
- branches;
- functions;
- lines.

Do not use coverage-ignore comments. Remove unreachable branches or restructure
them. In particular, checks that treat the non-empty return of `path.resolve()`
as optional should be removed when their behavior phase is reached.

Coverage is an explicit manual review gate rather than a new CI gate. Record the
four actual percentages in the phase checklist before completing a phase.

### Node 20 verification environment

Activate Node 20 with the developer's version manager before running any cache
coverage command. Do not first try the workspace's current Node 26 runtime:
`c8@11.0.0` currently fails there while loading `yargs`. The repository's GitHub
Actions jobs use Node 20.

```bash
node --version
# Required: v20.x

npm ci
npm run compile
```

The current `npm run coverage` command does not enforce the intended cache
thresholds: its `--src` option appears after the child command, and c8 defaults
do not require all four metrics or include unloaded files. Until that existing
script is corrected in its own commit, run the scoped command below under Node
20 and inspect its per-file output:

```bash
npx c8 \
  --all \
  --src out/src/core \
  --include 'out/src/core/cache.js' \
  --include 'out/src/core/cache/**/*.js' \
  --include 'src/core/cache.ts' \
  --include 'src/core/cache/**/*.ts' \
  --exclude-after-remap \
  --per-file \
  --100 \
  npm run test
```

Both generated JavaScript and source TypeScript include patterns are required:
tests execute `out/**/*.js`, while source maps remap coverage to `src/**/*.ts`.
`--all` ensures an unimported new module cannot disappear from the report.

## Migration Checklist

For every phase, fill in **Coverage evidence** with the actual per-file four
metric values before checking the phase complete.

### [x] Phase 0: Baseline and characterization tests

**Status:** Complete on 2026-08-14. This phase changed tests and this migration
document only; no production source or fixture changed.

**Goal:** Establish behavior before moving implementation.

**Files affected:** Existing `cache.test.ts` and fixtures only. Test moves may be
committed separately, but production code does not move in this phase.

**Behavior policy:** Preserve current behavior, including partial-cache
visibility, concurrent refresh behavior, global aggressive debounce, and AUX
bibliography ownership. Tests for known defects document behavior without
endorsing it as the final design.

**Implementation notes:** Add coverage for import-time listener behavior,
refresh failures, concurrent same-file refreshes, reset during refresh, source
deletion during refresh, and AUX ownership. Identify every direct test use of
the `promises` property.

**Required comments:** Test names must state the observed contract; no production
comments yet.

**Tests to move/add:** Baseline tests that will later move into all six target
test files.

**Characterization evidence:** The baseline now covers import-time source
watcher change and deletion callbacks, AST failure after partial-cache creation,
same-file refresh concurrency, reset and deletion during an in-flight refresh,
and AUX bibliography ownership. In particular, AUX `\bibdata{main}` is
resolved relative to the current global root's directory and attached to that
root cache, even when the AUX file was loaded for a different FLS owner.

Direct `cache.promises` test access is confined to
`test/units/01_core/cache.test.ts`. At Phase 0 completion it has eight direct
assertions, covering `wait`, normal refresh cleanup, failed refresh cleanup,
same-file concurrent refresh bookkeeping, reset during refresh, and deletion
during refresh. Phase 8 must replace all eight with behavior-based assertions
before removing the compatibility property.

**Coverage evidence:** The scoped c8 run reported the following values for
`src/core/cache.ts`: statements **100%**, branches **100%**, functions **100%**,
and lines **100%**. The report's `All files` row also reported 100% for all four
metrics.

**Verification evidence:** All commands ran directly with Node `v20.20.2` from
`/Users/jqyu/.npm/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node` as required.
Both `tsc -p tsconfig.json` and `tsc -p viewer/tsconfig.json` passed. The focused
cache suite passed with **102 passing**, the full suite passed with **1108
passing**, and the scoped `c8 --all --per-file --100` run exited successfully.

**Verification commands:** Node 20 setup, `npm run compile`, relevant unit tests,
full `npm run test`, and the scoped c8 command above.

**Suggested commit boundary:** Characterization tests only.

**Rollback point:** Revert the test-only commit.

### [x] Phase 1: Introduce `CacheStore` and `Cache`

**Status:** Complete on 2026-08-14.

**Goal:** Move instance state into `CacheStore` and public orchestration into a
named-export `Cache` class without changing runtime behavior.

**Files affected:** `cache/cache.ts`, `cache/store.ts`, `src/core/cache.ts`,
`cache-store.test.ts`, and `cache.test.ts`.

**Behavior policy:** Mechanical migration only. Keep current cache visibility,
promise timing, counters, and debounce semantics. Public methods require normal
receiver calls such as `cache.get(path)`; detached method calls are not part of
the compatibility contract because no repository caller relies on them.

**Implementation notes:** Keep the coordinator in `cache/cache.ts`; do not use
`cache/index.ts`, which would be shadowed by the sibling public facade during
normal module resolution. Use a no-argument constructor. `CacheStore` owns only
cached values and the in-flight promise map; `Cache` owns its active-refresh
counter and the current single aggressive-refresh timer. Retain the deprecated
`promises` compatibility getter with its existing mutable `Map` type. Do not
register global listeners in the constructor at this phase boundary. Moving all
implementation into the class necessarily reduces the facade to singleton
creation and global lifecycle wiring in this phase; do not retain forwarding
wrappers solely to defer that structural result to Phase 5. Phase 1.5 explicitly
supersedes the listener-ownership decision after making subscriptions disposable.

After Phase 1.5, the coordinator was moved back into `src/core/cache.ts` because
the remaining facade contained only singleton creation and lifecycle wiring.
Those statements now live after the `Cache` class. This supersedes the target
location above while preserving the Phase 1 commit history and behavior.

**Required comments:** Explain refresh phase order, completion order, waiting,
and the listener ownership used at this phase boundary.

**Tests to move/add:** Isolated instance-state tests and all `CacheStore` branch
tests. `cache-store.test.ts` constructs data in memory and does not use a fixture.
Keep facade listener tests in `cache.test.ts` until Phase 5.

**Implementation evidence:** `CacheStore` now owns cache entries and the
in-flight map without importing `lw`. Every `Cache` owns one store, its refresh
counter, and its aggressive-refresh timer. Public methods remain prototype
methods and are called through their owning instance. Construction has no global
listener side effects; the facade alone creates the production singleton and
connects watcher/disposal callbacks with arrow functions that capture it. The
existing concurrent, partial-cache, reset, deletion, debounce, and nested-Promise
behavior remains characterized and unchanged. The isolated-instance test adds
one identity assertion over two instances' deprecated `promises` getters;
migrate it with the Phase 0 direct-map assertions in Phase 8.

**Coverage evidence:** The scoped c8 run reported statements **100%**, branches
**100%**, functions **100%**, and lines **100%** separately for
`src/core/cache.ts`, `src/core/cache/cache.ts`, and `src/core/cache/store.ts`.
The aggregate row also reported 100% for all four metrics.

**Verification evidence:** All commands ran with Node `v20.20.2`. ESLint passed
for every changed TypeScript file. Both `tsc -p tsconfig.json` and
`tsc -p viewer/tsconfig.json` passed. The focused cache suite passed with **107
passing**; the full suite and final scoped coverage run passed with **1113
passing**.

**Verification commands:** Standard compile, relevant tests, full tests, and
scoped c8 command under Node 20.

**Suggested commit boundary:** Store/class introduction only.

**Rollback point:** The Phase 0 baseline commit.

### [x] Phase 1.5: Make watcher subscriptions disposable

**Status:** Complete on 2026-08-14.

**Goal:** Give watcher handler registrations explicit lifetimes and let every
`Cache` instance own its source-change and source-delete subscriptions.

**Files affected:** `core/watcher.ts`, `core/cache.ts`, `cache/cache.ts`,
`watcher.test.ts`, `cache.test.ts`, and this migration document.

**Behavior policy:** Preserve watcher dispatch, handler de-duplication, reset,
cache refresh, and cache deletion behavior. Existing watcher consumers may
ignore the newly returned disposable.

**Implementation notes:** `Watcher.onCreate`, `onChange`, and `onDelete` return
a `vscode.Disposable` that removes only the registered handler. `Watcher.reset`
continues to dispose filesystem watchers without clearing handler subscriptions.
The no-argument `Cache` constructor registers directly with `lw.watcher.src` and
combines both subscriptions. `Cache.dispose()` releases them before performing
the existing reset cleanup. Before Phase 7, disposal does not yet introduce the
final permanent disposed-state behavior.

**Required comments:** Explain the separate lifetimes of filesystem watcher
state, handler subscriptions, cache reset, and cache disposal.

**Tests to move/add:** Cover all three returned handler disposables, idempotent
disposal, subscription survival across watcher reset, Cache registration and
cleanup, and facade extension-disposal ownership. Every test-created `Cache`
must be disposed.

**Coverage evidence:** The final scoped c8 run reported statements **100%**,
branches **100%**, functions **100%**, and lines **100%** separately for
`src/core/watcher.ts`, `src/core/cache.ts`, `src/core/cache/cache.ts`, and
`src/core/cache/store.ts`. The aggregate row also reported 100% for all four
metrics.

**Verification evidence:** All commands ran with Node `v20.20.2`. ESLint passed
for every changed TypeScript file. Both `tsc -p tsconfig.json` and
`tsc -p viewer/tsconfig.json` passed. The focused cache/watcher suite passed with
**131 passing**; the full suite and final scoped coverage run passed with **1114
passing**.

**Verification commands:** Standard Node 20 verification suite, focused watcher
and cache tests, full tests, and scoped per-file 100% coverage.

**Suggested commit boundary:** Watcher subscription lifecycle only.

**Rollback point:** The completed Phase 1 commit.

#### [x] Post-Phase 1.5: Consolidate the public cache module

**Status:** Complete on 2026-08-14.

The coordinator moved from `src/core/cache/cache.ts` back into
`src/core/cache.ts`. The `Cache` class remains available for isolated tests,
while production consumers continue to use the `cache` singleton. Singleton
creation and `lw.onDispose(cache)` are the final module-level statements. No
runtime behavior or lifecycle ownership changed.

**Verification evidence:** ESLint and both TypeScript compilations passed under
Node `v20.20.2`. The focused cache/watcher suite passed with **131 passing**.
The full suite passed with **1114 passing**, and the scoped per-file coverage run
reported **100%** statements, branches, functions, and lines for
`src/core/cache.ts` and `src/core/cache/store.ts`.

**Rollback point:** The completed Phase 1.5 commit.

### [x] Phase 2: Extract dependency handling

**Status:** Complete on 2026-08-14.

**Goal:** Move input, XR, and included-TeX graph logic to `dependencies.ts`.

**Files affected:** `cache/dependencies.ts`, `src/core/cache.ts`, and
`cache-dependencies.test.ts`.

**Behavior policy:** Preserve immediate watcher registration, non-blocking
recursive refresh side effects, input-before-XR scan order, exact-path
de-duplication, root ownership, and already-watched short-circuit behavior. Do
not modify `InputFileRegExp`.

**Implementation notes:** Export only `updateDependencies`, `getIncludedTeX`,
and the `DependencyContext` type. Keep input and XR helpers private. Each
`Cache` owns one readonly context whose arrow wrappers call `get`, `add`, and
`refreshCache` dynamically; do not use `bind`. `Cache` resolves the dependency
root as the explicit root, current global root, or current file before calling
the module. Never import or call the production singleton. This callback
direction is an explicitly temporary migration bridge removed in Phase 6.

**Required comments:** Explain recursive scheduling, non-blocking child refresh,
XR root ownership, ordering, de-duplication behavior, and cycle prevention.

**Tests to move/add:** Directly test input discovery, XR discovery,
already-watched files, missing/root files, circular graphs, duplicates, and
default-root traversal in `cache-dependencies.test.ts`. Keep one Cache
coordination test. Characterize that `InputFileRegExp` exhausts input matches
before noweb child matches and that an unresolved match can stop the scan; do
not change either behavior in this phase.

**Coverage evidence:** The final scoped c8 run reported statements **100%**,
branches **100%**, functions **100%**, and lines **100%** separately for
`src/core/cache.ts`, `src/core/cache/dependencies.ts`, and
`src/core/cache/store.ts`. The aggregate row also reported 100% for all four
metrics.

**Verification evidence:** All commands ran with Node `v20.20.2`. ESLint passed
for every changed TypeScript file. Both `tsc -p tsconfig.json` and
`tsc -p viewer/tsconfig.json` passed. The final focused cache/dependency/watcher
suite passed with **130 passing**; the full suite and final scoped coverage run
passed with **1113 passing**.

**Verification commands:** Standard Node 20 verification suite.

**Suggested commit boundary:** Dependency extraction only.

**Rollback point:** The completed Phase 1.5 commit.

### [ ] Phase 3: Extract bibliography handling

**Status:** Not started.

**Goal:** Move BibTeX/glossary discovery, watcher registration, and graph queries
to `bibliography.ts`.

**Files affected:** `cache/bibliography.ts`, `src/core/cache.ts`, and
`cache-bibliography.test.ts`.

**Behavior policy:** Preserve macro matching, resolution, exclusions, watcher
side effects, default-root behavior, result ordering, and de-duplication.

**Implementation notes:** Use functions and local types. Direct `lw` access is
allowed. Do not create another stateful service class.

**Required comments:** Explain supported macro families, bibliography versus
glossary ownership, and graph cycle prevention.

**Tests to move/add:** All BibTeX/glossary macros, multiple resources,
exclusions, missing files, watcher state, nested/circular graphs, and duplicates.

**Coverage evidence:** Pending for all implemented cache files.

**Verification commands:** Standard Node 20 verification suite.

**Suggested commit boundary:** Bibliography extraction only.

**Rollback point:** The completed Phase 2 commit.

### [ ] Phase 4: Extract auxiliary-file handling

**Status:** Not started.

**Goal:** Move FLS/AUX parsing and workflows to `auxiliaries.ts`.

**Files affected:** `cache/auxiliaries.ts`, `src/core/cache.ts`, and
`cache-auxiliaries.test.ts`.

**Behavior policy:** Preserve all existing FLS filtering, child ordering,
watcher/refresh side effects, and current-global-root AUX bibliography ownership.

**Implementation notes:** Keep pure content parsers separate from I/O workflows.
Define callback context types in this file. Call the owning instance through
callbacks; never import the production singleton. This is the second temporary
callback bridge removed in Phase 6.

**Required comments:** Explain INPUT/OUTPUT filtering, FLS-only child ordering,
AUX source-directory translation, and current-root bibliography ownership.

**Tests to move/add:** Pure parser cases, unreadable/missing FLS/AUX files,
INPUT/OUTPUT overlap, excluded and missing inputs, self-input, cached/watched
inputs, non-TeX inputs, AUX bibliography registration, and empty bibdata.

**Coverage evidence:** Pending for all implemented cache files.

**Verification commands:** Standard Node 20 verification suite.

**Suggested commit boundary:** Auxiliary extraction only.

**Rollback point:** The completed Phase 3 commit.

### [ ] Phase 5: Verify the public cache module

**Status:** Not started.

**Goal:** Verify the coordinator exports, production singleton, and global
lifecycle wiring after the post-Phase 1.5 consolidation.

**Files affected:** `cache-lifecycle.test.ts`, `cache.test.ts`, and only if a wiring
defect is found, `src/core/cache.ts`.

**Behavior policy:** Preserve watcher-change refresh, watcher-delete removal,
watcher resets, and extension disposal behavior.

**Implementation notes:** Move the import-time listener characterization tests
from `cache.test.ts` to `cache-lifecycle.test.ts`. Verify that the module exports
`Cache` and `cache`, that the production constructor owns source change/delete
subscriptions, and that the statement after singleton creation passes it to
`lw.onDispose`. Test-created instances must be disposed after each test.

**Required comments:** Explain why each instance owns its subscriptions while
only the production instance is registered with the extension lifecycle.

**Tests to move/add:** Singleton identity, exact export surface, source change,
source delete, and extension disposal wiring.

**Coverage evidence:** Pending for the public cache module and all internal files.

**Verification commands:** Standard Node 20 verification suite.

**Suggested commit boundary:** Cache-module lifecycle tests only.

**Rollback point:** The completed Phase 4 commit.

### [ ] Phase 6: Return discoveries to `Cache`

**Status:** Not started.

**Goal:** Establish the target one-way coordination flow:

```text
cache module -> Cache -> store/dependencies/bibliography/auxiliaries
```

**Files affected:** `src/core/cache.ts`, `cache/dependencies.ts`,
`cache/auxiliaries.ts`, and their tests.

**Behavior policy:** Preserve externally visible behavior. Change only internal
side-effect ownership.

**Implementation notes:** Remove `DependencyContext` completely and replace its
side-effect callbacks with typed discovery results. `Cache` applies mutations
and schedules child work. `getIncludedTeX` may retain one standalone read-only
cache lookup callback, which is not a side-effect context. Internal modules must
not import each other or the production singleton.

**Required comments:** Explain discovery result ownership and why parent refresh
does not await the full recursive graph.

**Tests to move/add:** Assert returned discoveries separately from the
coordinator's application of them.

**Coverage evidence:** Pending for all cache files.

**Verification commands:** Standard Node 20 verification suite.

**Suggested commit boundary:** Internal side-effect ownership change only.

**Rollback point:** The completed Phase 5 commit.

### [ ] Phase 7: Apply approved lifecycle and concurrency fixes

**Status:** Not started.

**Goal:** Implement the approved behavior described above.

**Files affected:** Primarily `src/core/cache.ts`, `cache/store.ts`, and focused
tests; dependency files may change for identity and de-duplication.

**Behavior policy:** This is the only broad semantic-change phase. Prefer several
small commits: queueing, atomic commit/failure behavior, generation invalidation,
per-file debounce, path identity, dependency ordering, and exact expl3 basename
matching should remain individually reviewable.

**Implementation notes:** Introduce per-path coalescing, atomic drafts, fixed
refresh stages, fire-and-forget rejection handling, generation/revision checks,
per-file timers, cache-local path normalization, and exact eligibility matching.

**Required comments:** All methods listed in the Commenting Standard must now
have their final design comments.

**Tests to move/add:** Cover every approved success, failure, reset, delete,
dispose, concurrency, debounce, path, and recursion branch. Include Windows path
and drive-letter cases.

**Coverage evidence:** Pending for all cache files after every semantic commit.

**Verification commands:** Standard Node 20 verification suite after each
semantic commit.

**Suggested commit boundary:** One approved behavior family per commit.

**Rollback point:** The completed Phase 6 commit, plus each independently passing
semantic commit.

### [ ] Phase 8: Clean up the public cache API

**Status:** Not started.

**Goal:** Complete the three approved public API exceptions.

**Files affected:** `src/core/cache.ts`, cache tests,
and any TypeScript callers affected by the normalized signatures.

**Behavior policy:** Do not change runtime behavior beyond removing external
mutable in-flight access.

**Implementation notes:** Replace remaining tests of `cache.promises` with
behavioral assertions, remove the deprecated getter, and use `Promise<void>` for
`refreshCache` and `wait`. Remove the second `getIncludedTeX` accumulator
argument and keep its traversal Set private to `dependencies.ts`.

**Required comments:** Public JSDoc must state final wait/refresh completion and
error semantics.

**Tests to move/add:** Compile-time call-site audit and behavior tests for queue
completion instead of internal Map inspection.

**Coverage evidence:** Pending for all cache files.

**Verification commands:** Standard Node 20 verification suite plus repository
search confirming no `cache.promises` references remain.

**Suggested commit boundary:** API cleanup only.

**Rollback point:** The completed Phase 7 sequence.

### [ ] Phase 9: Final audit

**Status:** Not started.

**Goal:** Confirm the implementation matches this document and contains no
accidental API or responsibility drift.

**Files affected:** Tests, comments, and narrowly scoped corrections only.

**Behavior policy:** No new behavior. Any newly discovered behavior decision
requires updating and re-approving this plan first.

**Implementation notes:** Audit imports, exports, module direction, instance
state, listener ownership, disposed behavior, error boundaries, and path rules.
Remove obsolete comments and ensure remaining comments explain design rather
than syntax.

**Required comments:** Review the full minimum comment list and public JSDoc.

**Tests to move/add:** Full cache suite and full repository regression suite.

**Coverage evidence:** Record the final per-file table with 100% statements,
branches, functions, and lines for the public cache module and every internal file.

**Verification commands:** Node 20 setup, clean compile, relevant tests, full
tests, scoped c8 command, lint, and a final public-API repository search.

**Suggested commit boundary:** Audit corrections only; no mixed refactoring.

**Rollback point:** The completed Phase 8 commit.

## Completion Criteria

The migration is complete only when:

- every phase is checked and has recorded coverage evidence;
- `src/core/cache.ts` exports the `Cache` class and production `cache` singleton,
  while production consumers continue to use `cache`;
- every `Cache` instance owns independent mutable state;
- every `Cache` instance owns and disposes its watcher subscriptions, and all
  non-production instances are disposed by their tests;
- the one-way internal coordination flow is in place;
- all approved concurrency, lifecycle, error, path, and dependency semantics are
  covered by tests;
- no production or test code accesses `cache.promises`;
- all relevant files report 100% for all four coverage metrics under Node 20;
- compile, lint, focused tests, and the full repository test suite pass;
- critical and complex methods contain concise English design comments.
