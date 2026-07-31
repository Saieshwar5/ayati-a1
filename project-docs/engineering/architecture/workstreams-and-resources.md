# Workstreams, Requests, Runs, and Resources

This page is the canonical description of Ayati's durable-work model.

## Domain hierarchy

```text
agent stream
└── workstream
    └── request
        └── run
            └── WorkState
```

- An agent stream provides conversation continuity across messages and
  clients.
- A workstream is the long-lived owner of one coherent project, maintained
  artifact, topic, or responsibility.
- A request is one independently acceptable outcome and its acceptance
  contract.
- A run is one attempt to advance one request. It is also the execution,
  audit, finalization, and recovery boundary for one accepted input.
- WorkState is the mutable plan, findings, and next action for exactly one run.
- A progress entry is the immutable durable summary of one finalized bound
  run.
- A resource identifies a real file, directory, URL, dataset, database,
  repository, or external object.

The shortest useful distinction is:

```text
workstream = where this work belongs
request    = what exact outcome is promised
run        = what the agent attempted this time
WorkState  = live state for that attempt
```

A website is normally one workstream. Creating the initial site, adding a
contact form, adding analytics, and deploying it are separate requests in that
workstream. Each request may require many runs. Completing one request does
not complete or archive the workstream.

## Ownership boundaries

| Context | Owns | Must not own |
| --- | --- | --- |
| WorkState | Current run plan, findings, evidence references, next action | Historical runs or the permanent request contract |
| Request file | Requested outcome, acceptance criteria, constraints, lifecycle, final outcome | Per-run progress or tool logs |
| `progress.md` | Chronological immutable finalized-run records | Mutable execution state |
| `workstream.md` | Compact distilled current project knowledge | Full history or raw logs |
| `resources.json` | Generated portable resource projection | Manually authored operational state |
| SQLite | Search, identities, run journals, lifecycle coordination, recovery | A manually maintained prose copy of every Markdown file |
| Shared Git | Human-readable history and recovery identity | Deliverables or raw provider output |

## Managed filesystem topology

`AYATI_ROOT_DIR` owns the complete managed topology:

```text
<ayati-root>/
  workspace/                       default user-visible output
  workstreams/                     one context-only Git repository
    .git/
    W-YYYYMMDD-NNNN-<slug>/
      workstream.md
      progress.md
      requests/
        R-NNNN-<slug>.md
      resources.json
  .ayati/
    context.db                     authoritative operational catalog
    resources/                     immutable managed attachment bytes
```

There is exactly one `.git/` beneath `workstreams/`; `W-*` directories are
normal directories, never nested repositories. The shared repository contains
only Ayati-managed context files.

Destination selection follows one policy: honor the exact user path and
layout; otherwise reuse the clearly related project directory; otherwise
create one named directory beneath `<ayati-root>/workspace/`. Relative
filesystem mutation paths resolve beneath that workspace. A canonical
absolute destination outside it is mutable only when an exact routed resource
establishes it as the selected bound project root. Deliverables, source trees,
media, downloads, databases, secrets, raw transcripts, and private attachment
bytes never enter context Git.

## Workstream lifecycle

Workstreams use three states:

| State | Meaning |
| --- | --- |
| `active` | May execute or queue requests |
| `paused` | Temporarily inactive but searchable and readable |
| `archived` | Historical and read-only until explicitly restored |

Allowed transitions are:

```text
active <-> paused
active  -> archived
paused  -> archived
archived -> active   only through explicit restoration
```

A paused or archived workstream cannot have an active request. Reading
archived context does not restore it. Request completion does not
automatically pause or archive the workstream.

## Request lifecycle

Requests use five states:

| State | Meaning |
| --- | --- |
| `queued` | Valid unfinished work that is not the current focus |
| `active` | The one request currently allowed to execute |
| `blocked` | Cannot continue until a concrete external dependency changes |
| `done` | Acceptance criteria were satisfied and verified |
| `dropped` | Cancelled, superseded, duplicated, or no longer wanted |

