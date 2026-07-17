# Planning Conversation

This file preserves the direction that produced the Simple Task Repository V1
plan. The normative decisions are in `decisions.md`; this file records intent
and reasoning so future agents do not lose the user's underlying goal.

## 2026-07-17: User's Initial Direction

The user asked to make Ayati substantially simpler and more reliable instead
of trying to build an agent that does everything immediately.

Original user message:

> lets make my ai agent much more simpler and reliable . I dont want to build a ai agent which do everything as of now , lets keep it simple. my ai agent shouuld use git as a context engine to work on task . all the tasks should stay in one directory . each task is a indipendent git reposiroty . my ai agent can read any task repository any any time  . when it wants to work or mutate any task then it needs to keep it as that task as a sub module for the session and do the changes in the task repo and commit it . each task directory should have few sub folders which have some responsibillllllllity , the first folder should be public , here we keep all the user attachemtns and reference file and folder that user attached or mentioned . we do not need to track this folder , next is a folder where user gives new features or nes suggestions or new implimantions . we keep them in that file . we need to standardise it . next is task.md file . like that we need to create some task directory or repo with some imporatnt direcotires and file times which will have some important responsiblity in the task . this extra files and folder should help ai agent to continue, itreate , follow, update , move further of task . it shoudl help as a context . we are going to use this ai agent as a learning , coding , computer use, automation kind of work . we should build a task repo which hanldes this kind of work much easy way. I gave some random and rouhg idea to you think about whaat i want from you . think deep what i want  understand i am expecting. comeup with better solution and suggestion . do not my plan too serious, just gave you and idea of what i want , you can think in your perspecite and give me indipeant solutions . my requirments are simple my ai agent can work on compuet use , coding , all kind of data anlysis , autoamtion , learnigning any thing , and many more similar to them with simple context system where user can continure his tasks , open close with out thinking too much about the session managemnt or context managemtn . first we should work on making the task as much better then we should thinkabout how to search or activate and dicover a task . keep it simple how to make task as much better so that it will become easy to create , conitnure , reopen , update  on a praticular task . for example i am learnign machien learngin then it is not going to done in a single task run and single day so it should opne in a multiple days and multiple tsk runs to finifh it  and moreover agent dont knwo when it is going to be done . same thing  with website it may be build in a single task run but there is going to imporvement , update and new features can be added over the preiod of time so if my ai agent cannot findout and retrivve the task it worked and it didnt know what it done then it will become difficlut . for that  iwant to build simpel system as of now . so help in that

Important intent extracted from this message:

- Reliability and simplicity are more important than maximum breadth.
- Git should be the durable context engine for task work.
- All tasks should be understandable as independent repositories under one
  place.
- The agent should read old tasks freely and mutate only after resolving the
  correct task.
- Task repositories need standardized context that makes multi-day continuation
  natural.
- User attachments/references and new feature/suggestion inputs need clear
  homes and responsibilities.
- The same foundation must work for learning, coding, computer use, analysis,
  and automation.
- Users should not manage sessions or context explicitly.
- Task quality should be solved before task search, discovery, and activation.
- The user's proposed layout and submodule mechanism were ideas, not rigid
  requirements; independent improvement was explicitly invited.

## 2026-07-17: Repository And Architecture Review

The assistant inspected:

- stable product and engineering docs
- current harness and context/memory architecture
- earlier git-native and task lifecycle plans
- current independent Git Context Engine code
- task descriptor, context reader, task-state commit, bare repository,
  working-directory, submodule, mutation, and finalization paths

The review found that Ayati already had useful pieces:

- independent task repositories
- `.ayati/task.md`
- commit-based task state
- read-first runs
- deterministic mutation verification
- stable task working directories

It also found unnecessary combined complexity:

- one task represented by a bare repository, stable working clone, and session
  submodule checkout
- task durability coupled to cross-repository finalization and session gitlinks
- old and new task-storage models both described in stable docs
- a task descriptor that did not yet serve as a complete living continuation
  card
- task, request, and run meanings/statuses not cleanly separated

## 2026-07-17: Assistant's Independent Recommendation

The assistant proposed this corrected mental model:

```text
task repository = durable workstream
request = bounded piece of desired work
run = one agent execution
commit = verified result of a mutating run
session = temporary runtime/conversation detail
```

The key reasoning was that the user's examples are long-lived workstreams, not
finite one-shot tasks. A machine-learning journey may contain many lessons. A
website may contain its initial build and years of later improvements. Marking
the entire repository permanently done is unnatural, while creating a new
repository for every feature destroys continuity.

The assistant recommended:

- one normal non-bare repository under one managed task root
- no normal bare mirror or session submodule
- `.ayati/task.md` as the short living current task card
- `.ayati/requests/` for features, lessons, changes, suggestions, and analyses
- `.ayati/references.md` for durable input provenance
- ignored `.ayati/inbox/` for local attachment bytes
- avoiding root `public/` because application frameworks use it for deployable
  assets
- domain-native task files outside `.ayati/`
- reading any task without activation or locks
- locking and expected-HEAD validation only before mutation
- deterministic verification and one final task commit per mutating run
- no task commit for a harmless read-only run
- conservative recovery that never silently resets unknown work
- session journals storing task ID and before/after commits rather than native
  submodule pointers
- task statuses `active`, `paused`, and `archived`
- request statuses `queued`, `active`, `blocked`, `done`, and `dropped`
- discovery and search deferred until task creation/continuation is excellent

The assistant also recommended preserving the existing harness and keeping
personal memory separate.

## 2026-07-17: User Acceptance

Original user message:

> I love your idea complitly, I agrre each decison that you gave . every bit of suggestion is good so lets go and create the plan with full deatils  in agent-notes . like i said i agrre with your every suggestion so do not miss anything in that plan . lets prepare the ai agent to impliment this .

This acceptance makes every recommendation listed above the agreed direction
for the plan. The user explicitly requested complete implementation preparation
inside `agent-notes` and asked that no accepted detail be omitted.

## Planning Result

The result is this plan directory:

```text
agent-notes/simple-task-repository-v1-2026-07-17/
```

It expands the accepted design into repository schemas, lifecycles, examples,
implementation phases, migration safety, testing, decisions, and progress
gates. No runtime behavior was changed while preparing the plan.
