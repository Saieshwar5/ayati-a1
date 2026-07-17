# Testing Plan

## Testing Philosophy

The simplification is successful only if it removes lifecycle states and
failure modes without weakening deterministic verification or recovery.

Prefer temporary local Git repositories, deterministic clocks/IDs, and SQLite
test databases. Avoid provider calls and network access in repository tests.

Run the smallest relevant tests first, then package and workspace tests.

## Schema Unit Tests

### Task card

Cover:

- deterministic render/parse round trip
- supported schema and unknown schema
- valid task statuses
- `current_request: none`
- missing required fields and sections
- duplicate frontmatter fields
- invalid task ID
- title length and whitespace normalization
- oversized card and section
- invalid/escaping important paths
- secret-like values in reserved files when scanning is enabled
- preservation or rejection policy for unknown fields

### Request files

Cover:

- deterministic render/parse round trip
- sequential request allocation
- valid status transitions
- forbidden transition without explicit reopen
- at most one active request
- filename/frontmatter ID mismatch
- missing acceptance criteria policy
- source validation
- completed, blocked, dropped, and reopened outcome rendering
- no silent deletion or reuse of request IDs

### References manifest

Cover:

- stable reference ID allocation
- each supported reference kind
- available/missing/changed/unchecked states
- checksum normalization and mismatch
- external absolute path provenance
- task-relative adopted path validation
- shared attachment relationships
- missing inbox bytes
- malformed or oversized entries
- secret-bearing URL rejection/redaction

### Commit metadata

Cover:

- identity commit rendering
- each final run outcome
- each validation state
- optional next/conversation fields
- subject normalization and length
- parse/re-render stability
- duplicate/missing trailer rejection
- run/task/request identity mismatch

## Repository Contract Tests

Create temporary repositories and prove:

- new scaffold has exactly the required standard files
- repository is normal and non-bare
- Git top level equals task path
- initial commit contains scaffold and initial request
- ignored inbox contents do not dirty the repository
- `.gitkeep` remains tracked
- task-specific ignore rules can coexist with the inbox rule
- task ID matches card and catalog
- current request exists and is uniquely active
- archived and paused repositories validate
- tracked inbox bytes are rejected except `.gitkeep`
- symlink task directories are rejected
- nested repositories and task-root path escapes are rejected
- `.git/` and engine-owned `.ayati/` cannot be general mutation targets

## Creation Tests

Cover:

- deterministic task ID allocation by date and sequence
- sanitized directory slug
- two tasks with the same title receive different IDs
- retry with the same request ID returns the same task
- failure before `git init`
- failure after directory creation
- failure after files are written but before commit
- failure after identity commit but before catalog acknowledgement
- ambiguous non-empty target is never deleted
- no bare repository or clone is created
- creation happens only at mutation promotion or explicit task-management
  request

## Read Path Tests

Cover:

- exact task read without active session task
- read active, paused, and archived tasks
- read while another run holds the mutation lock
- committed task card and request projection
- bounded recent commit parsing
- curated important paths instead of every tracked file
- missing important path reported without corrupting identity
- dirty working tree reported separately from committed context
- read from catalog with stale title but current Git card
- missing task directory
- invalid Git repository
- task ID/card mismatch
- unsupported schema
- no write, lock, mount, or commit side effect during reads

## Request Lifecycle Tests

Cover:

- initial request creation with task
- queue a later feature
- activate one queued request
- reject second active request
- continue incomplete request across runs
- block and resume request
- complete request and clear current request
- complete request and activate an already authorized next request
- drop request with reason
- reopen same unfinished intention explicitly
- create new request instead of reopening accepted completed work
- task remains active after request completion
- pause requires no active request
- archive and reopen task

## Mutation Authority Tests

Preserve and adapt current high-privilege coverage:

- expected HEAD match and mismatch
- exclusive task lock
- stale lock recovery rules
- run/task/request binding
- explicit target enforcement
- file and directory targets
- created, modified, deleted, and renamed provenance
- ignored inbox changes excluded from normal provenance
- unexpected paths rejected
- repository root rejected as broad mutation target
- `.git/` rejected
- engine-owned `.ayati/` rejected
- symlink escape, broken symlink, and loop rejection
- head changes between authorization and execution
- failed tool with no changes
- failed tool with verified changes
- failed tool with unexpected partial changes

## Finalization Tests

For each outcome (`completed`, `incomplete`, `blocked`, `failed`), cover:

- verified deliverable changes
- context reducer output
- request transition
- task-card transition
- exact staged paths
- one final commit
- deterministic parent/base relationship
- required commit trailers
- validation metadata accuracy
- no raw tool output in commit message or reserved files
- no push, session submodule update, or session Git commit
- lock release after success
- read-only run creates no task commit
- failed no-change run creates no empty commit
- useful state-only transition creates a non-empty context commit
- unverified path prevents finalization
- concurrent external HEAD advance prevents commit

Assert commit counts directly. A mutating run must not accidentally produce a
checkpoint commit plus a finalization commit.

## Context Reducer Tests

Cover:

- verified completed facts enter current snapshot
- speculative/unverified claims are rejected
- actual validation maps to card/request outcome
- important paths exist in final tree
- removed paths leave the curated list
- blockers are concise and durable
- obsolete snapshot details can be replaced without losing Git history
- size limits and deterministic fallback
- model output cannot directly inject reserved frontmatter
- task status is not derived automatically from run outcome

## Attachment Tests

Cover:

