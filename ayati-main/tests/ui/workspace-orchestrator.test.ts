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
              class: "ayati-workspace-ui",
              title: "Ayati Workspace",
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
              class: "ayati-workspace-ui",
              title: "Ayati Workspace",
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
              class: "ayati-workspace-ui",
              title: "Ayati Workspace",
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

  it("restores visual layout on visual focus and expands again on later CLI typing", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 500;
      let primaryWidth = 500;
      let focusedAddress = "0xcli";
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
              focusHistoryID: focusedAddress === "0xcli" ? 0 : 1,
            },
            {
              address: "0xpreview",
              visible: true,
              hidden: false,
              class: "ayati-workspace-ui",
              title: "Ayati Workspace",
              pid: 222,
              at: [cliWidth, 0],
              size: [primaryWidth, 900],
              floating: false,
              workspace: { id: 3, name: "3" },
              focusHistoryID: focusedAddress === "0xpreview" ? 0 : 1,
            },
          ]);
        }
        if (args[0] === "activeworkspace") {
          return JSON.stringify({ id: 3, name: "3" });
        }
        if (args[0] === "dispatch" && args[1] === "focuswindow") {
          focusedAddress = args[2]?.replace("address:", "") ?? focusedAddress;
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
      const uiContext = {
        source: "agent-cli" as const,
        windowAddress: "0xcli",
        terminalPid: 111,
        workspaceId: 3,
        workspaceName: "3",
      };

      const visual = await orchestrator.setLayout({
        clientId: "local",
        layout: "30-70",
        primaryAddress: "0xpreview",
        uiContext,
      });
      expect(visual.attentionMode).toBe("visual");
      expect(visual.returnLayout).toBe("30-70");
      expect(visual.layoutVerification?.actualCliRatio).toBe(0.3);

      const compose = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "cli_input_started",
        uiContext,
      });
      expect(compose.attentionMode).toBe("compose");
      expect(compose.activeLayout).toBe("50-50");
      expect(compose.returnLayout).toBe("30-70");
      expect(compose.layoutVerification?.actualCliRatio).toBe(0.5);

      focusedAddress = "0xpreview";
      const restored = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "visual_surface_focused",
        windowAddress: "0xpreview",
      });
      expect(restored.attentionMode).toBe("visual");
      expect(restored.activeLayout).toBe("30-70");
      expect(restored.lastFocusedWindowAddress).toBe("0xpreview");
      expect(restored.layoutVerification?.actualCliRatio).toBe(0.3);
      expect(focusedAddress).toBe("0xpreview");

      focusedAddress = "0xcli";
      const recomposed = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "cli_input_started",
        uiContext,
      });
      expect(recomposed.attentionMode).toBe("compose");
      expect(recomposed.activeLayout).toBe("50-50");
      expect(recomposed.returnLayout).toBe("30-70");
      expect(recomposed.layoutVerification?.actualCliRatio).toBe(0.5);
      expect(recomposed.windows.find((window) => window.address === "0xcli")?.geometry?.width).toBe(500);
      expect(recomposed.windows.find((window) => window.address === "0xpreview")?.geometry?.width).toBe(500);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("clears workspace state only for the matching CLI workspace session", async () => {
    const dataDir = makeTmpDir();
    try {
      let cliWidth = 300;
      let primaryWidth = 700;
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
              class: "ayati-workspace-ui",
              title: "Ayati Workspace",
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
      const uiContext = {
        source: "agent-cli" as const,
        windowAddress: "0xcli",
        terminalPid: 111,
        workspaceId: 3,
        workspaceName: "3",
      };

      const started = await orchestrator.startSession({
        clientId: "local",
        workspaceSessionId: "session-1",
        transportClientId: "transport-1",
        uiContext,
      });
      expect(started.workspaceSessionId).toBe("session-1");
      expect(started.transportClientId).toBe("transport-1");
      expect(started.anchorCliAddress).toBe("0xcli");

      const compose = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "cli_input_started",
        workspaceSessionId: "session-1",
        uiContext,
      });
      expect(compose.activeLayout).toBe("50-50");
      expect(compose.layoutVerification?.actualCliRatio).toBe(0.5);

      const duplicateStart = await orchestrator.startSession({
        clientId: "local",
        workspaceSessionId: "session-1",
        transportClientId: "transport-1",
        uiContext,
      });
      expect(duplicateStart.workspaceSessionId).toBe("session-1");
      expect(duplicateStart.activeLayout).toBe("50-50");

      const ignoredEnd = await orchestrator.endSession({
        clientId: "local",
        workspaceSessionId: "older-session",
        reason: "transport_closed",
      });
      expect(ignoredEnd.workspaceSessionId).toBe("session-1");
      expect(ignoredEnd.activeLayout).toBe("50-50");

      const cleared = await orchestrator.endSession({
        clientId: "local",
        workspaceSessionId: "session-1",
        reason: "transport_closed",
      });
      expect(cleared.workspaceSessionId).toBeUndefined();
      expect(cleared.windows).toEqual([]);
      expect(cleared.activeLayout).toBe("30-70");

      cliWidth = 300;
      primaryWidth = 700;
      const restarted = await orchestrator.startSession({
        clientId: "local",
        workspaceSessionId: "session-2",
        transportClientId: "transport-2",
        uiContext,
      });
      expect(restarted.workspaceSessionId).toBe("session-2");
      expect(restarted.activeLayout).toBe("30-70");

      const staleCompose = await orchestrator.handleInteractionEvent({
        clientId: "local",
        event: "cli_input_started",
        workspaceSessionId: "session-1",
        uiContext,
      });
      expect(staleCompose.workspaceSessionId).toBe("session-2");
      expect(staleCompose.activeLayout).toBe("30-70");
      expect(cliWidth).toBe(300);
      expect(primaryWidth).toBe(700);
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
            { address: "0xprimary", visible: true, hidden: false, class: "ayati-workspace-ui", title: "Ayati Workspace", workspace: { id: 3, name: "3" }, focusHistoryID: 1 },
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
