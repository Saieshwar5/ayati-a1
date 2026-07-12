export function renderInitialTaskDescriptor(input: {
  taskId: string;
  title: string;
  objective: string;
}): string {
  return [
    "# " + input.title,
    "",
    "Task: " + input.taskId,
    "",
    input.objective,
    "",
    "## Important Paths",
    "",
    "No deliverable files created yet.",
    "",
  ].join("\n");
}
