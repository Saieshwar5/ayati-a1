export type SubTaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface SubTask {
  id: number;
  title: string;
  status: SubTaskStatus;
  depends_on?: number[];
}

export interface AgentPlan {
  goal: string;
  sub_tasks: SubTask[];
  current_sub_task: number;
  plan_version: number;
}

export interface WorkingMemoryStep {
  step: number;
  phase: string;
  thinking: string;
  summary: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolStatus?: "success" | "failed";
  durationMs?: number;
}

export interface WorkingMemoryError {
  step: number;
  toolName?: string;
  errorMessage: string;
  resolved: boolean;
  resolutionSummary?: string;
}

export interface WorkingMemoryFact {
  fact: string;
  sourceStep: number;
  sourceToolName?: string;
}

export class AgentWorkingMemory {
  readonly runId: string;
  plan: AgentPlan | null = null;
  steps: WorkingMemoryStep[] = [];
  errorRegister: WorkingMemoryError[] = [];
  keyFacts: WorkingMemoryFact[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  addStep(entry: WorkingMemoryStep): void {
    this.steps.push(entry);
  }

  setPlan(plan: AgentPlan): void {
    this.plan = plan;
  }

  updateSubTaskStatus(subTaskId: number, status: SubTaskStatus): void {
    if (!this.plan) return;
    const task = this.plan.sub_tasks.find((t) => t.id === subTaskId);
    if (task) {
      task.status = status;
    }
  }

  advanceToNextSubTask(): number | null {
    if (!this.plan) return null;
    const doneIds = new Set(
      this.plan.sub_tasks.filter((t) => t.status === "done").map((t) => t.id),
    );
    const next = this.plan.sub_tasks.find((t) => {
      if (t.status !== "pending") return false;
      if (!t.depends_on || t.depends_on.length === 0) return true;
      return t.depends_on.every((dep) => doneIds.has(dep));
    });
    if (!next) return null;
    next.status = "in_progress";
    this.plan.current_sub_task = next.id;
    return next.id;
  }

  addError(entry: WorkingMemoryError): void {
    this.errorRegister.push(entry);
  }

  resolveError(step: number, resolutionSummary: string): void {
    const entry = this.errorRegister.find((e) => e.step === step);
    if (entry) {
      entry.resolved = true;
      entry.resolutionSummary = resolutionSummary;
    }
  }

  addKeyFacts(facts: WorkingMemoryFact[]): void {
    this.keyFacts.push(...facts);
  }

  renderView(signals?: string): string {
    const blocks: string[] = ["--- Agent Working Memory ---"];

    if (this.plan) {
      blocks.push(this.renderPlan());
    }

    if (this.keyFacts.length > 0) {
      blocks.push(this.renderKeyFacts());
    }

    if (this.steps.length > 0) {
      blocks.push(this.renderSteps());
    }

    blocks.push(this.renderErrors());

    if (signals && signals.trim().length > 0) {
      blocks.push(`[Context Signals]\n${signals.split("\n").map((s) => `  ${s}`).join("\n")}`);
    }

    blocks.push("--- End Agent Working Memory ---");
    return blocks.join("\n\n");
  }

  private renderPlan(): string {
    const plan = this.plan!;
    const lines: string[] = [`[PLAN v${plan.plan_version}]  Goal: ${plan.goal}`];
    for (const task of plan.sub_tasks) {
      const deps = task.depends_on && task.depends_on.length > 0
        ? `  (needs: ${task.depends_on.join(", ")})`
        : "";
      if (task.status === "done") {
        lines.push(`  ✓ Sub-task ${task.id}: ${task.title}`);
      } else if (task.id === plan.current_sub_task) {
        lines.push(`  → Sub-task ${task.id}: ${task.title}${deps}         ← CURRENT`);
      } else if (task.status === "failed") {
        lines.push(`  ✗ Sub-task ${task.id}: ${task.title}${deps}`);
      } else {
        lines.push(`  ○ Sub-task ${task.id}: ${task.title}${deps}`);
      }
    }
    return lines.join("\n");
  }

  private renderKeyFacts(): string {
    const lines: string[] = ["[Key Facts]"];
    for (const fact of this.keyFacts) {
      const tool = fact.sourceToolName ? ` via ${fact.sourceToolName}` : "";
      lines.push(`  • ${fact.fact}  [step ${fact.sourceStep}${tool}]`);
    }
    return lines.join("\n");
  }

  private renderSteps(): string {
    const lines: string[] = ["[Steps]"];
    for (const step of this.steps) {
      lines.push(`  [Step ${step.step}] ${step.phase.toUpperCase()}: ${step.summary}`);
      if (step.toolName) {
        lines.push(`    Tool: ${step.toolName}`);
      }
      if (step.toolOutput !== undefined) {
        const status = step.toolStatus === "failed" ? " (FAILED)" : "";
        lines.push(`    Result${status}: ${step.toolOutput}`);
      }
      if (step.durationMs !== undefined) {
        lines.push(`    Duration: ${step.durationMs}ms`);
      }
    }
    return lines.join("\n");
  }

  private renderErrors(): string {
    if (this.errorRegister.length === 0) {
      return "[Errors]\n  (none)";
    }
    const lines: string[] = ["[Errors]"];
    for (const err of this.errorRegister) {
      const tool = err.toolName ? ` ${err.toolName} —` : "";
      if (err.resolved) {
        lines.push(`  ✓ [Step ${err.step}]${tool} ${err.errorMessage}`);
        if (err.resolutionSummary) {
          lines.push(`     → resolved: ${err.resolutionSummary}`);
        }
      } else {
        lines.push(`  ✗ [Step ${err.step}]${tool} ${err.errorMessage}`);
      }
    }
    return lines.join("\n");
  }
}
