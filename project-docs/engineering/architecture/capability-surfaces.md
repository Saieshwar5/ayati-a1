# Capability Catalog and Tool Surfaces

Ayati exposes tools through one deterministic capability system:

```text
registered tools
-> explicit capability catalog
-> current mode and authority filter
-> model chooses 1-3 capability ids
-> exact bounded native tool surface
-> ordinary executor policy and verification
```

Capability selection is navigation, not authority. A capability may make a
tool schema visible, but workstream binding, resource access, path containment,
input validation, execution policy, and deterministic verification still
decide whether a call can run and whether it succeeded.

## Canonical Owners

- `capabilities/catalog.ts` owns small named responsibilities, core tools,
  optional tools, allowed destination modes, and deterministic next-capability
  suggestions.
- `capabilities/registry.ts` owns the complete runtime map from exact tool name
  to one executable definition.
- `capabilities/surface-resolver.ts` combines catalog, registry, mode,
  authority, and context pressure into one explicit resolution receipt.
- `capabilities/surface-manager.ts` owns each run's currently mounted native
  tool schemas and replaces that surface atomically.
- `mode-transition-controls.ts` exposes small destination-specific native
  controls whose direct root-object schemas and capability enums match the
  current graph state.
- `tool-taxonomy.ts` owns safety metadata only: purpose, effect, phase,
  lifetime, roles, and authority requirements. It does not select tools.

There is no inferred selector, selection-hint vocabulary, static skill prompt
catalog, global tool directory, or second tool-selection model.

## What the Model Sees

At `ENTRY`, no executable task tool is mounted. The model sees:

- only graph-legal destination-specific mode controls;
- a short card for each capability currently available in those destinations;
- destination-specific capability enums in each native control schema.

The model chooses one to three exact ids. It never reconstructs a tool list
and never asks for a free-form group.

After an accepted transition, the model sees:

- the harness controls legal in the active graph state;
- the exact native schemas for every loaded core tool;
- any optional tools that fit the explicit surface limit;
- a compact receipt for a partial, replaced, unavailable, or already-active
  surface.

Mode behavior:

| Destination | Capability class | Executable surface |
| --- | --- | --- |
| `observe.locate` | discovery, listing, search, routing lookup | read-only locate tools |
| `observe.investigate` | exact reads, inspection, queries, and targetless system observations | read-only evidence tools |
| `resolve` | binding-required mutation responsibility | no lifecycle tools; the deterministic gate binds, then mounts the matching execute surface |
| `execute` | bound mutation, verification, or bound control | only tools permitted by current workstream/resource authority |
| `validation` | final typed task-outcome proof | no executable tools; queries the derived current-run verification index |

A mode change replaces the full earlier surface. Tools do not accumulate
across modes. An authority change that invalidates any active tool clears the
whole surface so a partially authorized capability cannot remain active.

## Catalog Rules

Every capability has:

```text
id
summary
whenToUse
allowedModes
coreTools
optionalTools?
suggestedNext?
authority?
targetRequirement?
```

`targetRequirement: "none"` is reserved for bounded observations that do not
inspect a user resource. The current targetless capabilities are
`system:time` and `system:health`. Every target-backed investigation still
requires an exact verified reference; combining a targetless capability with a
target-backed capability does not remove that requirement.

The catalog constructor rejects:

- duplicate or malformed capability ids;
- empty mode sets, or empty core-tool sets except the validation-only
  `task:validation` proof capability;
- duplicate tools inside one capability;
- targetless capabilities outside `observe.investigate`;
- hidden lifecycle tools;
- mutation tools in observation capabilities;
- resolve capabilities without a binding-required mutation core tool;
- capabilities that mix destructive and non-destructive tools;
- suggestions that reference an unknown capability.

The registry rejects duplicate tool names and tools without safety taxonomy.
Daemon startup additionally rejects:

- catalog tools missing from the registry;
- registered model-facing tools without capability ownership;
- hidden lifecycle tools exposed by a capability.

This makes the catalog and runtime disagree loudly at startup instead of
letting the model discover the mismatch during a user task.

## Core Coverage and Limits

The normal surface limit is eight native executable tools. Under context
pressure it is six.

Core coverage is atomic:

- if every core tool fits, all core tools are loaded;
- if core coverage exceeds the limit, resolution fails with
  `surface_too_large`;
- core tools are never silently sliced;
- optional tools fill remaining capacity in declared order;
- every omitted optional tool is named in the resolution receipt.

The model must choose fewer capabilities after `surface_too_large`. The
runtime never guesses which required operation is expendable.

## Recommendations

`suggestedNext` is a deterministic convenience, not an automatic transition.
For example:

```text
file:search --success--> file:read
file:write  --success--> file:verify
file:write  --failure--> file:read
```

Recommendations are shown only when the destination capability is currently
available. The model still makes the next native transition.

## Adding or Changing a Tool

One change must update all relevant owners:

1. Add the tool definition and schemas.
2. Add its safety taxonomy.
3. Put it in exactly the intended capability as a core or optional tool.
4. Keep hidden lifecycle tools outside every model-facing capability.
5. Add catalog, registry-coverage, surface, mode-schema, and policy tests.
6. Run the focused tests, the full `ayati-main` tests, and the workspace build.

Do not add per-tool selection hints or a second prompt catalog. If a new tool
does not fit an existing responsibility, add one small capability with a clear
mode boundary.
