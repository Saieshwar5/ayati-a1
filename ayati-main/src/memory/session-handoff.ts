import type { RunLedgerEvent, TaskSummaryEvent } from "./session-events.js";
import { formatConversationTurnSpeaker } from "./conversation-turn-format.js";
import { InMemorySession } from "./session.js";
import type {
  PromptRunLedger,
  PromptTaskSummary,
  SessionHandoffArtifact,
  SessionHandoffSnapshot,
  SessionRotationReason,
} from "./types.js";

const MAX_COMPLETED_ITEMS = 4;
const MAX_PENDING_ITEMS = 4;
const MAX_FACT_ITEMS = 5;
const MAX_DIALOG_TURNS = 6;
const MAX_RECENT_RUNS = 5;
const MAX_SUMMARY_CHARS = 1800;

export interface BuildSessionHandoffInput {
  timezone: string;
  reason?: SessionRotationReason | null;
  preparedAt: string;
}

export function buildSessionHandoff(
  session: InMemorySession,
  input: BuildSessionHandoffInput,
): SessionHandoffArtifact {
  const recentRuns = session.getRecentUniqueRunLedgerEvents(MAX_RECENT_RUNS).map(toPromptRunLedger);
  const recentTasks = session.getRecentTaskSummaryEvents(MAX_RECENT_RUNS).map(toPromptTaskSummary);
  const recentDialog = session.getConversationTurns(MAX_DIALOG_TURNS);
  const activeAttachments = session.getActiveAttachmentRefs(5);
  const activeGoals = inferActiveGoals(session, recentTasks, recentRuns);
  const completedWork = inferCompletedWork(recentTasks, recentRuns);
  const pendingWork = inferPendingWork(recentTasks, activeAttachments, recentRuns);
  const keyFacts = inferKeyFacts(session, recentTasks, activeAttachments, recentRuns);
  const nextAction = inferNextAction(recentTasks, pendingWork, recentRuns);

  const snapshot: SessionHandoffSnapshot = {
    sessionId: session.id,
    parentSessionId: session.parentSessionId,
    timezone: input.timezone,
    reason: input.reason ?? session.pendingRotationReason,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    activeGoals,
    completedWork,
    pendingWork,
    keyFacts,
    activeAttachments,
    recentRuns,
    recentTasks,
    recentDialog,
    nextAction,
  };

  return {
    summary: renderHandoffSummary(snapshot, session.handoffSummary),
    snapshot,
    preparedAt: input.preparedAt,
    revision: session.timeline.length,
  };
}

function inferActiveGoals(
  session: InMemorySession,
  recentTasks: PromptTaskSummary[],
  recentRuns: PromptRunLedger[],
): string[] {
  const goals = new Set<string>();

  for (const task of recentTasks) {
    if (task.objective?.trim()) {
      goals.add(truncateInline(task.objective, 180));
    }
    if (goals.size >= 3) {
      return [...goals];
    }
  }

  const recentUserTurns = session
    .getConversationTurns()
    .filter((turn) => turn.role === "user")
    .slice(-2);

  for (const turn of recentUserTurns) {
    goals.add(truncateInline(turn.content, 180));
  }

  for (const run of recentRuns) {
    if (run.summary && run.summary.trim().length > 0) {
      goals.add(truncateInline(run.summary, 180));
    }
    if (goals.size >= 3) {
      break;
    }
  }

  return [...goals].filter(Boolean);
}

function inferCompletedWork(recentTasks: PromptTaskSummary[], recentRuns: PromptRunLedger[]): string[] {
  const completed = new Set<string>();

  for (const task of recentTasks) {
    if (task.taskStatus !== "done" || task.summary.trim().length === 0) {
      continue;
    }
    completed.add(truncateInline(task.summary, 220));
    if (completed.size >= MAX_COMPLETED_ITEMS) {
      break;
    }
  }

  if (completed.size === 0) {
    for (const run of recentRuns) {
      if (run.status !== "completed" || !run.summary?.trim()) {
        continue;
      }
      completed.add(truncateInline(run.summary, 220));
      if (completed.size >= MAX_COMPLETED_ITEMS) {
        break;
      }
    }
  }

  return [...completed];
}

