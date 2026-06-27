import type {
  ContinuityContext,
  PromptSessionEvent,
  SessionWorkContext,
  TaskThreadContext,
} from "../../memory/types.js";
import type { LoopState } from "../types.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import {
  harnessContextFromState,
  type HarnessContext,
} from "../harness-context.js";

const LIMITS = {
  timelineEvents: 12,
  textChars: 500,
  summaryChars: 260,
  memoryChars: 1_200,
};

export type TimelineEvent =
  | {
      kind: "user";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "assistant";
      seq: number;
      timestamp: string;
      content: string;
      responseKind?: string;
      expectsUserResponse?: boolean;
      current?: true;
    }
  | {
      kind: "system_event";
      seq: number;
      timestamp: string;
      source: string;
      event: string;
      summary: string;
      current?: true;
    };

export interface AgentContextPack {
  timeline: TimelineEvent[];
  continuity: ContinuityContext;
  sessionWork: SessionWorkContext;
  taskThreadContext?: TaskThreadContext;
  contextEngine?: ContextEngineMachineContext;
  personalMemorySnapshot?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  const harnessContext = harnessContextFromState(state);
  const sessionContext = new TimelineContextBuilder(state, harnessContext);
  return {
    timeline: sessionContext.timeline(),
    continuity: compactContinuity(harnessContext.continuity),
    sessionWork: compactSessionWork(harnessContext.sessionWork, harnessContext.activeContextStartSeq),
    ...(harnessContext.taskThreadContext ? { taskThreadContext: compactTaskThreadContext(harnessContext.taskThreadContext) } : {}),
    ...(harnessContext.contextEngine ? { contextEngine: harnessContext.contextEngine } : {}),
    ...(harnessContext.personalMemorySnapshot.trim()
      ? { personalMemorySnapshot: truncate(harnessContext.personalMemorySnapshot, LIMITS.memoryChars) }
      : {}),
  };
}

function compactContinuity(continuity: ContinuityContext | undefined): ContinuityContext {
  if (!continuity) {
    return { mode: "new", confidence: 0, reasons: ["no continuity resolver result"] };
  }
  return {
    mode: continuity.mode,
    confidence: Math.round(continuity.confidence * 1000) / 1000,
    reasons: compactList(continuity.reasons, 4, 180),
    ...(continuity.current ? {
      current: {
        activityId: continuity.current.activityId,
        kind: continuity.current.kind,
        title: truncate(continuity.current.title, 120),
        ...(continuity.current.status ? { status: continuity.current.status } : {}),
        ...(continuity.current.summary?.trim() ? { summary: truncate(continuity.current.summary, LIMITS.summaryChars) } : {}),
        ...(continuity.current.userIntent?.trim() ? { userIntent: truncate(continuity.current.userIntent, LIMITS.summaryChars) } : {}),
        ...(continuity.current.goal?.trim() ? { goal: truncate(continuity.current.goal, LIMITS.summaryChars) } : {}),
        ...(continuity.current.objective?.trim() ? { objective: truncate(continuity.current.objective, LIMITS.summaryChars) } : {}),
        assumptions: compactList(continuity.current.assumptions ?? [], 5, 180),
        constraints: compactList(continuity.current.constraints ?? [], 5, 180),
        completedWork: compactList(continuity.current.completedWork ?? [], 5, 180),
        openWork: compactList(continuity.current.openWork, 5, 180),
        blockers: compactList(continuity.current.blockers ?? [], 5, 180),
        ...(continuity.current.nextStep?.trim() ? { nextStep: truncate(continuity.current.nextStep, LIMITS.summaryChars) } : {}),
        verifiedFacts: compactList(continuity.current.verifiedFacts, 10, 180),
        evidence: compactList(continuity.current.evidence ?? [], 8, 180),
        assets: compactList(continuity.current.assets ?? [], 8, 160),
        topAssets: compactList(continuity.current.topAssets, 8, 160),
        ...(continuity.current.lastAssistantResponse?.trim()
          ? { lastAssistantResponse: truncate(continuity.current.lastAssistantResponse, LIMITS.summaryChars) }
          : {}),
        recentRuns: (continuity.current.recentRuns ?? []).slice(-3).map((run) => ({
          runId: run.runId,
          status: run.status,
          ...(run.taskStatus ? { taskStatus: run.taskStatus } : {}),
          summary: truncate(run.summary, LIMITS.summaryChars),
          toolsUsed: compactList(run.toolsUsed, 8, 80),
          createdAt: run.createdAt,
        })),
        discussionRanges: (continuity.current.discussionRanges ?? []).slice(-3),
        lastTouchedAt: continuity.current.lastTouchedAt,
      },
    } : {}),
    ...(continuity.candidates && continuity.candidates.length > 0 ? {
      candidates: continuity.candidates.slice(0, 3).map((candidate) => ({
        activityId: candidate.activityId,
        kind: candidate.kind,
        title: truncate(candidate.title, 120),
        reason: truncate(candidate.reason, 180),
        score: Math.round(candidate.score * 1000) / 1000,
        topAssets: compactList(candidate.topAssets, 5, 160),
        lastTouchedAt: candidate.lastTouchedAt,
      })),
    } : {}),
  };
}

