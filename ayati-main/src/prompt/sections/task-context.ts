import type { TaskState } from "../../memory/task-state-manager.js";

/**
 * Renders a compact task context block injected into the system prompt when
 * an active Tier 3 task is in progress for this client.
 */
export function renderTaskContextSection(task: TaskState): string {
  const statusIcon = (status: string): string => {
    if (status === "done") return "✅";
    if (status === "failed") return "❌";
    if (status === "in_progress") return "🔄";
    return "⭕";
  };

  const lines: string[] = [
    `[Active Task]`,
    `Task ID: ${task.taskId}`,
    `Goal: ${task.goal}`,
    ``,
    `Subtasks:`,
  ];

  for (const st of task.subTasks) {
    const icon = statusIcon(st.status);
    const notes = st.notesPath ? ` → notes: ${st.notesPath}` : "";
    lines.push(`  ${icon} ${st.id}. ${st.title}${notes}`);
  }

  const current = task.subTasks.find((s) => s.id === task.currentSubTaskId);
  if (current) {
    lines.push(``, `Current subtask: ${current.id} — ${current.title}`);
    lines.push(`State file: data/tasks/${task.taskId}/state.json`);
    const completedWithNotes = task.subTasks.filter((s) => s.status === "done" && s.notesPath);
    if (completedWithNotes.length > 0) {
      lines.push(``, `Previous subtask notes:`);
      for (const s of completedWithNotes) {
        lines.push(`  - Subtask ${s.id}: ${s.notesPath}`);
      }
    }
  }

  return lines.join("\n");
}
