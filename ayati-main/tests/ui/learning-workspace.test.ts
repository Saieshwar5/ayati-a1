import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LearningWorkspaceController } from "../../src/ui/learning-workspace.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-learning-workspace-"));
}

describe("LearningWorkspaceController", () => {
  it("records open, show, focus, and close commands without controlling arbitrary windows", async () => {
    const dataDir = makeTmpDir();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
        unref: () => void;
      };
      child.pid = 1234;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        return true;
      };
      child.unref = () => undefined;
      const spawnImpl = vi.fn(() => child);
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xterminal",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              workspace: { id: 1, name: "1" },
              focusHistoryID: 1,
            },
            {
              address: "0xlearning",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 1234,
              workspace: { id: 1, name: "1" },
              focusHistoryID: 0,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 1, name: "1" });
        }
        return "ok";
      });
      const controller = new LearningWorkspaceController({
        projectRoot: dataDir,
        dataDir,
        httpBaseUrl: "http://127.0.0.1:8081",
        now: () => new Date("2026-06-04T06:00:00.000Z"),
        spawnImpl: spawnImpl as never,
        hyprctl,
        hyprlandEnabled: true,
        windowPollAttempts: 1,
        windowPollIntervalMs: 0,
      });

      const opened = await controller.open({
        clientId: "local",
        courseId: "machine-learning",
        lessonId: "intro",
      });

      expect(opened.isOpen).toBe(true);
      expect(opened.launchStatus).toBe("running");
      expect(opened.activeCourseId).toBe("machine-learning");
      expect(opened.activeLessonId).toBe("intro");
      expect(opened.processId).toBe(1234);
      expect(opened.windowVisible).toBe(true);
      expect(opened.windowAddress).toBe("0xlearning");
      expect(opened.terminalAddress).toBe("0xterminal");
      expect(opened.arrangementStatus).toBe("arranged");
      expect(spawnImpl).toHaveBeenCalledOnce();
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "focuswindow", "address:0xlearning"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "splitratio", "exact 0.3"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "splitratio", "exact 0.5"]);

      const shown = await controller.showLesson({
        clientId: "local",
        courseId: "machine-learning",
        lessonId: "regression",
      });
      expect(shown.lastCommand).toBe("show_lesson");
      expect(shown.activeLessonId).toBe("regression");

      const focused = await controller.focus("local");
      expect(focused.lastCommand).toBe("focus");

      const closed = await controller.close("local");
      expect(closed.isOpen).toBe(false);
      expect(closed.lastCommand).toBe("close");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not treat a browser tab as the Tauri learning window", async () => {
    const dataDir = makeTmpDir();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
        unref: () => void;
      };
      child.pid = 1234;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => true;
      child.unref = () => undefined;
      const controller = new LearningWorkspaceController({
        projectRoot: dataDir,
        dataDir,
        httpBaseUrl: "http://127.0.0.1:8081",
        spawnImpl: vi.fn(() => child) as never,
        hyprctl: async (args: string[]) => {
          if (args[0] === "clients") {
            return JSON.stringify([{
              address: "0xbrowser",
              visible: true,
              hidden: false,
              class: "chromium",
              title: "Ayati Learning Workspace - Chromium",
              workspace: { id: 1, name: "1" },
            }]);
          }
          if (args[0] === "activeworkspace") {
            return JSON.stringify({ id: 1, name: "1" });
          }
          return "ok";
        },
        hyprlandEnabled: true,
        windowPollAttempts: 1,
        windowPollIntervalMs: 0,
      });

      const opened = await controller.open({
        clientId: "local",
        courseId: "machine-learning",
        lessonId: "intro",
      });

      expect(opened.launchStatus).toBe("running");
      expect(opened.windowVisible).toBe(false);
      expect(opened.arrangementStatus).toBe("failed");
      expect(opened.arrangementError).toContain("Tauri window was not found");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("places the learning window beside the CLI-reported anchor window", async () => {
    const dataDir = makeTmpDir();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
        unref: () => void;
      };
      child.pid = 4321;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => true;
      child.unref = () => undefined;
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xother-terminal",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "other",
              pid: 900,
              workspace: { id: 2, name: "2" },
              focusHistoryID: 0,
            },
            {
              address: "0xcli-terminal",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 4,
            },
            {
              address: "0xlearning",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 4321,
              workspace: { id: 2, name: "2" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 2, name: "2" });
        }
        return "ok";
      });
      const controller = new LearningWorkspaceController({
        projectRoot: dataDir,
        dataDir,
        httpBaseUrl: "http://127.0.0.1:8081",
        spawnImpl: vi.fn(() => child) as never,
        hyprctl,
        hyprlandEnabled: true,
        windowPollAttempts: 1,
        windowPollIntervalMs: 0,
      });

      const opened = await controller.open({
        clientId: "local",
        courseId: "machine-learning",
        lessonId: "intro",
        uiContext: {
          source: "agent-cli",
          terminalPid: 111,
          windowAddress: "0xcli-terminal",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(opened.placementPolicy).toBe("current-agent-cli-window");
      expect(opened.anchorWindowAddress).toBe("0xcli-terminal");
      expect(opened.anchorWorkspaceName).toBe("3");
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "movetoworkspacesilent", "3,address:0xlearning"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "focuswindow", "address:0xlearning"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("delegates learning placement to the floating 30-70 workspace controller", async () => {
    const dataDir = makeTmpDir();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
        unref: () => void;
      };
      child.pid = 4321;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => true;
      child.unref = () => undefined;
      const workspaceOrchestrator = {
        setLayout: vi.fn(async () => ({
          lastActionStatus: "applied",
          layoutVerification: { verified: true },
        })),
      };
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli-terminal",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
            {
              address: "0xlearning",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 4321,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        return "ok";
      });
      const controller = new LearningWorkspaceController({
        projectRoot: dataDir,
        dataDir,
        httpBaseUrl: "http://127.0.0.1:8081",
        spawnImpl: vi.fn(() => child) as never,
        hyprctl,
        hyprlandEnabled: true,
        windowPollAttempts: 1,
        windowPollIntervalMs: 0,
        workspaceOrchestrator: workspaceOrchestrator as never,
      });

      const uiContext = {
        source: "agent-cli" as const,
        terminalPid: 111,
        windowAddress: "0xcli-terminal",
        workspaceId: 3,
        workspaceName: "3",
      };
      const opened = await controller.open({
        clientId: "local",
        courseId: "machine-learning",
        lessonId: "intro",
        uiContext,
      });

      expect(opened.arrangementStatus).toBe("arranged");
      expect(workspaceOrchestrator.setLayout).toHaveBeenCalledWith({
        clientId: "local",
        uiContext,
        layout: "30-70",
        primaryAddress: "0xlearning",
      });
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "movetoworkspacesilent", "3,address:0xlearning"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "settiled", "address:0xlearning"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reopens the learning window when showLesson finds stale Hyprland state", async () => {
    const dataDir = makeTmpDir();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        killed: boolean;
        kill: () => boolean;
        unref: () => void;
      };
      child.pid = 9876;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => true;
      child.unref = () => undefined;
      let launched = false;
      const spawnImpl = vi.fn(() => {
        launched = true;
        return child;
      });
      const workspaceOrchestrator = {
        setLayout: vi.fn(async () => ({
          lastActionStatus: "applied",
          layoutVerification: { verified: true },
        })),
      };
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli-terminal",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            ...(launched
              ? [{
                address: "0xlearning",
                visible: true,
                hidden: false,
                class: "ayati-learning-ui",
                title: "Ayati Learning Workspace",
                pid: 9876,
                workspace: { id: 3, name: "3" },
                focusHistoryID: 1,
              }]
              : []),
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        return "ok";
      });
      const controller = new LearningWorkspaceController({
        projectRoot: dataDir,
        dataDir,
        httpBaseUrl: "http://127.0.0.1:8081",
        spawnImpl: spawnImpl as never,
        hyprctl,
        hyprlandEnabled: true,
        windowPollAttempts: 1,
        windowPollIntervalMs: 0,
        workspaceOrchestrator: workspaceOrchestrator as never,
      });

      const shown = await controller.showLesson({
        clientId: "local",
        courseId: "thermodynamics-beginner-001",
        lessonId: "brayton-cycle-analysis-gas-turbine-fundamentals",
        uiContext: {
          source: "agent-cli",
          terminalPid: 111,
          windowAddress: "0xcli-terminal",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(spawnImpl).toHaveBeenCalledOnce();
      expect(shown.lastCommand).toBe("show_lesson");
      expect(shown.launchStatus).toBe("running");
      expect(shown.windowVisible).toBe(true);
      expect(shown.windowAddress).toBe("0xlearning");
      expect(shown.arrangementStatus).toBe("arranged");
      expect(workspaceOrchestrator.setLayout).toHaveBeenCalledWith(expect.objectContaining({
        layout: "30-70",
        primaryAddress: "0xlearning",
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