function compactTaskThreadContext(context: TaskThreadContext): TaskThreadContext {
  return {
    ...(context.activeTask ? { activeTask: {
      ...context.activeTask,
      summary: context.activeTask.summary ? truncate(context.activeTask.summary, LIMITS.summaryChars) : undefined,
      completedWork: compactList(context.activeTask.completedWork, 5, 180),
      openWork: compactList(context.activeTask.openWork, 6, 180),
      blockers: compactList(context.activeTask.blockers, 4, 180),
      keyFacts: compactList(context.activeTask.keyFacts, 8, 180),
      evidence: compactList(context.activeTask.evidence, 6, 180),
      toolsUsed: compactList(context.activeTask.toolsUsed, 10, 80),
      activityAssets: context.activeTask.activityAssets.slice(0, 8),
      topAssets: compactList(context.activeTask.topAssets, 8, 160),
      runIds: context.activeTask.runIds.slice(-5),
      discussionRanges: context.activeTask.discussionRanges.slice(-3),
      nextAction: context.activeTask.nextAction ? truncate(context.activeTask.nextAction, LIMITS.summaryChars) : undefined,
      lastAssistantQuestion: context.activeTask.lastAssistantQuestion
        ? truncate(context.activeTask.lastAssistantQuestion, LIMITS.summaryChars)
        : undefined,
    } } : {}),
    suspendedTasks: context.suspendedTasks.slice(0, 5).map((task) => ({
      ...task,
      summary: task.summary ? truncate(task.summary, LIMITS.summaryChars) : undefined,
      completedWork: compactList(task.completedWork, 3, 160),
      openWork: compactList(task.openWork, 4, 160),
      blockers: compactList(task.blockers, 3, 160),
      keyFacts: compactList(task.keyFacts, 4, 160),
      evidence: compactList(task.evidence, 3, 160),
      toolsUsed: compactList(task.toolsUsed, 8, 80),
      activityAssets: task.activityAssets.slice(0, 5),
      topAssets: compactList(task.topAssets, 5, 160),
      runIds: task.runIds.slice(-4),
      discussionRanges: task.discussionRanges.slice(-2),
      nextAction: task.nextAction ? truncate(task.nextAction, LIMITS.summaryChars) : undefined,
      lastAssistantQuestion: task.lastAssistantQuestion ? truncate(task.lastAssistantQuestion, LIMITS.summaryChars) : undefined,
    })),
    recentSignals: {
      ...context.recentSignals,
      latestUserMessage: truncate(context.recentSignals.latestUserMessage, LIMITS.textChars),
      mentionedAssetNames: compactList(context.recentSignals.mentionedAssetNames, 6, 120),
      mentionedAssetPaths: compactList(context.recentSignals.mentionedAssetPaths, 6, 160),
    },
    suggestedBinding: {
      ...context.suggestedBinding,
      confidence: context.suggestedBinding.confidence !== undefined
        ? Math.round(context.suggestedBinding.confidence * 1000) / 1000
        : undefined,
      reason: context.suggestedBinding.reason ? truncate(context.suggestedBinding.reason, 180) : undefined,
    },
  };
}

function compactSessionWork(
  sessionWork: SessionWorkContext | undefined,
  activeContextStartSeq: number | undefined,
): SessionWorkContext {
  return {
    activeContextStartSeq: sessionWork?.activeContextStartSeq ?? activeContextStartSeq ?? 1,
    recentActivities: (sessionWork?.recentActivities ?? []).slice(0, 5).map((activity) => ({
      activityId: activity.activityId,
      title: truncate(activity.title, 120),
      ...(activity.status ? { status: activity.status } : {}),
      lastTouchedAt: activity.lastTouchedAt,
      ...(activity.lastTouchedSeq ? { lastTouchedSeq: activity.lastTouchedSeq } : {}),
      openWork: compactList(activity.openWork, 5, 180),
      topAssets: compactList(activity.topAssets, 8, 160),
      workRunIds: (activity.workRunIds ?? []).slice(-5),
    })),
  };
}

