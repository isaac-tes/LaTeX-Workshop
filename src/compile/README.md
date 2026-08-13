# Compile System

This directory implements the LaTeX build pipeline. It turns a manual or
automatic build request into a selected recipe, an executable plan, and a
sequence of child processes. It also coordinates concurrent requests and
publishes the build state used by the rest of the extension.

## Architecture

The main dependency and execution flow is:

```text
extension callers
       |
       v
    index.ts          public API and initialization
       |
       v
    build.ts          manual/automatic build facade
       |
       v
  executor.ts         request coordination and Plan lifecycle
     |     |
     v     v
recipe.ts  plan.ts    recipe selection and executable plan
              |
              v
           step.ts    one child-process lifecycle
```

Dependencies point down this graph. A lower layer does not start or manipulate
an upper layer. `index.ts` is the composition root and is the only module that
initializes the complete subsystem.

## End-to-End Flow

1. A caller uses `lw.compile` to request a manual or automatic build.
2. `build.ts` applies facade-level rules, such as automatic-build mode,
   throttling, and ignored save paths, then forwards the request to the
   `Executor` singleton.
3. `Executor` resolves the build target, gives external build configuration
   priority, saves documents, and asks `Recipe` to select a configured or
   magic-comment recipe.
4. `Plan.create` resolves named tools, copies and expands their configuration,
   and creates an ordered list of `Step` objects.
5. `Executor` serializes eligible Plans. The active Plan runs its Steps in
   order, with Plan-level progress reporting and optional clean-and-retry.
6. Each `Step` spawns and monitors one child process, parses its output, and
   returns a structured result.
7. `Executor` handles Plan success or failure, updates shared compile state,
   refreshes build artifacts, and starts the next eligible pending Plan.

## Modules

### `index.ts`: public API and composition root

`index.ts` initializes the subsystem in dependency order:

```text
Recipe -> Plan -> Executor -> Build
```

It exports the `compile` object attached to `lw.compile`. Other extension
modules should use this object instead of importing the `Executor` singleton.
The public surface contains:

- `manualBuild`, `autoBuild`, and `terminate` commands;
- `preventAutoBuild` and `isFileExcludedFromBuildOnSave` helpers;
- read-only `backend`, `compiledPDFPath`, and `compiledPDFWriting` state.

The read-only getters keep execution state owned by `Executor` while allowing
the parser and viewer to observe the values they need.

### `build.ts`: build facade

`build.ts` is the entry layer for extension-facing build operations. It does
not prepare recipes or run processes.

Its responsibilities are:

- register source and bibliography watcher callbacks once;
- translate manual and automatic calls into `Executor.run` requests;
- enforce the configured automatic-build trigger;
- publish the `AutoBuildInitiated` event;
- throttle closely spaced automatic builds;
- match build-on-save exclusion globs;
- forward termination to `Executor`.

The only state held here is initialization state and the timestamp used for
automatic-build throttling.

### `executor.ts`: request coordinator

`Executor` owns the lifecycle above individual Plans. The exported `executor`
is the single production instance and remains private to the compile subsystem.

Its main responsibilities are:

- resolve manual and automatic root/subfile targets;
- detect and prepare external builds;
- save workspace documents before creating a Plan;
- coordinate active, pending, and still-preparing requests;
- prepare auxiliary directories and the compiled PDF path;
- run one Plan at a time;
- retain the detected backend and PDF-writing state;
- handle termination, failure cleanup, and successful-build follow-up;
- react to Docker image and executable-path configuration changes.

#### Request coordination

Plan preparation can be asynchronous, so request order is tracked separately
from preparation completion. A successfully prepared newer request replaces an
older pending candidate. A request that produces no Plan or fails during
preparation does not discard an existing valid candidate.

`generation` separates requests that remain eligible from requests invalidated
by termination or Plan failure. Before switching Plans or becoming idle, the
drain waits for preparations in the current generation that can still provide
the latest candidate. This preserves request order without running more than
one Plan at a time.

Termination clears pending work in the current generation and delegates to the
active Plan. A request created after termination belongs to the new generation
and can run after the active Step exits.

#### Build follow-up

Before execution, `Executor` prepares auxiliary subdirectories and selects the
PDF path observed by the viewer. After execution it:

- records the backend reported by the Plan;
- reports failures and optionally cleans auxiliary files;
- publishes `BuildDone` after a successful rooted build;
- refreshes the PDF viewer and reference data;
- loads the FLS file;
- performs configured SyncTeX and successful-build cleanup actions.

`compiledPDFWriting` brackets a drain that executes at least one Plan. The PDF
viewer uses this counter to avoid reacting to intermediate file writes while
the builder is responsible for the final refresh.

