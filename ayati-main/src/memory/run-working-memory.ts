import { mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentWorkingMemory,
  WorkingMemoryStep,
  AgentPlan,
  WorkingMemoryFact,
} from "./agent-working-memory.js";

export interface RunDigest {
  runId: string;
  filePath: string;
  endStatus: string;
  totalSteps: number;
  toolCallsMade: number;
  goal: string | null;
  keyFacts: string[];
  unresolvedErrors: number;
}

/**
 * Writes a human-readable .md file for a single agent run, appending
 * each step as it happens (crash-safe). At run end, consolidated
 * Key Facts, Errors, and Summary sections are appended.
 */
export class RunWorkingMemoryWriter {
  private readonly _filePath: string;
  private readonly runId: string;
  private finalized = false;

  constructor(runId: string, sessionId: string, userQuery: string, dataDir: string) {
    const now = new Date();
    const dateDir = now.toISOString().slice(0, 10);
    const shortId = runId.replace(/-/g, "").slice(0, 8);
    const dir = resolve(dataDir, "working-memory", dateDir);
    mkdirSync(dir, { recursive: true });
    this._filePath = join(dir, `${shortId}.md`);
    this.runId = runId;

    const query = userQuery.length > 120 ? userQuery.slice(0, 120) + "..." : userQuery;
    const header = [
      `# Run: ${runId}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Session | \`${sessionId}\` |`,
      `| Query | ${this.escapeCell(query)} |`,
      `| Started | ${now.toISOString()} |`,
      ``,
      `---`,
      ``,
      `## Steps`,
      ``,
    ].join("\n");

    this.append(header);
  }

  writePlan(plan: AgentPlan): void {
    if (this.finalized) return;
    const lines = [``, `### Plan (v${plan.plan_version})`, ``, `**Goal:** ${plan.goal}`, ``];
    for (const task of plan.sub_tasks) {
      const deps =
        task.depends_on && task.depends_on.length > 0
          ? ` *(needs: ${task.depends_on.join(", ")})*`
          : "";
      lines.push(`- [ ] **${task.id}.** ${task.title}${deps}`);
    }
    lines.push(``);
    this.append(lines.join("\n"));
  }

  writeStep(step: WorkingMemoryStep): void {
    if (this.finalized) return;
    const lines: string[] = [];
    const phaseLabel = step.phase.toUpperCase();
    const header = step.toolName
      ? `### Step ${step.step} — ${phaseLabel}: \`${step.toolName}\``
      : `### Step ${step.step} — ${phaseLabel}`;
    lines.push(header, ``);

    if (step.thinking.trim().length > 0) {
      const truncated =
        step.thinking.length > 400 ? step.thinking.slice(0, 400) + "..." : step.thinking;
      lines.push(`> ${truncated.replace(/\n/g, "\n> ")}`, ``);
    }

    lines.push(`**Summary:** ${step.summary}`);

    if (step.toolInput !== undefined) {
      const raw = JSON.stringify(step.toolInput);
      const truncated = raw.length > 500 ? raw.slice(0, 500) + "..." : raw;
      lines.push(``, `**Input:**`, "```json", truncated, "```");
    }

    if (step.toolOutput !== undefined) {
      const truncated =
        step.toolOutput.length > 600 ? step.toolOutput.slice(0, 600) + "..." : step.toolOutput;
      const statusIcon = step.toolStatus === "failed" ? "❌ failed" : "✅ success";
      lines.push(``, `**Output** (${statusIcon}):`, "```", truncated, "```");
    }

    lines.push(``, ``);
    this.append(lines.join("\n"));
  }

  writeKeyFact(fact: WorkingMemoryFact): void {
    if (this.finalized) return;
    const tool = fact.sourceToolName ? ` via \`${fact.sourceToolName}\`` : "";
    this.append(`> 📌 **Key fact** [step ${fact.sourceStep}${tool}]: ${fact.fact}\n\n`);
  }

  writeErrorResolved(step: number, resolution: string): void {
    if (this.finalized) return;
    this.append(`> ✅ **Error from step ${step} resolved:** ${resolution}\n\n`);
  }