class TimelineContextBuilder {
  constructor(
    private readonly state: LoopState,
    private readonly harnessContext: HarnessContext,
  ) {}

  timeline(): TimelineEvent[] {
    const activeStart = Math.max(1, this.harnessContext.activeContextStartSeq || 1);
    const fromSession = this.harnessContext.sessionEvents
      .filter((event) => event.seq >= activeStart)
      .map((event) => this.toTimelineEvent(event))
      .filter((event): event is TimelineEvent => event !== null);
    const withCurrent = this.ensureCurrentEvent(fromSession);
    const current = withCurrent.find((event) => event.current);
    const ordered = [
      ...withCurrent.filter((event) => !event.current).sort((a, b) => a.seq - b.seq),
      ...(current ? [current] : []),
    ];
    return preserveQuestionWhenTrimming(ordered, LIMITS.timelineEvents);
  }

  private toTimelineEvent(event: PromptSessionEvent): TimelineEvent | null {
    const current = event.seq === this.state.currentSeq && (event.type === "user_message" || event.type === "system_event");
    if (event.type === "user_message") {
      return {
        kind: "user",
        seq: event.seq,
        timestamp: event.timestamp,
        content: truncate(event.content, LIMITS.textChars),
        ...(current ? { current: true as const } : {}),
      };
    }
    if (event.type === "assistant_response") {
      return {
        kind: "assistant",
        seq: event.seq,
        timestamp: event.timestamp,
        content: truncate(event.content, LIMITS.textChars),
        ...(event.responseKind ? { responseKind: event.responseKind } : {}),
        ...(assistantExpectsUserResponse(event.responseKind) ? { expectsUserResponse: true } : {}),
      };
    }
    return {
      kind: "system_event",
      seq: event.seq,
      timestamp: event.timestamp,
      source: event.source,
      event: event.event,
      summary: truncate(event.summary, LIMITS.textChars),
      ...(current ? { current: true as const } : {}),
    };
  }

  private ensureCurrentEvent(events: TimelineEvent[]): TimelineEvent[] {
    if (events.some((event) => event.current)) {
      return events;
    }
    const seq = this.state.currentSeq || Math.max(1, ...events.map((event) => event.seq), this.harnessContext.activeContextStartSeq || 1);
    if (this.state.inputKind === "system_event" && this.state.systemEvent) {
      return [
        ...events,
        {
          kind: "system_event",
          seq,
          timestamp: new Date(0).toISOString(),
          source: this.state.systemEvent.source,
          event: this.state.systemEvent.eventName,
          summary: truncate(this.state.systemEvent.summary, LIMITS.textChars),
          current: true,
        },
      ];
    }
    return [
      ...events,
      {
        kind: "user",
        seq,
        timestamp: new Date(0).toISOString(),
        content: truncate(this.state.userMessage, LIMITS.textChars),
        current: true,
      },
    ];
  }
}

function preserveQuestionWhenTrimming(events: TimelineEvent[], limit: number): TimelineEvent[] {
  if (events.length <= limit) {
    return events;
  }
  const current = events.find((event) => event.current);
  const latestQuestion = [...events].reverse().find((event) => event.kind === "assistant" && event.expectsUserResponse);
  const tail = events.slice(-limit);
  for (const required of [latestQuestion, current]) {
    if (!required || tail.some((event) => sameTimelineEvent(event, required))) {
      continue;
    }
    const replaceIndex = tail.findIndex((event) => !event.current && !(event.kind === "assistant" && event.expectsUserResponse));
    if (replaceIndex >= 0) {
      tail[replaceIndex] = required;
    }
  }
  const currentEvent = tail.find((event) => event.current);
  return [
    ...tail.filter((event) => !event.current).sort((a, b) => a.seq - b.seq),
    ...(currentEvent ? [currentEvent] : []),
  ];
}

function sameTimelineEvent(left: TimelineEvent, right: TimelineEvent): boolean {
  return left.seq === right.seq && left.kind === right.kind;
}

function assistantExpectsUserResponse(responseKind: string | undefined): boolean {
  return responseKind === "feedback";
}

function compactList(values: string[], limit: number, maxChars: number): string[] {
  return values.slice(0, limit).map((value) => truncate(value, maxChars)).filter((value) => value.length > 0);
}

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