At most one request is active in a workstream. `queued` covers both unstarted
work and work deferred while another request becomes active; there is no
separate paused-request state.

Allowed transitions are:

```text
queued  -> active | blocked | dropped
active  -> queued | blocked | done | dropped
blocked -> active | queued | dropped
```

`done` and `dropped` are terminal. Ayati does not reopen them. If completed
work later regresses, the repair is a new request so the old completion stays
historically truthful.

`failed` and `incomplete` are run outcomes, not request states:

```text
RUN-1 failed      -> request may remain active
RUN-2 incomplete  -> request may remain active
RUN-3 done        -> request becomes done only with accepted completion evidence
```

A tool failure normally leaves the request active. A request becomes blocked
only when the agent cannot safely continue without an external change, such as
missing user information, approval, credentials, or an unavailable
third-party resource with no safe alternative.

## When to create or continue a request

Every new workstream receives `R-0001`.

Create another request in the selected workstream when the user asks for a
separately acceptable outcome, a later feature, or work with its own
acceptance criteria. Create a queued request only when the user explicitly
asks to record it for later; an agent suggestion begins queued and cannot
silently displace active user work.

Continue the same request when the new work is necessary to satisfy its
existing criteria: the user says continue or resume, an earlier run was
interrupted, validation remains, a tool failed but retry is possible, a
required implementation step is discovered, or new information resolves its
blocker.

Amend the same request when the promised outcome remains the same but the user
or trusted policy changes its criteria, constraints, wording, or destination.
An amendment preserves request id, filename, creation time, and history. A
trusted policy cannot remove existing acceptance criteria; user authority is
required for a genuine scope reduction.

Create a new workstream when the work has a different long-lived owner,
project, subject, or resource boundary.

## Routing

Workstream selection and request selection are separate decisions.

For both read-only questions and unbound mutation, the model observes
workstream ownership through the ordinary modes. `observe.locate` owns
workstream search and resource-owner lookup; `observe.investigate` owns exact
workstream reads. General questions may finish there without binding. For
mutation, the first successful current-run routing call unlocks the
control-only `workstream.route` stage. It exposes no executable tools and may
proceed to `resolve` or return to observation. Direct `ENTRY -> workstream.route`,
`ENTRY -> resolve`, and observation-to-resolve transitions are prohibited.

Within routing, the model observes SQLite-backed candidates and exact resource
owners. Evidence priority is:

1. explicit workstream id;
2. exact resource id or owned path;
3. explicit continuation of the previously bound workstream;
4. exact unique title or alias;
5. matching request contract;
6. matching purpose, snapshot, focus, findings, progress, or resource text;
7. recency, stars, frequency, and unfinished status.

The final group only ranks candidates. It never grants ownership by itself.
When multiple strong candidates remain plausible, Ayati asks one focused
question rather than guessing.

After selecting a workstream, classify the request relationship:

| Relationship | Operation |
| --- | --- |
| Existing acceptance requires the work | Continue current or activate exact queued request |
| Same outcome, changed contract | Amend and continue |
| Independent outcome in the same project | Create a request |
| Different long-lived owner | Create a workstream and `R-0001` |
| Evidence conflicts | Clarify |

The model-facing typed choices are:

```text
continue_current
activate_existing
resume_blocked
amend_current
create_and_activate
create_queued
defer_current_and_activate_existing
defer_current_and_create
create_workstream
clarify
read_only
```

The model supplies semantic intent and a human-readable reason. Deterministic
runtime code verifies exact identities, current states, evidence references,
resource ownership, repository state, the transition, the one-active-request
invariant, and immutable run binding.

New-workstream creation deliberately uses a smaller contract than existing
activation:

```text
decision_resolve_create({
  purpose,
  capabilities,
  workspaceTargets: [
    { kind: "file", relativePath: "balcony-herbs.md" }
    // or { kind: "directory", relativePath: "balcony-herbs" }
  ],
  binding: {
    title,
    objective,
    initialRequest: { title, request, acceptance, constraints }
  }
})
```