function inferPendingWork(
  recentTasks: PromptTaskSummary[],
  activeAttachments: SessionHandoffSnapshot["activeAttachments"],
  recentRuns: PromptRunLedger[],
): string[] {
  const pending = new Set<string>();

  for (const task of recentTasks) {
    if (task.taskStatus === "done") {
      continue;
    }
    if (task.userInputNeeded?.trim()) {
      pending.add(`Await user input: ${truncateInline(task.userInputNeeded, 180)}`);
    }
    for (const openItem of task.openWork.slice(0, 2)) {
      pending.add(truncateInline(openItem, 220));
      if (pending.size >= MAX_PENDING_ITEMS) {
        return [...pending];
      }
    }
    for (const blocker of task.blockers.slice(0, 2)) {
      pending.add(`Blocked: ${truncateInline(blocker, 180)}`);
      if (pending.size >= MAX_PENDING_ITEMS) {
        return [...pending];
      }
    }
    if (task.summary.trim().length > 0) {
      pending.add(truncateInline(task.summary, 220));
    }
    if (pending.size >= MAX_PENDING_ITEMS) {
      return [...pending];
    }
  }

  if (activeAttachments.length > 0) {
    pending.add(`Continue with active artifacts: ${activeAttachments.map((item) => item.displayName).join(", ")}`);
  }

  const latestRun = recentRuns[0];
  if (latestRun?.summary?.trim()) {
    pending.add(`Continue from latest run: ${truncateInline(latestRun.summary, 220)}`);
  }

  return [...pending].slice(0, MAX_PENDING_ITEMS);
}

function inferKeyFacts(
  session: InMemorySession,
  recentTasks: PromptTaskSummary[],
  activeAttachments: SessionHandoffSnapshot["activeAttachments"],
  recentRuns: PromptRunLedger[],
): string[] {
  const facts = new Set<string>();

  if (session.handoffSummary?.trim()) {
    facts.add(`Previous session continuity: ${truncateInline(session.handoffSummary, 220)}`);
  }

  if (activeAttachments.length > 0) {
    facts.add(`Attachments in use: ${activeAttachments.map((item) => item.displayName).join(", ")}`);
  }

  for (const task of recentTasks) {
    for (const fact of task.keyFacts.slice(0, 2)) {
      facts.add(`Task fact: ${truncateInline(fact, 180)}`);
      if (facts.size >= MAX_FACT_ITEMS) {
        return [...facts];
      }
    }
  }

  for (const activity of session.getRecentSystemActivity(3)) {
    facts.add(`Recent system activity: ${truncateInline(activity.summary, 180)}`);
    if (facts.size >= MAX_FACT_ITEMS) {
      return [...facts];
    }
  }

  for (const run of recentRuns) {
    if (!run.summary?.trim()) continue;
    facts.add(`Recent run outcome: ${truncateInline(run.summary, 180)}`);
    if (facts.size >= MAX_FACT_ITEMS) {
      return [...facts];
    }
  }

  return [...facts].slice(0, MAX_FACT_ITEMS);
}

function inferNextAction(
  recentTasks: PromptTaskSummary[],
  pendingWork: string[],
  recentRuns: PromptRunLedger[],
): string {
  for (const task of recentTasks) {
    if (task.nextAction?.trim()) {
      return truncateInline(task.nextAction, 180);
    }
    if (task.userInputNeeded?.trim()) {
      return `Wait for user input: ${truncateInline(task.userInputNeeded, 180)}`;
    }
    if (task.openWork.length > 0) {
      return task.openWork[0] ?? "Resume the active task from the latest task summary.";
    }
    if (task.blockers.length > 0) {
      return `Resolve blocker: ${truncateInline(task.blockers[0] ?? "", 180)}`;
    }
  }

  if (pendingWork.length > 0) {
    return pendingWork[0] ?? "Resume the active work from the latest run state.";
  }

  const latestRun = recentRuns[0];
  if (latestRun?.summary?.trim()) {
    return `Resume from the latest run summary: ${truncateInline(latestRun.summary, 180)}`;
  }

  return "Resume from the latest conversation turn and continue the same thread.";
}

