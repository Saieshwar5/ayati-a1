import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitMemoryDailySessionStore,
  GitMemoryTaskRouter,
} from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryTaskRouter", () => {
  it("creates a new task branch when no existing task matches", async () => {
    const { store, router, sessionId } = await openedRouterStore();
    const user = await store.appendConversationMessage({
      sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });

    const route = await router.route({
      sessionId,
      userMessage: user.text ?? "",
      fromSeq: user.seq,
      toSeq: user.seq,
      turnIds: [user.turnId],
      at: "2026-06-28T09:00:01+05:30",
    });

    expect(route).toMatchObject({
      status: "ready",
      mode: "create_new_task",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      createdTask: {
        link: {
          reason: "task_created",
          turnIds: [user.turnId],
        },
      },
    });

    const snapshot = await store.readTaskRoutingSnapshot(sessionId);
    expect(snapshot.focus).toMatchObject({
      activeTaskId: "W-20260628-0001",
      activeBranch: "task/W-20260628-0001-fix-upload-handling",
    });
    expect(snapshot.tasks).toMatchObject([{
      taskId: "W-20260628-0001",
      title: "Fix upload handling",
      status: "open",
    }]);
  });

  it("continues the active task for pure follow-up language", async () => {
    const { store, router, sessionId } = await openedRouterStore();
    await createTaskFromMessage(store, router, sessionId, "Fix upload handling", 1);
    const followUp = await store.appendConversationMessage({
      sessionId,
      role: "user",
      text: "finish it",
      at: "2026-06-28T09:05:00+05:30",
    });

    const route = await router.route({
      sessionId,
      userMessage: followUp.text ?? "",
      fromSeq: followUp.seq,
      toSeq: followUp.seq,
      turnIds: [followUp.turnId],
      at: "2026-06-28T09:05:01+05:30",
    });

    expect(route).toMatchObject({
      status: "ready",
      mode: "continue_active_task",
      taskId: "W-20260628-0001",
      selectedTask: {
        link: {
          reason: "task_continued",
          fromSeq: 2,
          toSeq: 2,
          turnIds: [followUp.turnId],
        },
      },
    });
    if (route.status === "ready") {
      expect(route.selectedTask?.focusEvent).toBeUndefined();
    }
  });

  it("switches focus when another existing task matches strongly", async () => {
    const { store, router, sessionId } = await openedRouterStore();
    const uploadTask = await createTaskFromMessage(store, router, sessionId, "Fix upload handling", 1);
    await createTaskFromMessage(store, router, sessionId, "Analyze contract risk", 2);
    const switchMessage = await store.appendConversationMessage({
      sessionId,
      role: "user",
      text: "continue upload handling",
      at: "2026-06-28T09:10:00+05:30",
    });

    const route = await router.route({
      sessionId,
      userMessage: switchMessage.text ?? "",
      fromSeq: switchMessage.seq,
      toSeq: switchMessage.seq,
      turnIds: [switchMessage.turnId],
      at: "2026-06-28T09:10:01+05:30",
    });

    expect(route).toMatchObject({
      status: "ready",
      mode: "switch_to_existing_task",
      taskId: uploadTask.taskId,
      selectedTask: {
        link: {
          reason: "task_switched",
          fromSeq: 3,
          toSeq: 3,
        },
        focusEvent: {
          type: "focus_changed",
          fromTaskId: "W-20260628-0002",
          toTaskId: uploadTask.taskId,
          reason: "task_switched",
        },
      },
    });

    const snapshot = await store.readTaskRoutingSnapshot(sessionId);
    expect(snapshot.focus).toMatchObject({
      activeTaskId: uploadTask.taskId,
    });
  });

  it("reopens a completed task when it is selected again", async () => {
    const { store, router, sessionId } = await openedRouterStore();
    const uploadTask = await createTaskFromMessage(store, router, sessionId, "Fix upload handling", 1);
    await store.commitTaskRun({
      sessionId,
      taskId: uploadTask.taskId,
      status: "completed",
      completedAt: "2026-06-28T09:05:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Finished upload handling.",
      state: {
        status: "done",
        completed: ["Finished upload handling."],
        open: [],
        next: "No next step.",
      },
    });
    await createTaskFromMessage(store, router, sessionId, "Analyze contract risk", 2);
    const reopenMessage = await store.appendConversationMessage({
      sessionId,
      role: "user",
      text: `continue ${uploadTask.taskId}`,
      at: "2026-06-28T09:15:00+05:30",
    });

    const route = await router.route({
      sessionId,
      userMessage: reopenMessage.text ?? "",
      fromSeq: reopenMessage.seq,
      toSeq: reopenMessage.seq,
      turnIds: [reopenMessage.turnId],
      at: "2026-06-28T09:15:01+05:30",
    });

    expect(route).toMatchObject({
      status: "ready",
      mode: "reopen_existing_task",
      taskId: uploadTask.taskId,
      selectedTask: {
        link: {
          reason: "task_reopened",
          fromSeq: 3,
          toSeq: 3,
        },
        focusEvent: {
          reason: "task_reopened",
          toTaskId: uploadTask.taskId,
        },
      },
    });
  });

  it("returns ambiguity instead of writing a link when multiple tasks partially match", async () => {
    const { store, router, sessionId } = await openedRouterStore();
    await createTaskFromMessage(store, router, sessionId, "Fix upload bug", 1);
    await createTaskFromMessage(store, router, sessionId, "Upload UI redesign", 2);
    const ambiguous = await store.appendConversationMessage({
      sessionId,
      role: "user",
      text: "upload",
      at: "2026-06-28T09:20:00+05:30",
    });

    const route = await router.route({
      sessionId,
      userMessage: ambiguous.text ?? "",
      fromSeq: ambiguous.seq,
      toSeq: ambiguous.seq,
      turnIds: [ambiguous.turnId],
      at: "2026-06-28T09:20:01+05:30",
    });

    expect(route.status).toBe("ambiguous");
    if (route.status === "ambiguous") {
      expect(route.reason).toBe("multiple existing tasks matched partially");
      expect(route.candidates.map((candidate) => candidate.taskId).sort()).toEqual([
        "W-20260628-0001",
        "W-20260628-0002",
      ]);
    }
    expect(await store.readTaskConversationSegments(sessionId, "W-20260628-0001")).toHaveLength(1);
    expect(await store.readTaskConversationSegments(sessionId, "W-20260628-0002")).toHaveLength(1);
  });
});