### `recipe.ts`: recipe selection

`Recipe` describes what tools should be used and the context in which they
will run. It does not resolve configured tool names into executable Steps.

A Recipe contains:

- a display name;
- configured tool names and/or inline Tool objects;
- an optional root file;
- a working directory;
- an external-build flag.

`Recipe.create` selects an internal recipe using root-scoped configuration,
the requested recipe name, language filtering, last-used state, and supported
magic comments. TeX magic comments can create an inline magic recipe; an LW
recipe magic comment can select a configured recipe. TeX and BIB magic tools
receive configured default arguments when their comments do not provide
options.

`Recipe.createExternal` reads the external build command and arguments. It can
create a Recipe with or without root metadata and chooses the first workspace
folder, or the active document directory, as its working directory.

Recipe construction copies the tool list. Tool expansion and deep copying are
deferred to `Plan`, so configuration objects remain unchanged.

### `plan.ts`: tool expansion and ordered execution

`Plan` converts a Recipe into executable Steps and owns their sequential
execution. A Plan is immutable in structure after construction, apart from its
current `activeStep` and the retry/skipped state held by its Steps.

During `Plan.create`, the module:

- resolves tool names against `latex.tools` and skips undefined tools;
- deep-copies all selected Tool objects;
- applies Docker command substitution where applicable;
- expands argument, working-directory, and environment placeholders;
- resolves relative tool working directories;
- records output and auxiliary directories;
- applies the MiKTeX max-print-line option;
- creates indexed Steps with a stable total count.

During `Plan.run`, Steps execute serially. The Plan updates status-bar progress,
tracks the active Step for termination, aggregates skipped-build information,
and carries forward the backend reported by the latest Step.

A failed internal Step may be cleaned and retried once when the relevant
setting enables it. Process errors, external Steps, user termination, and an
already retried Step are not retried. The returned `PlanResult` identifies both
the terminal Step and its detailed `StepResult`.

### `step.ts`: child-process lifecycle

`Step` is the lowest execution layer. One Step represents one Tool invocation
with copied arguments and environment, a fixed working directory, recipe
position, and optional root metadata.

`Step.run`:

- prepares compiler logging and process environment;
- resolves regular, magic-comment, BibTeX, and external invocation forms;
- spawns exactly one child process;
- accumulates and logs stdout and stderr;
- parses both output streams for diagnostics and skipped-build state;
- detects the LaTeX backend from process output;
- settles once on process error, exit, or close;
- returns a `StepResult` without coordinating any other Step.

The Step owns its active `ChildProcess`. `terminate` first attempts to kill the
child process tree with the platform-specific command, then always attempts to
kill the direct process. It returns the first termination error to the caller.

### `types.ts`: internal data contracts

This file contains the shared structures passed between compile layers:

- `Tool`: an executable tool definition;
- `RecipeConfig`: the configured recipe shape;
- `StepResult`: the complete result of one process invocation;
- `PlanResult`: the terminal Step result plus Plan-level skipped/backend data.

These types describe data only. Runtime state remains in the owning classes.

### `constants.ts`: compile constants

This file is the single source for magic-tool sentinel names and the maximum
print-line value shared by Recipe, Plan, and Step.

## State Ownership

State belongs to the narrowest layer that can manage its lifecycle:

| State | Owner |
| --- | --- |
| Automatic-build throttle | `build.ts` |
| Active/pending Plans and request generations | `Executor` |
| Backend, compiled PDF path, PDF-writing counter | `Executor` |
| Last-used recipe and language | `Recipe` |
| MiKTeX detection cache | `Plan` |
| Active Step | `Plan` |
| Child process, retry, and skipped flags | `Step` |

The objects passed down the pipeline use defensive copies at their ownership
boundaries: Recipe copies its tool list, Plan deep-copies selected Tools, and
Step copies argument and environment containers.

## Extension Integration

The compile subsystem uses `lw` services for configuration, root discovery,
file and cache operations, logging, parsing, cleaning, events, viewer refresh,
and process execution. These services support the pipeline but do not own its
execution state.

External consumers should call or observe `lw.compile`. Direct imports of
`executor`, `Plan`, `Recipe`, or `Step` are reserved for this directory and its
focused unit tests.

## Tests

Focused tests live in `test/units/02_compile` and mirror the module boundaries:

- `build.test.ts`
- `executor.test.ts`
- `recipe.test.ts`
- `plan.test.ts`
- `step.test.ts`

Cross-module behavior is also covered by the relevant viewer, parser, cleaner,
and multiroot tests. When changing ownership or control flow, update the test
suite for the module that owns the behavior and retain integration coverage for
affected `lw.compile` consumers.