  updateSubTaskStatus(taskId: number, status: "done" | "failed"): void {
    if (this.finalized) return;
    const icon = status === "done" ? "✅" : "❌";
    this.append(`> ${icon} **Sub-task ${taskId}:** marked as ${status}\n\n`);
  }

  finalize(
    endStatus: string,
    totalSteps: number,
    toolCallsMade: number,
    finalMessage: string,
    workingMemory: AgentWorkingMemory,
  ): RunDigest {
    if (!this.finalized) {
      this.finalized = true;
      this.writeConsolidatedSections(
        endStatus,
        totalSteps,
        toolCallsMade,
        finalMessage,
        workingMemory,
      );
    }
    return this.buildDigest(endStatus, totalSteps, toolCallsMade, workingMemory);
  }

  get path(): string {
    return this._filePath;
  }

  private writeConsolidatedSections(
    endStatus: string,
    totalSteps: number,
    toolCallsMade: number,
    finalMessage: string,
    workingMemory: AgentWorkingMemory,
  ): void {
    const lines: string[] = [``, `---`, ``];

    lines.push(`## Key Facts`, ``);
    if (workingMemory.keyFacts.length > 0) {
      for (const fact of workingMemory.keyFacts) {
        const tool = fact.sourceToolName ? ` via \`${fact.sourceToolName}\`` : "";
        lines.push(`- ${fact.fact} *[step ${fact.sourceStep}${tool}]*`);
      }
    } else {
      lines.push(`*None recorded*`);
    }
    lines.push(``);

    lines.push(`## Errors`, ``);
    if (workingMemory.errorRegister.length > 0) {
      for (const err of workingMemory.errorRegister) {
        const tool = err.toolName ? ` \`${err.toolName}\` —` : "";
        const icon = err.resolved ? "✅" : "❌";
        lines.push(`- ${icon} **Step ${err.step}**${tool} ${err.errorMessage}`);
        if (err.resolved && err.resolutionSummary) {
          lines.push(`  - Resolved: ${err.resolutionSummary}`);
        }
      }
    } else {
      lines.push(`*None*`);
    }
    lines.push(``);

    if (workingMemory.plan) {
      const plan = workingMemory.plan;
      lines.push(`## Final Plan State`, ``, `**Goal:** ${plan.goal}`, ``);
      for (const task of plan.sub_tasks) {
        const icon =
          task.status === "done"
            ? "✅"
            : task.status === "failed"
              ? "❌"
              : task.status === "in_progress"
                ? "🔄"
                : "⭕";
        lines.push(`- ${icon} **${task.id}.** ${task.title}`);
      }
      lines.push(``);
    }

    const unresolved = workingMemory.errorRegister.filter((e) => !e.resolved).length;
    const statusIcon = endStatus === "solved" ? "✅" : endStatus === "partial" ? "⚠️" : "❌";
    const msg =
      finalMessage.length > 500 ? finalMessage.slice(0, 500) + "..." : finalMessage;

    lines.push(
      `## Summary`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Status | ${statusIcon} ${endStatus} |`,
      `| Steps | ${totalSteps} |`,
      `| Tool Calls | ${toolCallsMade} |`,
      `| Key Facts | ${workingMemory.keyFacts.length} |`,
      `| Errors (total / unresolved) | ${workingMemory.errorRegister.length} / ${unresolved} |`,
      `| Finished | ${new Date().toISOString()} |`,
      ``,
      `**Final Answer:**`,
      ``,
      `> ${msg.replace(/\n/g, "\n> ")}`,
      ``,
    );

    this.append(lines.join("\n"));
  }

  private buildDigest(
    endStatus: string,
    totalSteps: number,
    toolCallsMade: number,
    workingMemory: AgentWorkingMemory,
  ): RunDigest {
    return {
      runId: this.runId,
      filePath: this._filePath,
      endStatus,
      totalSteps,
      toolCallsMade,
      goal: workingMemory.plan?.goal ?? null,
      keyFacts: workingMemory.keyFacts.map((f) => f.fact),
      unresolvedErrors: workingMemory.errorRegister.filter((e) => !e.resolved).length,
    };
  }

  private escapeCell(text: string): string {
    return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  private append(content: string): void {
    appendFileSync(this._filePath, content, "utf-8");
  }
}