function renderHandoffSummary(snapshot: SessionHandoffSnapshot, inheritedSummary: string | null): string {
  const lines: string[] = [];
  const reasonText = snapshot.reason ? `Rotation reason: ${snapshot.reason}.` : "Rotation reason: continuity handoff.";
  lines.push(`${reasonText} Timezone: ${snapshot.timezone}.`);

  if (snapshot.activeGoals.length > 0) {
    lines.push("");
    lines.push("Active goals:");
    for (const item of snapshot.activeGoals) {
      lines.push(`- ${item}`);
    }
  }

  if (snapshot.completedWork.length > 0) {
    lines.push("");
    lines.push("Completed work:");
    for (const item of snapshot.completedWork) {
      lines.push(`- ${item}`);
    }
  }

  if (snapshot.pendingWork.length > 0) {
    lines.push("");
    lines.push("Pending work:");
    for (const item of snapshot.pendingWork) {
      lines.push(`- ${item}`);
    }
  }

  if (snapshot.keyFacts.length > 0) {
    lines.push("");
    lines.push("Important facts:");
    for (const item of snapshot.keyFacts) {
      lines.push(`- ${item}`);
    }
  }

  if (snapshot.recentDialog.length > 0) {
    lines.push("");
    lines.push("Recent dialog:");
    for (const turn of snapshot.recentDialog) {
      lines.push(`- ${formatConversationTurnSpeaker(turn)}: ${truncateInline(turn.content, 180)}`);
    }
  }

  lines.push("");
  lines.push(`Next action: ${snapshot.nextAction}`);

  if (inheritedSummary?.trim()) {
    lines.push("");
    lines.push(`Earlier continuity: ${truncateInline(inheritedSummary, 220)}`);
  }

  return lines.join("\n").slice(0, MAX_SUMMARY_CHARS);
}

function toPromptTaskSummary(event: TaskSummaryEvent): PromptTaskSummary {
  return {
    timestamp: event.ts,
    runId: event.runId,
    runPath: event.runPath,
    runStatus: event.status,
    taskStatus: inferTaskStatus(event),
    objective: event.objective,
    summary: event.summary,
    progressSummary: event.progressSummary,
    currentFocus: event.currentFocus,
    completedMilestones: event.completedMilestones ?? [],
    openWork: event.openWork ?? [],
    blockers: event.blockers ?? [],
    keyFacts: event.keyFacts ?? [],
    evidence: event.evidence ?? [],
    userInputNeeded: event.userInputNeeded,
    workMode: event.workMode,
    userMessage: event.userMessage,
    assistantResponse: event.assistantResponse,
    approach: event.approach,
    sessionContextSummary: event.sessionContextSummary,
    dependentTaskRunId: event.dependentTaskRunId,
    assistantResponseKind: event.assistantResponseKind,
    feedbackKind: event.feedbackKind,
    feedbackLabel: event.feedbackLabel,
    actionType: event.actionType,
    entityHints: event.entityHints ?? [],
    goalDoneWhen: event.goalDoneWhen ?? [],
    goalRequiredEvidence: event.goalRequiredEvidence ?? [],
    nextAction: event.nextAction,
    stopReason: event.stopReason,
    attachmentNames: event.attachmentNames ?? [],
  };
}

function toPromptRunLedger(event: RunLedgerEvent): PromptRunLedger {
  return {
    timestamp: event.ts,
    runId: event.runId,
    runPath: event.runPath,
    state: event.state,
    status: event.status,
    summary: event.summary,
  };
}

function truncateInline(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function inferTaskStatus(event: TaskSummaryEvent): PromptTaskSummary["taskStatus"] {
  if (event.taskStatus) {
    return event.taskStatus;
  }
  if (event.userInputNeeded?.trim()) {
    return "needs_user_input";
  }
  if ((event.blockers ?? []).length > 0) {
    return "blocked";
  }
  if (event.status === "completed") {
    return "done";
  }
  return "not_done";
}