- upload before task routing
- route upload to a new task
- route upload to an existing task
- clarification without losing upload
- atomic ignored inbox placement
- checksum and manifest entry
- same filename collision
- shared attachment linked to two tasks
- missing inbox file on reopen
- changed checksum on reopen
- explicit adoption into tracked task path
- original inbox file remains unchanged during adoption
- cloning task does not falsely report inbox bytes available
- attachment contents never enter normal logs or commit messages

## External Computer-Use Tests

Cover:

- task/request binding before external mutation
- existing approval requirement remains enforced
- verified email/form/calendar/application action
- stable non-secret external identifier extraction
- safe receipt artifact when appropriate
- context-only commit when no ordinary file is appropriate
- inconclusive verification leaves request active/blocked, not done
- failed external action with no durable context creates no empty task commit
- raw screenshots/page dumps/tokens excluded from task Git
- Git revert is never reported as undoing external state
- restart continuation from task card and request outcome

## Crash And Recovery Matrix

Inject failure after every lifecycle boundary:

```text
task allocation
directory creation
Git initialization
scaffold write
identity commit
catalog acknowledgement
lock acquisition
tool start
tool filesystem mutation
verification journal
context rendering
staging
commit creation
run acknowledgement
lock release
```

For each point, restart the service and assert:

- no duplicate task, request, or commit
- no unknown data deletion
- correct ready/recovery state
- correct lock handling
- read-only access remains available where safe
- mutation remains blocked where proof is insufficient

Explicit recovery cases:

- clean at base HEAD
- clean at matching final commit
- dirty with only fully verified paths
- dirty with unverified paths
- index partially staged
- externally advanced HEAD
- missing task directory
- corrupted task card after external edit
- expired lock with live versus absent owner

## Migration Tests

Create fixtures for every migration cohort.

Cover:

- clean managed legacy checkout
- current state derived from task-state commit
- legacy in-progress -> active request
- legacy blocked -> blocked request
- legacy done -> paused task and done request
- legacy `W-*` identity preserved
- working/bare/catalog heads agree
- head divergence blocks migration
- dirty checkout blocks migration
- missing working checkout restored from validated bare repository
- external requested directory requires explicit choice
- migration commit preserves ancestry
- old bare repository remains unchanged/readable
- old session gitlink remains resolvable
- new V1 run does not update old session or bare repository
- idempotent retry after migration commit before catalog update
- no task is writable through both layout services
- dry-run report makes no filesystem or database changes beyond disposable
  telemetry

## Integration Tests

Prove end-to-end flows through the typed Git Context client:

### Learning continuation

```text
create learning task
-> complete first lesson request
-> stop/restart service
-> create next topic request
-> continue from task card and Git history
```

### Website improvement

```text
create and complete initial website request
-> later add feature request in same task
-> mutate and commit once
-> no second website task
```

### Read-only enquiry

```text
active unrelated task exists
-> ask about archived analysis
-> read archived task
-> answer
-> no activation, lock, request, or commit
```

### Data analysis input

```text
attach dataset
-> create analysis task
-> ignored inbox + tracked manifest
-> create reproducible script/report
-> restart and validate availability
```

### Automation blocked run

```text
mutate verified local automation files
-> external credential unavailable
-> commit partial verified work and blocker once
-> resume later in new run
```

### Computer-use external action

```text
prepare application task
-> submit through browser with required approval
-> verify external confirmation identifier
-> update request/task context
-> create one task context commit
-> restart and continue with interview scheduling
```

## App And Harness Tests

Cover:

- every provider-handled turn still starts read-first/session-scoped
- read-only task tools work before task binding
- first mutation promotes/binds same run ID
- task selection resolves task and request
- request completion does not archive task
- paused/archived mutation requires transition
- final response reflects verified task state
- run finalization stores task before/after commit identity
- no normal flow calls task mount/submodule APIs for V1 tasks
- no model-facing low-level commit or reserved-context update tool

Do not weaken existing action verification, tool schema validation, repair
policy, or context pressure behavior.

## Performance Tests

Build at least:

- 1 task with a large realistic tree
- 100 tasks
- 1,000 small task repositories for catalog/read sampling
- 100 requests in one long-lived task
- 1,000 commits in one task

Measure:

- exact task read latency
- catalog list latency
- continuation-context build latency
- mutation preflight/finalization latency
- startup catalog rebuild
- prompt projection size

Normal continuation must remain bounded by the card, one request, recent
commits, and curated paths rather than total repository count/history.

## Security Tests

Cover:

- path traversal in task ID, slug, request filename, and reference path
- task-root symlink and bind-like path surprises where testable
- malicious `.git` indirection
- external path mistaken for mutation ownership
- crafted frontmatter fields
- commit-message control characters
- secret-bearing URL/reference metadata
- tracked private inbox content
- commands attempting to modify reserved context
- task directory nested inside another repository
- repository path replaced during lock acquisition

## Commands

Exact test filenames will be introduced with implementation. Expected command
order:

```bash
pnpm --filter ayati-git-context exec vitest run <focused-test-files>
pnpm --filter ayati-git-context test
pnpm --filter ayati-git-context build
pnpm --filter ayati-main exec vitest run <focused-app-and-harness-tests>
pnpm --filter ayati-main test
pnpm --filter ayati-main build
pnpm test
pnpm build
```

Run full workspace commands for migration/cutover slices because they change
shared contracts and runtime behavior.

## Live Acceptance

After deterministic tests, run one manually inspectable scenario for each
example domain. For every scenario inspect:

- task directory tree
- `.ayati/task.md`
- current and completed requests
- `.ayati/references.md`
- `git status`
- `git log --stat --decorate -10`
- final commit trailers
- SQLite run before/after identities
- absence of a V1 task session submodule
- restart continuation behavior

Do not use live-provider success as a substitute for deterministic lifecycle
tests.