async function openedRouterStore(): Promise<{
  store: GitMemoryDailySessionStore;
  router: GitMemoryTaskRouter;
  sessionId: string;
}> {
  const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-router-"));
  const store = new GitMemoryDailySessionStore({ contextStoreDir });
  const session = await store.openOrCreateDailySession({
    date: "2026-06-28",
    timezone: "Asia/Kolkata",
    agentId: "local",
    createdAt: "2026-06-28T00:00:00+05:30",
  });
  return {
    store,
    router: new GitMemoryTaskRouter(store),
    sessionId: session.sessionId,
  };
}

async function createTaskFromMessage(
  store: GitMemoryDailySessionStore,
  router: GitMemoryTaskRouter,
  sessionId: string,
  message: string,
  expectedSeq: number,
): Promise<{ taskId: string; branch: string; ref: string }> {
  const user = await store.appendConversationMessage({
    sessionId,
    role: "user",
    text: message,
    at: "2026-06-28T09:00:00+05:30",
  });
  expect(user.seq).toBe(expectedSeq);
  const route = await router.route({
    sessionId,
    userMessage: message,
    fromSeq: user.seq,
    toSeq: user.seq,
    turnIds: [user.turnId],
    at: "2026-06-28T09:00:01+05:30",
  });
  if (route.status !== "ready") {
    throw new Error(`Expected ready task route, got ${route.status}.`);
  }
  return {
    taskId: route.taskId,
    branch: route.branch,
    ref: route.ref,
  };
}