The model declares what exact file or directory the user wants, relative to
the already projected workspace. It does not repeat `workspaceRoot`, invent a
resource id, choose a creation operation kind, or copy routing evidence. The
runtime validates the relative path, resolves it beneath the configured
workspace, rejects traversal and symbolic-link escape, derives current-run
routing evidence, inspects the exact prospective resource, and then creates
the workstream with `R-0001`. Only those exact targets are bound; the whole
workspace is not.

Existing-workstream activation remains different: the model selects an
observed workstream/request lifecycle operation and exact existing resource
IDs returned by current-run routing. The runtime derives and rechecks paths,
mutable ownership, repository HEAD, and evidence. Those selected IDs ground
activation; they are not the complete permission list. After activation, the
runtime derives usable mutation roots from every authoritative workstream
binding with `access: mutate`, an absolute filesystem locator, and
availability other than `missing` or `deleted`. Explicit narrower user scope
for the current turn still wins. This distinction lets creation name a path
that does not exist yet without weakening activation authority.

Routing lifecycle changes are journaled as a provisional plan before
execution. The current run sees the projected post-route request context, but
the request and workstream files are committed only during finalization.
New-workstream identities are likewise provisional: restart recovery removes
an unbound, uncommitted allocation, while preserving a provisional workstream
with an immutable run binding for finalization recovery.

## WorkState and activation context

A fresh WorkState is created for every run. A later continuation does not
reuse the previous live object. It deterministically restores only a compact
material handoff into a new `in_progress` WorkState.

After binding, activation loads:

- the distilled workstream card;
- the selected request contract;
- at most five newest progress projections for that request;
- the workstream's authoritative resource bindings;
- any provisional lifecycle plan.

The next primary-model decision receives a bounded
`context.run.boundWorkstream` projection built from that activation state. Its
`request` is always the exact request selected by the immutable run binding,
not an older workstream current request. If another request is active, only
its identity, title, and active status appear as `activeRequest`. The
projection includes distilled purpose, summary, focus, blockers, next action,
at most five newest progress summaries for the selected request, and at most
ten resource metadata records. Selected-request resources, primary resources,
mutable resources, available resources, and recently used resources receive
deterministic priority. Each projected resource contains only stable identity,
display metadata, public locator, role, declared access, availability, primary
status, and selected-request relevance. `otherResourceCount` reports how many
bindings were omitted.

Projection fails closed when the route, loaded workstream, selected request,
or persisted run binding disagree. The selected request contract keeps every
acceptance criterion and constraint. Descriptive workstream/progress fields
and resource metadata are size-bounded; resource contents, version hashes,
commit SHAs, raw logs, all request files, and complete historical progress
remain outside the prompt. Projected metadata is navigation and selection
context, not proof of current file contents and not an independent permission
grant.

Older progress, completed requests, commits, resources, and exact run evidence
remain searchable on demand. Request FTS contributes matching request
identities and lifecycle states—including `done` and `dropped`—to workstream
discovery. A read-only open can then name the exact request id and load its
contract, final outcome, and at most five newest progress entries without
binding or reopening it. SQLite routing does not load every Markdown file or
the full project history into every model request.

## Durable Markdown contracts

`workstream.md` uses `ayati.workstream/v3` and owns:

- identity, title, aliases, and lifecycle state;
- current request identity;
- purpose and current state;
- durable findings and decisions;
- current focus, questions, blockers, and next action.

It remains compact. Temporary retries, raw logs, and the chronological run
history do not belong there.

Each request file uses `ayati.request/v3` and owns:

- request and workstream identity;
- lifecycle state and source;
- created, updated, started, and closed timestamps;
- exact requested outcome;
- acceptance criteria and constraints;
- lifecycle note and final outcome.

The filename slug assigned at creation is stable even if the title is later
amended. The request id is authoritative.

Request files are rewritten only for creation, amendment, a lifecycle
transition, or a final outcome. An ordinary incomplete, failed, retry,
read-only, or partial-progress run leaves the request file byte-identical.

