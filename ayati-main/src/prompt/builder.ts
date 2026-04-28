import {
  type PromptBuildInput,
  type PromptBuildOutput,
  type PromptLayerId,
  type PromptSectionMetadata,
} from "./types.js";
import { renderBasePromptSection } from "./sections/base.js";
import { renderConversationSection } from "./sections/conversation.js";
import { renderCurrentSessionSection } from "./sections/current-session.js";
import { renderMemorySection } from "./sections/memory.js";
import { renderPersonalMemorySection } from "./sections/personal-memory.js";
import { renderRecentTasksSection } from "./sections/recent-tasks.js";
import { renderRuntimeContextSection } from "./sections/runtime-context.js";
import { renderSkillsSection } from "./sections/skills.js";
import { renderSoulSection } from "./sections/soul.js";
import { renderSystemActivitySection } from "./sections/system-activity.js";
import { renderSessionStatusSection } from "./sections/session-status.js";

function makeSection(id: PromptLayerId, content: string, missingReason: string): PromptSectionMetadata {
  if (content.trim().length === 0) {
    return {
      id,
      bytes: 0,
      included: false,
      reason: missingReason,
    };
  }

  return {
    id,
    bytes: Buffer.byteLength(content, "utf-8"),
    included: true,
  };
}

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

export function buildSystemPrompt(input: PromptBuildInput): PromptBuildOutput {
  const base = renderBasePromptSection(input.basePrompt);
  const soul = renderSoulSection(input.soul);
  const runtimeContext = renderRuntimeContextSection(input.runtimeContext ?? null);
  const personalMemory = renderPersonalMemorySection(input.personalMemorySnapshot ?? "");
  const conversation = renderConversationSection(input.conversationTurns ?? []);
  const memory = renderMemorySection(input.previousSessionSummary ?? "");
  const currentSession = renderCurrentSessionSection(input.activeSessionPath ?? "");
  const recentTasks = renderRecentTasksSection(input.recentTaskSummaries ?? []);
  const systemActivity = renderSystemActivitySection(input.recentSystemActivity ?? []);
  const skills = renderSkillsSection(input.skillBlocks ?? []);
  const tools = renderToolDirectorySection(input.toolDirectory, input.includeToolDirectory === true);
  const sessionStatus = renderSessionStatusSection(input.sessionStatus ?? null);

  const sections = [
    makeSection("base", base, "Base prompt is empty"),
    makeSection("soul", soul, "Soul context is empty"),
    makeSection("runtime_context", runtimeContext, "No runtime context available"),
    makeSection("personal_memory", personalMemory, "No personal memory snapshot available"),
    makeSection("conversation", conversation, "No previous conversation available"),
    makeSection("memory", memory, "No previous session summary available"),
    makeSection("current_session", currentSession, "No active session path available"),
    makeSection("recent_tasks", recentTasks, "No recent task summaries available"),
    makeSection("system_activity", systemActivity, "No recent system activity available"),
    makeSection("skills", skills, "No skills selected or available"),
    makeSection("tools", tools, "No tool directory available"),
    makeSection("session_status", sessionStatus, "No session status available"),
  ];

  const systemPrompt = [
    base,
    soul,
    runtimeContext,
    personalMemory,
    conversation,
    memory,
    currentSession,
    recentTasks,
    systemActivity,
    skills,
    tools,
    sessionStatus,
  ]
    .filter((block) => block.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    systemPrompt,
    sections,
  };
}
