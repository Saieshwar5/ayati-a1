import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmResponseFormat } from "../core/contracts/llm-protocol.js";
import type {
  ConversationTurn,
  PromptMemoryContext,
  PromptTaskSummary,
  TaskSummaryTaskStatus,
} from "../memory/types.js";
import type { ToolDefinition } from "../skills/types.js";

const MIN_ASK_CONFIDENCE = 0.75;
const MAX_TEXT_CHARS = 1_200;
const MAX_RESPONSE_CHARS = 3_000;
const MAX_RECENT_TASKS = 5;
const MAX_CONVERSATION_TURNS = 8;

const REFLECTION_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_object",
};

const REFLECTION_SYSTEM_PROMPT = [
  "You are Ayati's private Pulse proposal reflection.",
  "Your only job is to decide whether the just-completed task is worth turning into a recurring Pulse task.",
  "",
  "Return JSON only with this shape:",
  "{",
  '  "action": "none" | "ask_user",',
  '  "question": string | null,',
  '  "confidence": number,',
  '  "reason": string',
  "}",
  "",
  "Return ask_user only when a recurring Pulse task would clearly help this specific user.",
  "Ask only for repetitive, routine, time-sensitive, goal-related, changing-over-time, or easy-to-forget work.",
  "The question must sound natural and must include enough action and schedule detail that the next turn can create the Pulse task from conversation context.",
  "Do not propose risky external actions such as buying, trading, posting, sending messages, forwarding, inviting, or publishing.",
  "Do not propose anything if the completed answer already asks the user for clarification, approval, or a decision.",
  "Do not propose anything for casual chat, one-time explanations, failed work, vague value, or missing details.",
  "Do not create or mention any hidden approval state, inbox, ledger, or responsibility storage.",
  "If this task already created, changed, listed, or rejected a Pulse item, return none.",
  `Use ask_user only when confidence is at least ${MIN_ASK_CONFIDENCE}.`,
].join("\n");

export interface PulseProposalReflectionTaskSummary {
  status?: "completed" | "failed" | "stuck";
  taskStatus?: TaskSummaryTaskStatus;
  objective?: string;
  summary?: string;
  progressSummary?: string;
  userInputNeeded?: string;
  assistantResponseKind?: string;
  stopReason?: string;
  actionType?: string;
  entityHints?: string[];
}

export interface PulseProposalReflectionInput {
  provider: LlmProvider;
  currentUserMessage: string;
  assistantResponse: string;
  taskSummary: PulseProposalReflectionTaskSummary;
  memoryContext: PromptMemoryContext;
  toolDefinitions: ToolDefinition[];
  now: Date;
}

export type PulseProposalReflectionResult =
  | {
      action: "none";
      confidence?: number;
      reason?: string;
    }
  | {
      action: "ask_user";
      question: string;
      confidence: number;
      reason: string;
    };

export class PulseProposalReflectionService {
  async reflect(input: PulseProposalReflectionInput): Promise<PulseProposalReflectionResult> {
    if (!shouldRunReflection(input)) {
      return { action: "none", reason: "reflection guard skipped this task" };
    }

    const turn = await input.provider.generateTurn({
      messages: [
        { role: "system", content: REFLECTION_SYSTEM_PROMPT },
        { role: "user", content: buildReflectionUserPrompt(input) },
      ],
      responseFormat: REFLECTION_RESPONSE_FORMAT,
    });

    if (turn.type !== "assistant") {
      return { action: "none", reason: "reflection returned tool calls" };
    }

    return parsePulseProposalReflection(turn.content);
  }
}