`progress.md` starts with `# Progress` and receives exactly one canonical entry
for every finalized bound run. Each entry includes run/request identity,
outcome, summary, work completed, verified mutations, validation, findings and
decisions, problems, and next action.

Progress rules:

- entries are append-only;
- one run id appears exactly once;
- failed, incomplete, blocked, read-only, and no-deliverable-change runs are
  recorded;
- fields and lists are bounded;
- raw tool/provider output remains in SQLite;
- the parser rejects duplicate run ids and noncanonical content.

`resources.json` is regenerated from the resource catalog and contains each
stable resource identity once, including its locator, role, access, aliases,
request relationships, version, and availability. It is not manually edited.

## Resources and filesystem mutation

The resource catalog is the shared identity layer for agent streams and
workstreams. A resource has a stable `RES-*` identity, kind, origin, real
locator, display metadata, availability and version observations, and
workstream/request relationships. Resources are useful in both directions:

```text
workstream -> resources needed for continuation
resource -> workstreams that own or reference it
```

Ingress attachments are admitted before routing. Uploaded bytes are copied
once into content-addressed immutable storage; referenced files remain at
their canonical path.

Binding establishes durable task ownership. New-workstream creation grants
only its exact resolved output targets. Existing-workstream activation mounts
all distinct usable absolute filesystem bindings already declared
`access: mutate`; it never upgrades `read`, `missing`, or `deleted` bindings.
An explicit narrower user boundary for the current turn filters that mounted
set.

For `create_directory`, `write_files`, `patch_files`, `copy`, `move`, `delete`,
and `set_permissions`, the runtime then selects one destination root for each
call. Every target in that call must remain inside the root; a copy source may
be read-only elsewhere. Relative paths resolve once beneath
`context.run.workspaceRoot`, while absolute paths must already be inside the
selected root. The executor canonicalizes and rechecks the target against the
runtime-derived root before mutation, so prompt metadata alone cannot
authorize a call.

A new workstream may have no resources. Missing output paths are not
pre-registered merely to manufacture permission. The executor observes only
the declared targets, runs the tool, and verifies status-specific existence,
kind, content, identity, mode, created-parent, and cleanup effects. Broader
process, Python, database, and legacy resource operations retain the stronger
resource-scoped preparation journal.

Finalization admits independently verified filesystem effects even when the
larger run is incomplete or failed. Lifecycle is deterministic:

- create registers a resource or restores a tombstone;
- modify and permission changes preserve resource identity;
- move preserves identity, changes the locator, and retains the former locator
  for search;
- copy creates a separate destination identity;
- delete preserves a searchable `deleted` tombstone.

Semantic metadata is explicitly `fallback`, `enriched`, or `stale`. The model
may propose bounded display metadata only for exact validation-backed outputs;
the runtime owns identity, kind, locator, version, availability, and lifecycle.
`resources.json` remains a generated projection of that catalog.

## SQLite V9 responsibilities

SQLite is optimized for operational coordination, bounded projection, and
search:

- `workstream_repository_state` stores the one shared repository path, branch,
  global HEAD, health, and update time.
- `workstreams` stores lifecycle, aliases, snapshot, focus, blockers, current
  request, last run, path-specific last commit, and activity times.
- `workstream_requests` stores every request's lifecycle projection, contract
  hash, timestamps, outcome summary, and stable relative path.
- `workstream_progress` stores a compact searchable projection of each
  progress entry.
- request and workstream FTS indexes cover titles, aliases, every request
  lifecycle status, contract and outcome, findings, resources, and recent
  progress. Request FTS results feed workstream discovery instead of being
  write-only metadata.
- run, mutation, route-plan, idempotency, and finalization tables retain
  detailed operational truth and recovery state.

SQLite is not a second manually authored Markdown notebook. Its workstream,
request, resource, progress, and search projections can be rebuilt from the
validated shared repository and finalization records.

The global repository HEAD and a workstream's last commit are different:

```text
commit changes W-0002
-> shared repository HEAD changes
-> W-0002 last_commit_sha changes
-> W-0001 last_commit_sha stays unchanged
```

Path-specific validation uses Git history for the exact `W-*` directory, so an
unrelated workstream commit never makes another workstream stale.

## Finalization

Every bound run uses one journaled finalization:

1. verify immutable run/workstream/request binding and deterministic mutation
   evidence, then apply verified filesystem lifecycle effects;
2. finalize the run-local WorkState;
3. determine request lifecycle effect separately from run outcome;
4. apply any provisional route plan;
5. render changed request files only when required;
6. append one unique progress entry;
7. reduce durable current knowledge into `workstream.md`;
8. regenerate affected resource manifests;
9. persist the complete desired-write and commit plan in SQLite;
10. recheck shared repository health and path-specific revisions;
11. atomically write and stage only exact managed paths;
12. create and verify one commit with workstream, request, run, outcome, and
    mutation trailers;
13. update global repository state and affected SQLite projections;
14. mark the route plan, finalization, and run complete;
15. release the terminal response.

Because `progress.md` always changes, every finalized bound run creates exactly
one shared-repository commit even when no deliverable changed. Unbound
conversation runs do not create workstream progress or a context commit.

Request completion requires accepted completion evidence that represents every
acceptance criterion in `request.md`, no missing criteria or failures, verified
required resources, and passed deterministic validation unless the declared
criterion requires explicit user acceptance.

## Recovery

Git and SQLite cannot share one physical transaction. The finalization journal
bridges that boundary with the run id:

Selected-root filesystem calls use bounded target-local verification persisted
with their run steps instead of a pre-created resource lease or whole-project
snapshot. Resource-scoped operations continue using their mutation journals.

- before a Git commit, recovery accepts only journal-listed paths whose
  content is the recorded before-state or desired-state, removes only matching
  abandoned atomic temp files, and finishes the exact plan;
- after a Git commit but before SQLite acknowledgement, recovery finds and
  verifies the `Ayati-Run` trailer, then finishes projection without another
  commit;
- duplicate progress append and duplicate run commit are rejected;
- unexpected repository changes mark recovery required and are preserved.

The terminal assistant response is never reported as successfully finalized
until the durable Git and SQLite acknowledgement succeeds.

## Migration and rebuild

The preview-first migration command converts the former nested-repository
layout:

```bash
pnpm context:workstream-migrate
pnpm context:workstream-migrate -- --confirm
```

Run it only with the daemon stopped. Preview validates every nested repository,
committed path, request relationship, progress entry, and resource manifest.
If a pre-progress repository has no `progress.md`, migration creates the
canonical empty baseline ledger; an existing ledger is always parsed and
preserved.
Confirmation creates a temporary shared repository and V9 database, validates
both, atomically switches the workstream root, archives the old nested
repositories and prior database/WAL/SHM, and records manifests. Invalid or
dirty repositories are refused without discarding their contents.

`context:catalog-rebuild` reconstructs an empty V9 workstream catalog from the
already shared repository. `context:archive-reset` remains the deliberate
clean-reset path for unsupported database state.

## Primary source paths

- `ayati-context-engine/src/contracts.ts`
- `ayati-context-engine/src/database/schema.ts`
- `ayati-context-engine/src/repositories/workstream-*-records.ts`
- `ayati-context-engine/src/workstreams/`
- `ayati-context-engine/src/services/workstream-lifecycle-service.ts`
- `ayati-context-engine/src/services/workstream-request-routing-service.ts`
- `ayati-context-engine/src/services/workstream-discovery-service.ts`
- `ayati-context-engine/src/services/workstream-finalization-service.ts`
- `ayati-context-engine/src/services/workstream-catalog-rebuild-service.ts`
- `ayati-context-engine/src/services/workstream-shared-repository-migration.ts`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-main/src/ivec/agent-runner/deterministic-resolve.ts`
- `ayati-main/src/ivec/workstream-binding/`
- `ayati-main/src/skills/builtins/git-context/`
