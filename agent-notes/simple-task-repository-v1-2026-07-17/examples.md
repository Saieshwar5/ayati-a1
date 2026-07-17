# Example Task Repositories

These examples are acceptance fixtures, not mandatory domain templates. They
prove that only `.ayati/` needs a universal structure.

## Learning: Machine Learning

```text
T-20260717-0001-learn-machine-learning/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-learn-linear-regression.md
      R-0002-practice-logistic-regression.md
    references.md
    inbox/
      .gitkeep
      REF-0001-housing-data.csv       ignored
  notes/
    linear-regression.md
  exercises/
    linear-regression.py
  notebooks/
    classification.ipynb
```

Task card snapshot:

```markdown
---
schema: ayati.task/v1
id: T-20260717-0001
title: Learn machine learning
status: active
current_request: R-0002
---

# Learn machine learning

## Purpose

Build practical machine-learning understanding through explanations,
implementations, exercises, and small projects.

## Current snapshot

Linear regression concepts, loss calculation, and a NumPy implementation are
complete and verified.

## Current focus

Learn and practice binary logistic regression.

## Blockers

None.

## Important paths

- `notes/linear-regression.md` - current concept notes
- `exercises/linear-regression.py` - verified implementation
- `notebooks/classification.ipynb` - active classification work

## Working agreements

- Begin with practical intuition, then explain the mathematics.
- Implement fundamentals before using high-level frameworks.
```

Why it works:

- The learning journey remains one task.
- Every topic can become a bounded request.
- Notes and exercises are normal tracked deliverables.
- Progress is recovered without replaying entire teaching conversations.

## Coding: Coffee Website

```text
T-20260717-0002-coffee-website/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-build-initial-site.md
      R-0002-add-reservations.md
    references.md
    inbox/
      .gitkeep
      REF-0001-brand-guide.pdf         ignored
      REF-0002-logo.png                ignored
  package.json
  src/
  public/
  tests/
  README.md
```

This example shows why user inputs should not use a root `public/` convention.
The application legitimately owns `public/`, while private inputs remain in
`.ayati/inbox/`.

After the initial site request is complete, the repository remains the same
task. Reservations, accessibility, analytics, and redesigns become later
requests and commits.

## Data Analysis: Sales Investigation

```text
T-20260718-0001-sales-analysis/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-find-revenue-decline.md
      R-0002-segment-by-region.md
    references.md
    inbox/
      .gitkeep
      REF-0001-sales-export.csv         ignored
  notebooks/
    exploration.ipynb
  src/
    clean_data.py
    metrics.py
  reports/
    revenue-decline.md
  tests/
    test_metrics.py
```

The raw export can remain ignored while the checksum and provenance are
tracked. Reproducible transformation code and the resulting report are tracked.
If the raw dataset must become portable, an explicit adoption or future
content-store policy handles it.

## Automation: Invoice Processing

```text
T-20260718-0002-invoice-automation/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-extract-invoice-fields.md
      R-0002-add-duplicate-detection.md
    references.md
    inbox/
      .gitkeep
      REF-0001-sample-invoice.pdf       ignored
  src/
    extract.ts
    duplicate-detection.ts
  tests/
    fixtures/
    extract.test.ts
  docs/
    operation.md
```

The automation remains one maintained task. Each capability or reliability
improvement is a request. Operational documentation is task-owned context,
while run logs and secrets remain outside Git.

## Computer Use: Manage A Job Search

```text
T-20260718-0003-manage-job-search/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-prepare-application.md
      R-0002-submit-application.md
      R-0003-schedule-interview.md
    references.md
    inbox/
      .gitkeep
      REF-0001-job-description.pdf      ignored
  applications/
    example-company.md
  documents/
    tailored-resume.pdf
  checklists/
    interview-preparation.md
```

The browser, email provider, and calendar remain authoritative for submissions,
messages, and events. After Ayati verifies an external action, the task commit
updates the current request and records useful non-secret identifiers or a safe
receipt in `applications/example-company.md` when appropriate.

If no normal artifact should be stored, the engine creates a context-only
commit updating the task card and request outcome. Reverting that commit does
not claim to retract an application or cancel an external event.

## Read-Only Enquiry Example

User asks:

```text
What did we decide about regularization in my machine-learning task?
```

Ayati:

```text
lists/locates the exact task
-> reads task card and relevant notes/commits
-> answers
-> no request is created
-> no lock is acquired
-> no task commit is created
```

## Incomplete Run Example

User asks to add reservations to the coffee website. Ayati implements the form
and validation but cannot verify email delivery.

Final repository commit contains:

- verified form and validation changes
- request remains `active`
- task card records completed UI work
- blocker/next step states that email delivery still needs configuration and
  testing
- outcome trailer is `incomplete`

The next day Ayati reads the task card, active request, and recent commit and
continues directly.

## New Feature After Completion Example

The initial website request is `done`. Months later the user asks for a gallery.

Ayati does not reopen an old session and does not create another website task.
It creates `R-0003-add-gallery.md` in the same repository, activates it, works,
and commits the verified result.

## Archived Task Example

The user archives an old analysis. It disappears from default active views but
remains readable. If the user supplies a new dataset later, Ayati verifies the
task identity, changes status to `active`, creates a new request, and continues
from the same Git history.