export function parsePulseProposalReflection(text: string): PulseProposalReflectionResult {
  const parsed = extractJsonRecord(text);
  const action = parsed["action"];
  const confidence = normalizeConfidence(parsed["confidence"]);
  const reason = normalizeOptionalString(parsed["reason"]);

  if (action !== "ask_user") {
    return {
      action: "none",
      ...(confidence !== undefined ? { confidence } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  const question = normalizeOptionalString(parsed["question"]);
  if (!question || confidence === undefined || confidence < MIN_ASK_CONFIDENCE) {
    return {
      action: "none",
      ...(confidence !== undefined ? { confidence } : {}),
      reason: reason || "ask_user did not meet the confidence or question requirement",
    };
  }

  return {
    action: "ask_user",
    question: normalizeQuestion(question),
    confidence,
    reason: reason || "reflection judged this recurring Pulse task useful",
  };
}

export function appendPulseProposalQuestion(content: string, question: string): string {
  const base = content.trim();
  const cleanQuestion = normalizeQuestion(question);
  if (base.length === 0) {
    return cleanQuestion;
  }
  return `${base}\n\n${cleanQuestion}`;
}

export function shouldRunReflection(input: PulseProposalReflectionInput): boolean {
  if (!hasPulseTool(input.toolDefinitions)) {
    return false;
  }
  if (input.taskSummary.status && input.taskSummary.status !== "completed") {
    return false;
  }
  if (input.taskSummary.taskStatus && !isCompletedTaskStatus(input.taskSummary.taskStatus)) {
    return false;
  }
  if (input.taskSummary.userInputNeeded?.trim()) {
    return false;
  }
  if (input.taskSummary.assistantResponseKind === "feedback") {
    return false;
  }
  if (input.taskSummary.stopReason === "needs_user_input" || input.taskSummary.stopReason === "blocked") {
    return false;
  }
  if (isLikelyPulseApprovalOrDismissal(input.currentUserMessage)) {
    return false;
  }
  if (looksLikePulseManagement(input.currentUserMessage, input.taskSummary.objective, input.assistantResponse)) {
    return false;
  }
  if (looksLikeOpenQuestion(input.assistantResponse)) {
    return false;
  }
  return true;
}

function buildReflectionUserPrompt(input: PulseProposalReflectionInput): string {
  const memoryContext = input.memoryContext;
  const payload = {
    now: input.now.toISOString(),
    currentUserMessage: truncateText(input.currentUserMessage),
    finalAssistantResponse: truncateText(input.assistantResponse, MAX_RESPONSE_CHARS),
    taskSummary: compactReflectionTaskSummary(input.taskSummary),
    recentTaskSummaries: compactRecentTasks(memoryContext.recentTaskSummaries ?? []),
    personalMemorySnapshot: truncateText(memoryContext.personalMemorySnapshot ?? ""),
    previousSessionSummary: truncateText(memoryContext.previousSessionSummary ?? ""),
    recentConversation: compactConversation(memoryContext.conversationTurns ?? []),
    availableCapabilities: summarizeCapabilities(input.toolDefinitions),
  };

  return [
    "Review this completed task and decide whether Ayati should ask the user about turning it into a recurring Pulse task.",
    "If you ask, the question must be self-contained because no pending proposal will be stored.",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");
}

function compactReflectionTaskSummary(summary: PulseProposalReflectionTaskSummary): Record<string, unknown> {
  return {
    status: summary.status,
    taskStatus: summary.taskStatus,
    objective: truncateText(summary.objective ?? ""),
    summary: truncateText(summary.summary ?? ""),
    progressSummary: truncateText(summary.progressSummary ?? ""),
    userInputNeeded: truncateText(summary.userInputNeeded ?? ""),
    assistantResponseKind: summary.assistantResponseKind,
    stopReason: summary.stopReason,
    actionType: summary.actionType,
    entityHints: summary.entityHints?.slice(0, 8),
  };
}

function compactRecentTasks(tasks: PromptTaskSummary[]): Array<Record<string, unknown>> {
  return tasks.slice(0, MAX_RECENT_TASKS).map((task) => ({
    timestamp: task.timestamp,
    runStatus: task.runStatus,
    taskStatus: task.taskStatus,
    objective: truncateText(task.objective ?? ""),
    summary: truncateText(task.summary),
    userMessage: truncateText(task.userMessage ?? ""),
    assistantResponseKind: task.assistantResponseKind,
    actionType: task.actionType,
    entityHints: task.entityHints?.slice(0, 8),
  }));
}

function compactConversation(turns: ConversationTurn[]): Array<Record<string, unknown>> {
  return turns.slice(-MAX_CONVERSATION_TURNS).map((turn) => ({
    role: turn.role,
    kind: turn.assistantResponseKind,
    content: truncateText(turn.content),
  }));
}

function summarizeCapabilities(tools: ToolDefinition[]): Record<string, unknown> {
  return {
    pulseAvailable: hasPulseTool(tools),
    toolNames: tools.map((tool) => tool.name).slice(0, 80),
  };
}

function isCompletedTaskStatus(status: TaskSummaryTaskStatus): boolean {
  return status === "done" || status === "likely_done";
}

function hasPulseTool(tools: ToolDefinition[]): boolean {
  return tools.some((tool) => tool.name === "pulse");
}

function looksLikeOpenQuestion(text: string): boolean {
  const normalized = text.trim();
  if (!normalized.endsWith("?")) {
    return false;
  }
  return /\b(can you|could you|would you|do you want|want me|should i|please confirm|which|what|when|where|who|how)\b/i
    .test(normalized.slice(-280));
}

function isLikelyPulseApprovalOrDismissal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 160) {
    return false;
  }
  return /^(yes|yeah|yep|sure|ok|okay|do it|please do|go ahead|sounds good|make it|create it|set it|no|nope|nah|not now|skip|leave it|don't|dont)\b/.test(normalized);
}

function looksLikePulseManagement(...values: Array<string | undefined>): boolean {
  const text = values
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return /\b(pulse|reminder|schedule|scheduled task|routine|recurring|every day|daily|weekly|weekdays)\b/.test(text)
    && /\b(created|active|set|scheduled|updated|cancelled|paused|resumed|listed|reminded|remind me|routine)\b/.test(text);
}

function normalizeQuestion(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, " ");
  if (trimmed.endsWith("?")) {
    return trimmed;
  }
  return `${trimmed}?`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function extractJsonRecord(text: string): Record<string, unknown> {
  const trimmed = unwrapJsonFence(text.trim());
  const direct = tryParseJsonRecord(trimmed);
  if (direct) {
    return direct;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = tryParseJsonRecord(trimmed.slice(start, end + 1));
    if (extracted) {
      return extracted;
    }
  }

  return { action: "none", reason: "reflection response was not valid JSON" };
}

function unwrapJsonFence(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return match?.[1]?.trim() ?? text;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
