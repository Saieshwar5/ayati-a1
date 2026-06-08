import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceOrchestrator } from "../../src/ui/workspace-orchestrator.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-workspace-orchestrator-"));
}

function resizeDeltaFromHyprctlArgs(args: string[]): number | undefined {
  if (args[0] === "dispatch" && args[1] === "resizeactive") {
    return Number(args[2]?.split(/\s+/)[0]);
  }
  if (args[0] === "--batch") {
    const match = args[1]?.match(/(?:^|;\s*)dispatch\s+resizeactive\s+(-?\d+)\s+(-?\d+)/);
    return match ? Number(match[1]) : undefined;
  }
  return undefined;
}

describe("WorkspaceOrchestrator", () => {
  it("anchors to the CLI workspace and applies tiled agent 30-70 layout", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 500;
      let primaryWidth = 500;
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: [0, 0],
              size: [cliWidth, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "chromium",
              title: "Preview",
              pid: 222,
              at: [cliWidth, 0],
              size: [primaryWidth, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        const delta = resizeDeltaFromHyprctlArgs(args);
        if (delta !== undefined) {
          cliWidth += delta;
          primaryWidth -= delta;
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        now: () => new Date("2026-06-07T10:00:00.000Z"),
        layoutSettleMs: 0,
      });

      const state = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          terminalPid: 111,
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.anchorCliAddress).toBe("0xcli");
      expect(state.workspaceName).toBe("3");
      expect(state.controlMode).toBe("agent-30-70");
      expect(state.activeLayout).toBe("30-70");
      expect(state.lastActionStatus).toBe("applied");
      expect(state.layoutVerification?.verified).toBe(true);
      expect(state.layoutVerification?.strategy).toBe("tiled-resize");
      expect(state.layoutVerification?.actualCliRatio).toBe(0.3);
      expect(state.windows.find((window) => window.address === "0xcli")?.role).toBe("cli");
      expect(state.windows.find((window) => window.address === "0xcli")?.geometry?.width).toBe(300);
      expect(state.windows.find((window) => window.address === "0xpreview")?.geometry?.width).toBe(700);
      expect(state.windows.find((window) => window.address === "0xcli")?.floating).toBe(false);
      expect(state.windows.find((window) => window.address === "0xpreview")?.floating).toBe(false);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "movetoworkspacesilent", "3,address:0xcli"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "movetoworkspacesilent", "3,address:0xpreview"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xcli"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xpreview"]);
      expect(hyprctl).toHaveBeenCalledWith(["--batch", "dispatch resizeactive -200 0"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "setfloating", expect.any(String)]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "resizewindowpixel", expect.any(String)]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "focuswindow", "address:0xcli"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports failure when Hyprland does not change the measured split", async () => {
    const dataDir = makeTmpDir();
    try {
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: [0, 0],
              size: [500, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "chromium",
              title: "Preview",
              pid: 222,
              at: [500, 0],
              size: [500, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        layoutVerificationRetries: 1,
        layoutSettleMs: 0,
      });

      const state = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("failed");
      expect(state.layoutVerification?.verified).toBe(false);
      expect(state.layoutVerification?.actualCliRatio).toBe(0.5);
      expect(state.error).toContain("Measured CLI ratio 0.5");
      expect(hyprctl).toHaveBeenCalledWith(["--batch", "dispatch resizeactive -200 0"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "resizewindowpixel", expect.any(String)]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("swaps the CLI to the left before applying a ratio layout", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 500;
      let primaryWidth = 500;
      let cliOnLeft = false;
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: cliOnLeft ? [0, 0] : [primaryWidth, 0],
              size: [cliWidth, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 222,
              at: cliOnLeft ? [cliWidth, 0] : [0, 0],
              size: [primaryWidth, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        if (args[0] === "dispatch" && args[1] === "swapwindow" && args[2] === "l") {
          cliOnLeft = true;
        }
        const delta = resizeDeltaFromHyprctlArgs(args);
        if (delta !== undefined) {
          cliWidth += delta;
          primaryWidth -= delta;
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        layoutSettleMs: 0,
      });

      const state = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          terminalPid: 111,
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("applied");
      expect(state.layoutVerification?.verified).toBe(true);
      expect(state.layoutVerification?.anchorGeometry?.x).toBe(0);
      expect(state.layoutVerification?.primaryGeometry?.x).toBe(300);
      expect(state.layoutVerification?.actualCliRatio).toBe(0.3);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "swapwindow", "l"]);
      expect(hyprctl).toHaveBeenCalledWith(["--batch", "dispatch resizeactive -200 0"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects using the protected CLI as the primary layout target", async () => {
    const dataDir = makeTmpDir();
    try {
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: [0, 0],
              size: [500, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "chromium",
              title: "Preview",
              pid: 222,
              at: [500, 0],
              size: [500, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        layoutSettleMs: 0,
      });

      const state = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        primaryAddress: "0xcli",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("failed");
      expect(state.layoutVerification?.verified).toBe(false);
      expect(state.error).toContain("primaryAddress points to the protected CLI anchor");
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "resizeactive", expect.any(String)]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "setfloating", expect.any(String)]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("tiles an existing floating workspace and resizes it into 30-70", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 1188;
      let primaryWidth = 54;
      let cliFloating = true;
      let primaryFloating = true;
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: [0, 0],
              size: [cliWidth, 900],
              floating: cliFloating,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 222,
              at: [cliWidth, 0],
              size: [primaryWidth, 900],
              floating: primaryFloating,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        if (args[0] === "dispatch" && args[1] === "settiled") {
          if (args[2] === "address:0xcli") cliFloating = false;
          if (args[2] === "address:0xpreview") primaryFloating = false;
        }
        const delta = resizeDeltaFromHyprctlArgs(args);
        if (delta !== undefined) {
          cliWidth += delta;
          primaryWidth -= delta;
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        layoutVerificationRetries: 4,
        layoutSettleMs: 0,
      });

      const state = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("applied");
      expect(state.layoutVerification?.verified).toBe(true);
      expect(state.layoutVerification?.strategy).toBe("tiled-resize");
      expect(state.layoutVerification?.actualCliRatio).toBeCloseTo(0.312, 3);
      expect(state.windows.find((window) => window.address === "0xcli")?.floating).toBe(false);
      expect(state.windows.find((window) => window.address === "0xpreview")?.floating).toBe(false);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xcli"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xpreview"]);
      expect(hyprctl).toHaveBeenCalledWith(["--batch", "dispatch resizeactive -400 0"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "resizewindowpixel", expect.any(String)]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("expands the CLI to 50-50 when the user starts composing", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 300;
      let primaryWidth = 700;
      let cliFloating = false;
      let primaryFloating = false;
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              at: [0, 0],
              size: [cliWidth, 900],
              floating: cliFloating,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 0,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "ayati-learning-ui",
              title: "Ayati Learning Workspace",
              pid: 222,
              at: [cliWidth, 0],
              size: [primaryWidth, 900],
              floating: primaryFloating,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        if (args[0] === "dispatch" && args[1] === "settiled") {
          if (args[2] === "address:0xcli") cliFloating = false;
          if (args[2] === "address:0xpreview") primaryFloating = false;
        }
        const delta = resizeDeltaFromHyprctlArgs(args);
        if (delta !== undefined) {
          cliWidth += delta;
          primaryWidth -= delta;
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        now: () => new Date("2026-06-07T10:00:00.000Z"),
        layoutSettleMs: 0,
      });

      const state = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "cli_input_started",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          terminalPid: 111,
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("applied");
      expect(state.controlMode).toBe("compose-50-50");
      expect(state.activeLayout).toBe("50-50");
      expect(state.layoutVerification?.verified).toBe(true);
      expect(state.layoutVerification?.strategy).toBe("tiled-resize");
      expect(state.layoutVerification?.actualCliRatio).toBe(0.5);
      expect(state.windows.find((window) => window.address === "0xcli")?.geometry?.width).toBe(500);
      expect(state.windows.find((window) => window.address === "0xpreview")?.geometry?.width).toBe(500);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xcli"]);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "settiled", "address:0xpreview"]);
      expect(hyprctl).toHaveBeenCalledWith(["--batch", "dispatch resizeactive 200 0"]);
      expect(hyprctl).not.toHaveBeenCalledWith(["dispatch", "resizewindowpixel", expect.any(String)]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reuses an existing same-role window instead of opening a new one", async () => {
    const dataDir = makeTmpDir();
    try {
      const spawnImpl = vi.fn();
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            {
              address: "0xcli",
              visible: true,
              hidden: false,
              class: "Alacritty",
              title: "ayati-a1",
              pid: 111,
              workspace: { id: 3, name: "3" },
              focusHistoryID: 1,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "chromium",
              title: "Preview",
              pid: 222,
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
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        spawnImpl: spawnImpl as never,
      });

      const state = await orchestrator.reuseOrOpenWindow({
        clientId: "local",
        role: "preview",
        command: "chromium http://127.0.0.1:4173",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.lastActionStatus).toBe("reused");
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "focuswindow", "address:0xpreview"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("closes the least-useful unpinned non-CLI window when the workspace exceeds capacity", async () => {
    const dataDir = makeTmpDir();
    try {
      const hyprctl = vi.fn(async (args: string[]) => {
        if (args[0] === "clients") {
          return JSON.stringify([
            { address: "0xcli", visible: true, hidden: false, class: "Alacritty", title: "ayati-a1", workspace: { id: 3, name: "3" }, focusHistoryID: 0 },
            { address: "0xprimary", visible: true, hidden: false, class: "ayati-learning-ui", title: "Ayati Learning", workspace: { id: 3, name: "3" }, focusHistoryID: 1 },
            { address: "0xscratch", visible: true, hidden: false, class: "chromium", title: "Scratch explanation", workspace: { id: 3, name: "3" }, focusHistoryID: 5 },
            { address: "0xref", visible: true, hidden: false, class: "chromium", title: "Reference docs", workspace: { id: 3, name: "3" }, focusHistoryID: 4 },
            { address: "0xpreview", visible: true, hidden: false, class: "chromium", title: "Preview", workspace: { id: 3, name: "3" }, focusHistoryID: 3 },
            { address: "0xcode", visible: true, hidden: false, class: "Code", title: "Code", workspace: { id: 3, name: "3" }, focusHistoryID: 2 },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        return "ok";
      });
      const orchestrator = new WorkspaceOrchestrator({
        dataDir,
        hyprctl,
        hyprlandEnabled: true,
        maxWindows: 5,
      });

      const state = await orchestrator.cleanupUnused({
        clientId: "local",
        uiContext: {
          source: "agent-cli",
          windowAddress: "0xcli",
          workspaceId: 3,
          workspaceName: "3",
        },
      });

      expect(state.windows.map((window) => window.address)).not.toContain("0xscratch");
      expect(state.windows).toHaveLength(5);
      expect(hyprctl).toHaveBeenCalledWith(["dispatch", "closewindow", "address:0xscratch"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
