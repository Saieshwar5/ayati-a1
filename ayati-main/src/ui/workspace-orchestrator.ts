import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentUiContext } from "./context.js";

export type WorkspaceLayout = "50-50" | "30-70" | "20-80" | "grid" | "focus";
export type WorkspaceControlMode = "normal" | "agent-30-70" | "compose-50-50";
export type WorkspaceInteractionEvent =
  | "cli_input_started"
  | "cli_message_submitted"
  | "agent_visual_response_started";
export type WorkspaceWindowRole =
  | "cli"
  | "primary"
  | "secondary"
  | "browser"
  | "code"
  | "preview"
  | "terminal"
  | "reference"
  | "scratch";
export type WorkspaceActionStatus = "not_attempted" | "applied" | "unavailable" | "failed" | "reused" | "launched" | "closed";
export type HyprctlRunner = (args: string[]) => Promise<string>;

export interface WorkspaceWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceWindowRecord {
  address: string;
  role: WorkspaceWindowRole;
  title?: string;
  className?: string;
  initialClassName?: string;
  pid?: number;
  floating?: boolean;
  geometry?: WorkspaceWindowGeometry;
  workspaceId?: number;
  workspaceName?: string;
  ownedByAyati: boolean;
  pinned: boolean;
  lastFocusedAt?: string;
  lastUsedAt?: string;
  lastSeenAt: string;
  contentHint?: string;
}

export interface WorkspaceLayoutVerification {
  layout: WorkspaceLayout;
  verified: boolean;
  measuredAt: string;
  tolerance: number;
  expectedCliRatio?: number;
  actualCliRatio?: number;
  axis?: "horizontal" | "vertical" | "overlap";
  strategy?: "floating-exact" | "tiled-resize" | "none";
  anchorAddress?: string;
  primaryAddress?: string;
  anchorGeometry?: WorkspaceWindowGeometry;
  primaryGeometry?: WorkspaceWindowGeometry;
  workArea?: WorkspaceWindowGeometry;
  reason?: string;
}

export interface WorkspaceState {
  schemaVersion: 1;
  clientId: string;
  hyprlandAvailable: boolean;
  workspaceId?: number;
  workspaceName?: string;
  anchorCliAddress?: string;
  controlMode: WorkspaceControlMode;
  activeLayout: WorkspaceLayout;
  desiredLayout?: WorkspaceLayout;
  verifiedLayout?: WorkspaceLayout;
  layoutVerification?: WorkspaceLayoutVerification;
  maxWindows: number;
  windows: WorkspaceWindowRecord[];
  lastCommand?: string;
  lastCommandId?: string;
  lastActionStatus: WorkspaceActionStatus;
  lastUpdatedAt: string;
  error?: string;
}

export interface WorkspaceOrchestratorOptions {
  dataDir: string;
  now?: () => Date;
  spawnImpl?: typeof spawn;
  hyprctl?: HyprctlRunner;
  hyprlandEnabled?: boolean;
  maxWindows?: number;
  windowPollAttempts?: number;
  windowPollIntervalMs?: number;
  layoutVerificationTolerance?: number;
  layoutVerificationRetries?: number;
  layoutSettleMs?: number;
  layoutMaxResizeStep?: number;
}

export interface WorkspaceActionInput {
  clientId: string;
  uiContext?: AgentUiContext;
}

export interface SetWorkspaceLayoutInput extends WorkspaceActionInput {
  layout: WorkspaceLayout;
  primaryRole?: WorkspaceWindowRole;
  primaryAddress?: string;
}

export interface FocusWorkspaceWindowInput extends WorkspaceActionInput {
  role?: WorkspaceWindowRole;
  address?: string;
}

export interface RegisterWorkspaceWindowInput extends WorkspaceActionInput {
  address: string;
  role: WorkspaceWindowRole;
  ownedByAyati?: boolean;
  pinned?: boolean;
  contentHint?: string;
}

export interface ReuseOrOpenWorkspaceWindowInput extends WorkspaceActionInput {
  role: WorkspaceWindowRole;
  command?: string;
  reuse?: boolean;
  titleHint?: string;
  classHint?: string;
  contentHint?: string;
  pinned?: boolean;
  ownedByAyati?: boolean;
}

export interface CloseWorkspaceWindowInput extends WorkspaceActionInput {
  role?: WorkspaceWindowRole;
  address?: string;
  allowClosingAnchor?: boolean;
}

export interface WorkspaceInteractionInput extends WorkspaceActionInput {
  event: WorkspaceInteractionEvent;
}

export class WorkspaceOrchestrator {
  private readonly statePath: string;
  private readonly nowProvider: () => Date;
  private readonly spawnImpl: typeof spawn;
  private readonly hyprctl: HyprctlRunner;
  private readonly hyprlandEnabled: boolean;
  private readonly maxWindows: number;
  private readonly windowPollAttempts: number;
  private readonly windowPollIntervalMs: number;
  private readonly layoutVerificationTolerance: number;
  private readonly layoutVerificationRetries: number;
  private readonly layoutSettleMs: number;
  private readonly layoutMaxResizeStep: number;

  constructor(options: WorkspaceOrchestratorOptions) {
    this.statePath = resolve(options.dataDir, "ui", "workspace-orchestrator.json");
    this.nowProvider = options.now ?? (() => new Date());
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.hyprctl = options.hyprctl ?? defaultHyprctlRunner;
    this.hyprlandEnabled = options.hyprlandEnabled ?? Boolean(process.env["HYPRLAND_INSTANCE_SIGNATURE"]);
    this.maxWindows = Math.max(2, Math.min(5, options.maxWindows ?? 5));
    this.windowPollAttempts = Math.max(1, options.windowPollAttempts ?? 12);
    this.windowPollIntervalMs = Math.max(0, options.windowPollIntervalMs ?? 250);
    this.layoutVerificationTolerance = Math.max(0.01, Math.min(0.2, options.layoutVerificationTolerance ?? 0.08));
    this.layoutVerificationRetries = Math.max(0, Math.min(10, options.layoutVerificationRetries ?? 6));
    this.layoutSettleMs = Math.max(0, options.layoutSettleMs ?? 80);
    this.layoutMaxResizeStep = Math.max(40, Math.min(800, options.layoutMaxResizeStep ?? 400));
  }

  async getState(input: WorkspaceActionInput): Promise<WorkspaceState> {
    return this.syncState(input.clientId, input.uiContext, {});
  }

  async setLayout(input: SetWorkspaceLayoutInput): Promise<WorkspaceState> {
    const layout = normalizeLayout(input.layout);
    const controlMode = controlModeForLayout(layout);
    const synced = await this.syncState(input.clientId, input.uiContext, {
      controlMode,
      activeLayout: layout,
      desiredLayout: layout,
      lastCommand: "set_layout",
      lastActionStatus: "not_attempted",
    });

    if (!this.hyprlandEnabled) {
      return this.writeState({
        ...synced,
        controlMode,
        activeLayout: layout,
        desiredLayout: layout,
        lastCommand: "set_layout",
        lastCommandId: this.commandId(),
        lastActionStatus: "unavailable",
        error: "Hyprland is not available in this process environment.",
        lastUpdatedAt: this.nowIso(),
      });
    }

    try {
      const cleaned = await this.cleanupOverflow(synced);
      await this.applyLayout(cleaned, layout, input);
      const refreshedForVerification = await this.syncState(input.clientId, input.uiContext, {
        controlMode,
        activeLayout: layout,
        desiredLayout: layout,
        lastCommand: "set_layout",
        lastActionStatus: "not_attempted",
      });
      const verification = await this.applyAndVerifyLayout(refreshedForVerification, layout, input);
      const finalState = await this.syncState(input.clientId, input.uiContext, {
        controlMode,
        activeLayout: layout,
        desiredLayout: layout,
        verifiedLayout: verification.verified ? layout : undefined,
        layoutVerification: verification,
        lastCommand: "set_layout",
        lastActionStatus: "not_attempted",
      });
      const status: WorkspaceActionStatus = verification.verified ? "applied" : "failed";
      return this.writeState({
        ...finalState,
        controlMode,
        activeLayout: layout,
        desiredLayout: layout,
        verifiedLayout: verification.verified ? layout : undefined,
        layoutVerification: verification,
        lastCommand: "set_layout",
        lastCommandId: this.commandId(),
        lastActionStatus: status,
        error: verification.verified ? undefined : verification.reason ?? "Workspace layout did not match the requested ratio.",
        lastUpdatedAt: this.nowIso(),
      });
    } catch (err) {
      return this.writeState({
        ...synced,
        controlMode,
        activeLayout: layout,
        desiredLayout: layout,
        lastCommand: "set_layout",
        lastCommandId: this.commandId(),
        lastActionStatus: "failed",
        error: err instanceof Error ? err.message : String(err),
        lastUpdatedAt: this.nowIso(),
      });
    }
  }

  async handleInteractionEvent(input: WorkspaceInteractionInput): Promise<WorkspaceState> {
    if (input.event === "cli_input_started") {
      return this.applyComposeLayout(input);
    }

    if (input.event === "agent_visual_response_started") {
      return this.setLayout({
        clientId: input.clientId,
        uiContext: input.uiContext,
        layout: "30-70",
      });
    }

    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: input.event,
      lastActionStatus: "not_attempted",
    });
    return this.writeState({
      ...state,
      lastCommand: input.event,
      lastCommandId: this.commandId(),
      lastActionStatus: "applied",
      error: undefined,
      lastUpdatedAt: this.nowIso(),
    });
  }

  async focusWindow(input: FocusWorkspaceWindowInput): Promise<WorkspaceState> {
    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: "focus_window",
      lastActionStatus: "not_attempted",
    });
    const target = resolveTargetWindow(state, input);
    if (!target) {
      throw new Error("No matching workspace window was found to focus.");
    }
    if (!this.hyprlandEnabled) {
      return this.writeState({
        ...state,
        lastCommand: "focus_window",
        lastCommandId: this.commandId(),
        lastActionStatus: "unavailable",
        error: "Hyprland is not available in this process environment.",
        lastUpdatedAt: this.nowIso(),
      });
    }

    await this.dispatchHyprland("focuswindow", `address:${target.address}`);
    return this.touchWindow(state, target.address, {
      lastCommand: "focus_window",
      lastActionStatus: "applied",
      error: undefined,
    });
  }

  async registerWindow(input: RegisterWorkspaceWindowInput): Promise<WorkspaceState> {
    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: "register_window",
      lastActionStatus: "not_attempted",
    });
    const now = this.nowIso();
    const updatedWindows = state.windows.map((window) => window.address === input.address
      ? {
        ...window,
        role: input.role,
        ownedByAyati: input.ownedByAyati ?? window.ownedByAyati,
        pinned: input.pinned ?? window.pinned,
        ...(input.contentHint?.trim() ? { contentHint: input.contentHint.trim() } : {}),
        lastUsedAt: now,
        lastSeenAt: now,
      }
      : window);
    return this.writeState({
      ...state,
      windows: updatedWindows,
      lastCommand: "register_window",
      lastCommandId: this.commandId(),
      lastActionStatus: "applied",
      lastUpdatedAt: now,
      error: undefined,
    });
  }

  async reuseOrOpenWindow(input: ReuseOrOpenWorkspaceWindowInput): Promise<WorkspaceState> {
    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: "reuse_or_open_window",
      lastActionStatus: "not_attempted",
    });
    const reusable = input.reuse === false
      ? undefined
      : state.windows.find((window) => window.role === input.role && window.address !== state.anchorCliAddress);

    if (reusable) {
      if (this.hyprlandEnabled) {
        await this.dispatchHyprland("focuswindow", `address:${reusable.address}`);
      }
      return this.touchWindow(updateWindowMetadata(state, reusable.address, input), reusable.address, {
        lastCommand: "reuse_or_open_window",
        lastActionStatus: "reused",
        error: undefined,
      });
    }

    if (!input.command?.trim()) {
      throw new Error(`No reusable ${input.role} window is available and command was not provided.`);
    }

    const cleaned = await this.cleanupOverflow(state, 1);
    const child = this.launchProcess(input.command.trim());
    const launched = this.hyprlandEnabled
      ? await this.waitForLaunchedWindow(cleaned, child, input)
      : null;
    const now = this.nowIso();
    const nextWindows = launched
      ? upsertWindow(cleaned.windows, {
        ...clientToWindowRecord(launched, cleaned, now),
        role: input.role,
        ownedByAyati: input.ownedByAyati ?? true,
        pinned: input.pinned ?? false,
        ...(input.contentHint?.trim() ? { contentHint: input.contentHint.trim() } : {}),
      })
      : cleaned.windows;

    if (launched?.address && this.hyprlandEnabled) {
      if (cleaned.workspaceName) {
        await this.dispatchHyprland("movetoworkspacesilent", `${cleaned.workspaceName},address:${launched.address}`);
      }
      await this.dispatchHyprland("settiled", `address:${launched.address}`);
      await this.dispatchHyprland("focuswindow", `address:${launched.address}`);
    }

    return this.writeState({
      ...cleaned,
      windows: nextWindows,
      lastCommand: "reuse_or_open_window",
      lastCommandId: this.commandId(),
      lastActionStatus: "launched",
      error: launched ? undefined : "Process launched but no matching Hyprland window was found yet.",
      lastUpdatedAt: now,
    });
  }

  async closeWindow(input: CloseWorkspaceWindowInput): Promise<WorkspaceState> {
    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: "close_window",
      lastActionStatus: "not_attempted",
    });
    const target = resolveTargetWindow(state, input);
    if (!target) {
      throw new Error("No matching workspace window was found to close.");
    }
    if (target.address === state.anchorCliAddress && input.allowClosingAnchor !== true) {
      throw new Error("Refusing to close the protected anchor CLI window.");
    }
    if (!this.hyprlandEnabled) {
      return this.writeState({
        ...state,
        lastCommand: "close_window",
        lastCommandId: this.commandId(),
        lastActionStatus: "unavailable",
        error: "Hyprland is not available in this process environment.",
        lastUpdatedAt: this.nowIso(),
      });
    }
    await this.dispatchHyprland("closewindow", `address:${target.address}`);
    return this.writeState({
      ...state,
      windows: state.windows.filter((window) => window.address !== target.address),
      lastCommand: "close_window",
      lastCommandId: this.commandId(),
      lastActionStatus: "closed",
      error: undefined,
      lastUpdatedAt: this.nowIso(),
    });
  }

  async cleanupUnused(input: WorkspaceActionInput): Promise<WorkspaceState> {
    const state = await this.syncState(input.clientId, input.uiContext, {
      lastCommand: "cleanup_unused",
      lastActionStatus: "not_attempted",
    });
    const cleaned = await this.cleanupOverflow(state);
    return this.writeState({
      ...cleaned,
      lastCommand: "cleanup_unused",
      lastCommandId: this.commandId(),
      lastActionStatus: cleaned.windows.length < state.windows.length ? "closed" : "applied",
      error: undefined,
      lastUpdatedAt: this.nowIso(),
    });
  }

  private async syncState(
    clientId: string,
    uiContext: AgentUiContext | undefined,
    patch: Partial<WorkspaceState>,
  ): Promise<WorkspaceState> {
    const current = await this.readState(clientId);
    const now = this.nowIso();
    if (!this.hyprlandEnabled) {
      return this.writeState({
        ...current,
        ...patch,
        schemaVersion: 1,
        clientId: normalizeClientId(clientId),
        hyprlandAvailable: false,
        maxWindows: this.maxWindows,
        lastUpdatedAt: now,
      });
    }

    const [clients, activeWorkspace] = await Promise.all([
      this.readClients(),
      this.readActiveWorkspace(),
    ]);
    const anchor = resolveAnchorClient(clients, uiContext, current);
    const workspace = anchor?.workspace
      ?? workspaceFromUiContext(uiContext)
      ?? currentWorkspace(current)
      ?? activeWorkspace
      ?? null;
    const windows = workspace
      ? clients
        .filter((client) => isClientInWorkspace(client, workspace))
        .filter((client) => client.hidden !== true && client.visible !== false && client.address)
        .map((client) => mergeWindowRecord(client, current, anchor?.address, now))
      : [];

    return this.writeState({
      ...current,
      ...patch,
      schemaVersion: 1,
      clientId: normalizeClientId(clientId),
      hyprlandAvailable: true,
      workspaceId: workspace?.id,
      workspaceName: workspace?.name,
      anchorCliAddress: anchor?.address ?? current.anchorCliAddress,
      controlMode: normalizeControlMode(patch.controlMode ?? current.controlMode ?? controlModeForLayout(patch.activeLayout ?? current.activeLayout)),
      activeLayout: normalizeLayout(patch.activeLayout ?? current.activeLayout),
      desiredLayout: normalizeLayout(patch.desiredLayout ?? current.desiredLayout ?? patch.activeLayout ?? current.activeLayout),
      ...(patch.verifiedLayout
        ? { verifiedLayout: normalizeLayout(patch.verifiedLayout) }
        : current.verifiedLayout && patch.lastCommand !== "set_layout"
          ? { verifiedLayout: current.verifiedLayout }
          : {}),
      maxWindows: this.maxWindows,
      windows,
      lastUpdatedAt: now,
    });
  }

  private async cleanupOverflow(state: WorkspaceState, incomingWindows = 0): Promise<WorkspaceState> {
    if (!this.hyprlandEnabled) {
      return state;
    }
    const overflowCount = state.windows.length + incomingWindows - state.maxWindows;
    if (overflowCount <= 0) {
      return state;
    }
    const candidates = state.windows
      .filter((window) => !window.pinned && window.address !== state.anchorCliAddress)
      .sort(compareCleanupCandidates);
    const toClose = candidates.slice(0, overflowCount);
    if (toClose.length < overflowCount) {
      throw new Error("Workspace is at capacity and no safe window is available to close.");
    }
    for (const window of toClose) {
      await this.dispatchHyprland("closewindow", `address:${window.address}`);
    }
    return {
      ...state,
      windows: state.windows.filter((window) => !toClose.some((closed) => closed.address === window.address)),
    };
  }

  private async applyComposeLayout(input: WorkspaceActionInput): Promise<WorkspaceState> {
    const synced = await this.syncState(input.clientId, input.uiContext, {
      controlMode: "compose-50-50",
      lastCommand: "cli_input_started",
      lastActionStatus: "not_attempted",
    });

    if (!this.hyprlandEnabled) {
      return this.writeState({
        ...synced,
        controlMode: "compose-50-50",
        lastCommand: "cli_input_started",
        lastCommandId: this.commandId(),
        lastActionStatus: "unavailable",
        error: "Hyprland is not available in this process environment.",
        lastUpdatedAt: this.nowIso(),
      });
    }

    const primary = resolvePrimaryWindow(synced, {});
    if (!primary?.address) {
      return this.writeState({
        ...synced,
        controlMode: "compose-50-50",
        lastCommand: "cli_input_started",
        lastCommandId: this.commandId(),
        lastActionStatus: "applied",
        error: undefined,
        lastUpdatedAt: this.nowIso(),
      });
    }

    await this.applyLayout(synced, "50-50", {
      primaryAddress: primary.address,
    });
    const refreshedForVerification = await this.syncState(input.clientId, input.uiContext, {
      controlMode: "compose-50-50",
      activeLayout: "50-50",
      desiredLayout: "50-50",
      lastCommand: "cli_input_started",
      lastActionStatus: "not_attempted",
    });
    const verification = await this.applyAndVerifyLayout(refreshedForVerification, "50-50", {
      primaryAddress: primary.address,
    });
    const finalState = await this.syncState(input.clientId, input.uiContext, {
      controlMode: "compose-50-50",
      activeLayout: "50-50",
      desiredLayout: "50-50",
      verifiedLayout: verification.verified ? "50-50" : undefined,
      layoutVerification: verification,
      lastCommand: "cli_input_started",
      lastActionStatus: "not_attempted",
    });
    const status: WorkspaceActionStatus = verification.verified ? "applied" : "failed";
    return this.writeState({
      ...finalState,
      controlMode: "compose-50-50",
      activeLayout: "50-50",
      desiredLayout: "50-50",
      verifiedLayout: verification.verified ? "50-50" : undefined,
      layoutVerification: verification,
      lastCommand: "cli_input_started",
      lastCommandId: this.commandId(),
      lastActionStatus: status,
      error: verification.verified ? undefined : verification.reason ?? "Workspace compose layout did not match 50-50.",
      lastUpdatedAt: this.nowIso(),
    });
  }

  private async applyLayout(
    state: WorkspaceState,
    layout: WorkspaceLayout,
    input: Pick<SetWorkspaceLayoutInput, "primaryAddress" | "primaryRole">,
  ): Promise<void> {
    if (!state.workspaceName) {
      throw new Error("Cannot arrange workspace without a workspace name.");
    }
    const anchor = state.windows.find((window) => window.address === state.anchorCliAddress)
      ?? state.windows.find((window) => window.role === "cli");
    const primary = resolvePrimaryWindow(state, input);
    const ordered = [anchor, primary, ...state.windows.filter((window) => window !== anchor && window !== primary)]
      .filter((window): window is WorkspaceWindowRecord => Boolean(window));

    for (const window of ordered) {
      await this.dispatchHyprland("movetoworkspacesilent", `${state.workspaceName},address:${window.address}`);
      await this.dispatchHyprland("settiled", `address:${window.address}`);
    }

    if (!anchor) {
      return;
    }

    if (layout === "focus" && primary) {
      await this.dispatchHyprland("focuswindow", `address:${primary.address}`);
      await this.dispatchHyprlandOptional("fullscreenstate", "0 0");
      return;
    }

    if (layout === "grid") {
      await this.dispatchHyprland("focuswindow", `address:${anchor.address}`);
      await this.dispatchHyprlandOptional("splitratio", "exact 0.5");
      return;
    }

    await this.dispatchHyprland("focuswindow", `address:${anchor.address}`);
    if (expectedCliRatioForLayout(layout) !== undefined) {
      return;
    }
    if (primary) {
      await this.dispatchHyprland("focuswindow", `address:${primary.address}`);
    }
  }

  private async applyAndVerifyLayout(
    state: WorkspaceState,
    layout: WorkspaceLayout,
    input: Pick<SetWorkspaceLayoutInput, "primaryAddress" | "primaryRole">,
  ): Promise<WorkspaceLayoutVerification> {
    const expected = expectedCliRatioForLayout(layout);
    if (expected === undefined) {
      return this.measureLayout(state, layout, input);
    }
    const anchor = state.windows.find((window) => window.address === state.anchorCliAddress)
      ?? state.windows.find((window) => window.role === "cli");
    const primary = resolvePrimaryWindow(state, input);
    const invalid = this.validateRatioTargets(layout, anchor, primary);
    if (invalid) {
      return invalid;
    }

    let verification = await this.measureLayout(state, layout, input);
    verification = await this.ensureAnchorOnLeft(state, verification, anchor!.address, layout, input);
    if (verification.verified) {
      return verification;
    }

    let direction = 1;
    let bestDistance = ratioDistance(verification.actualCliRatio, expected);
    let hasDirectionSignal = false;
    for (let attempt = 0; attempt < this.layoutVerificationRetries; attempt++) {
      const command = resizeCommandForMeasurement(verification, expected, direction, this.layoutMaxResizeStep);
      if (!command) {
        return {
          ...verification,
          verified: false,
          measuredAt: this.nowIso(),
          reason: verification.reason
            ? `${verification.reason} Unable to compute a safe relative resize step.`
            : "Unable to compute a safe relative resize step.",
        };
      }

      await this.dispatchHyprland("focuswindow", `address:${anchor!.address}`);
      await this.dispatchHyprlandResizeActive(command.deltaX, 0);
      if (this.layoutSettleMs > 0) {
        await delay(this.layoutSettleMs);
      }

      const beforeDistance = bestDistance;
      verification = await this.measureLayout(state, layout, input);
      verification = await this.ensureAnchorOnLeft(state, verification, anchor!.address, layout, input);
      if (verification.verified) {
        return verification;
      }
      const afterDistance = ratioDistance(verification.actualCliRatio, expected);
      if (afterDistance + 0.002 < bestDistance) {
        bestDistance = afterDistance;
        hasDirectionSignal = true;
        continue;
      }
      if (!hasDirectionSignal || afterDistance > beforeDistance + 0.002) {
        direction *= -1;
        hasDirectionSignal = true;
      }
    }

    return {
      ...verification,
      verified: false,
      reason: verification.reason
        ? `${verification.reason} Retried ${this.layoutVerificationRetries} measured resize step(s).`
        : `Workspace layout did not reach ${layout} after ${this.layoutVerificationRetries} measured resize step(s).`,
    };
  }

  private async ensureAnchorOnLeft(
    state: WorkspaceState,
    verification: WorkspaceLayoutVerification,
    anchorAddress: string,
    layout: WorkspaceLayout,
    input: Pick<SetWorkspaceLayoutInput, "primaryAddress" | "primaryRole">,
  ): Promise<WorkspaceLayoutVerification> {
    if (
      verification.axis !== "horizontal"
      || !verification.anchorGeometry
      || !verification.primaryGeometry
      || verification.anchorGeometry.x <= verification.primaryGeometry.x
    ) {
      return verification;
    }

    await this.dispatchHyprland("focuswindow", `address:${anchorAddress}`);
    await this.dispatchHyprlandOptional("swapwindow", "l");
    if (this.layoutSettleMs > 0) {
      await delay(this.layoutSettleMs);
    }
    return this.measureLayout(state, layout, input);
  }

  private validateRatioTargets(
    layout: WorkspaceLayout,
    anchor: WorkspaceWindowRecord | undefined,
    primary: WorkspaceWindowRecord | undefined,
  ): WorkspaceLayoutVerification | undefined {
    const expected = expectedCliRatioForLayout(layout);
    const measuredAt = this.nowIso();
    if (expected === undefined) {
      return undefined;
    }
    if (!anchor?.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        reason: "Cannot apply ratio layout because the CLI anchor window was not found.",
      };
    }
    if (!primary?.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        anchorAddress: anchor.address,
        reason: "Cannot apply ratio layout because no primary non-CLI window was found.",
      };
    }
    if (primary.address === anchor.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        anchorAddress: anchor.address,
        primaryAddress: primary.address,
        reason: "Cannot apply ratio layout because primaryAddress points to the protected CLI anchor.",
      };
    }
    return undefined;
  }

  private async measureLayout(
    state: WorkspaceState,
    layout: WorkspaceLayout,
    input: Pick<SetWorkspaceLayoutInput, "primaryAddress" | "primaryRole">,
  ): Promise<WorkspaceLayoutVerification> {
    const expected = expectedCliRatioForLayout(layout);
    const measuredAt = this.nowIso();
    if (expected === undefined) {
      return {
        layout,
        verified: true,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        reason: "This layout preset does not require a fixed CLI-to-primary split ratio.",
      };
    }

    const anchorRecord = state.windows.find((window) => window.address === state.anchorCliAddress)
      ?? state.windows.find((window) => window.role === "cli");
    const primaryRecord = resolvePrimaryWindow(state, input);
    if (!anchorRecord?.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        reason: "Cannot verify layout because the CLI anchor window was not found.",
      };
    }
    if (!primaryRecord?.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        anchorAddress: anchorRecord.address,
        reason: "Cannot verify ratio layout because no primary non-CLI window was found.",
      };
    }
    if (primaryRecord.address === anchorRecord.address) {
      return {
        layout,
        verified: false,
        measuredAt,
        tolerance: this.layoutVerificationTolerance,
        expectedCliRatio: expected,
        anchorAddress: anchorRecord.address,
        primaryAddress: primaryRecord.address,
        reason: "Cannot verify ratio layout because the primary window is the CLI anchor.",
      };
    }

    const clients = await this.readClients();
    const anchorClient = clients.find((client) => client.address === anchorRecord.address);
    const primaryClient = clients.find((client) => client.address === primaryRecord.address);
    const anchorGeometry = anchorClient ? geometryFromClient(anchorClient) : undefined;
    const primaryGeometry = primaryClient ? geometryFromClient(primaryClient) : undefined;
    const baseVerification: WorkspaceLayoutVerification = {
      layout,
      verified: false,
      measuredAt,
      tolerance: this.layoutVerificationTolerance,
      expectedCliRatio: expected,
      strategy: anchorClient?.floating || primaryClient?.floating ? "floating-exact" : "tiled-resize",
      anchorAddress: anchorRecord.address,
      primaryAddress: primaryRecord.address,
      ...(anchorGeometry ? { anchorGeometry } : {}),
      ...(primaryGeometry ? { primaryGeometry } : {}),
    };

    if (!anchorClient || !primaryClient) {
      return {
        ...baseVerification,
        reason: "Cannot verify layout because Hyprland did not report both the CLI and primary windows.",
      };
    }
    if (anchorClient.floating !== primaryClient.floating) {
      return {
        ...baseVerification,
        reason: "Cannot verify a ratio layout while only one controlled window is floating.",
      };
    }
    if (!anchorGeometry || !primaryGeometry) {
      return {
        ...baseVerification,
        reason: "Cannot verify layout because Hyprland did not report window geometry.",
      };
    }

    const axis = inferSplitAxis(anchorGeometry, primaryGeometry);
    if (axis !== "horizontal") {
      return {
        ...baseVerification,
        axis,
        actualCliRatio: axis === "vertical"
          ? ratioFromSizes(anchorGeometry.height, primaryGeometry.height)
          : undefined,
        reason: axis === "vertical"
          ? "Workspace split is vertical, but this preset expects CLI on the left and visual content on the right."
          : "Workspace windows overlap, so the split ratio cannot be verified.",
      };
    }

    const actualCliRatio = ratioFromSizes(anchorGeometry.width, primaryGeometry.width);
    if (anchorGeometry.x > primaryGeometry.x) {
      return {
        ...baseVerification,
        axis,
        actualCliRatio,
        reason: "CLI anchor is not positioned to the left of the primary visual window.",
      };
    }

    const verified = Math.abs(actualCliRatio - expected) <= this.layoutVerificationTolerance;
    return {
      ...baseVerification,
      axis,
      actualCliRatio,
      verified,
      ...(verified
        ? { reason: `Measured CLI ratio ${ratioArg(actualCliRatio)} matches requested ${layout}.` }
        : { reason: `Measured CLI ratio ${ratioArg(actualCliRatio)} does not match requested ${layout} (${ratioArg(expected)}).` }),
    };
  }

  private launchProcess(command: string): ChildProcess {
    const child = this.spawnImpl(command, [], {
      detached: true,
      shell: true,
      stdio: "ignore",
    });
    child.unref();
    return child;
  }

  private async waitForLaunchedWindow(
    state: WorkspaceState,
    child: ChildProcess,
    input: ReuseOrOpenWorkspaceWindowInput,
  ): Promise<HyprlandClient | null> {
    const knownAddresses = new Set(state.windows.map((window) => window.address));
    for (let attempt = 0; attempt < this.windowPollAttempts; attempt++) {
      const clients = await this.readClients();
      const match = clients.find((client) => {
        if (!client.address || knownAddresses.has(client.address) || client.hidden === true) {
          return false;
        }
        if (child.pid && client.pid === child.pid) {
          return true;
        }
        if (input.classHint && classMatches(client, input.classHint)) {
          return true;
        }
        if (input.titleHint && client.title?.toLowerCase().includes(input.titleHint.toLowerCase())) {
          return true;
        }
        return false;
      });
      if (match) {
        return match;
      }
      if (this.windowPollIntervalMs > 0) {
        await delay(this.windowPollIntervalMs);
      }
    }
    return null;
  }

  private async readState(clientId: string): Promise<WorkspaceState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      return normalizeState(raw, clientId, this.maxWindows, this.nowIso());
    } catch {
      return this.defaultState(clientId);
    }
  }

  private async writeState(state: WorkspaceState): Promise<WorkspaceState> {
    await writeJsonAtomic(this.statePath, state);
    return state;
  }

  private defaultState(clientId: string): WorkspaceState {
    return {
      schemaVersion: 1,
      clientId: normalizeClientId(clientId),
      hyprlandAvailable: this.hyprlandEnabled,
      controlMode: "agent-30-70",
      activeLayout: "30-70",
      desiredLayout: "30-70",
      maxWindows: this.maxWindows,
      windows: [],
      lastActionStatus: "not_attempted",
      lastUpdatedAt: this.nowIso(),
    };
  }

  private async readClients(): Promise<HyprlandClient[]> {
    const raw = await this.hyprctl(["clients", "-j"]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap(normalizeHyprlandClient);
  }

  private async readActiveWorkspace(): Promise<HyprlandWorkspace | null> {
    const raw = await this.hyprctl(["activeworkspace", "-j"]);
    return normalizeHyprlandWorkspace(JSON.parse(raw) as unknown);
  }

  private async dispatchHyprland(dispatcher: string, args: string): Promise<void> {
    await this.hyprctl(["dispatch", dispatcher, args]);
  }

  private async dispatchHyprlandResizeActive(deltaX: number, deltaY: number): Promise<void> {
    // Keep negative resize deltas inside Hyprland's batch string so hyprctl does not parse them as flags.
    await this.hyprctl(["--batch", `dispatch resizeactive ${deltaX} ${deltaY}`]);
  }

  private async dispatchHyprlandOptional(dispatcher: string, args: string): Promise<void> {
    try {
      await this.dispatchHyprland(dispatcher, args);
    } catch {
      return;
    }
  }

  private async touchWindow(
    state: WorkspaceState,
    address: string,
    patch: Pick<WorkspaceState, "lastCommand" | "lastActionStatus"> & { error?: string },
  ): Promise<WorkspaceState> {
    const now = this.nowIso();
    return this.writeState({
      ...state,
      windows: state.windows.map((window) => window.address === address
        ? { ...window, lastFocusedAt: now, lastUsedAt: now, lastSeenAt: now }
        : window),
      lastCommand: patch.lastCommand,
      lastCommandId: this.commandId(),
      lastActionStatus: patch.lastActionStatus,
      error: patch.error,
      lastUpdatedAt: now,
    });
  }

  private commandId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

const execFileAsync = promisify(execFile);

async function defaultHyprctlRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("hyprctl", args, { encoding: "utf8" });
  return String(result.stdout);
}

interface HyprlandClient {
  address?: string;
  title?: string;
  className?: string;
  initialClassName?: string;
  pid?: number;
  at?: [number, number];
  size?: [number, number];
  floating?: boolean;
  visible?: boolean;
  hidden?: boolean;
  workspace?: HyprlandWorkspace;
  focusHistoryID?: number;
}

interface HyprlandWorkspace {
  id?: number;
  name?: string;
}

function normalizeHyprlandClient(raw: unknown): HyprlandClient[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const record = raw as Record<string, unknown>;
  const workspace = normalizeHyprlandWorkspace(record["workspace"]);
  const at = normalizeNumberTuple(record["at"]);
  const size = normalizeNumberTuple(record["size"]);
  return [{
    ...(typeof record["address"] === "string" ? { address: record["address"] } : {}),
    ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    ...(typeof record["class"] === "string" ? { className: record["class"] } : {}),
    ...(typeof record["initialClass"] === "string" ? { initialClassName: record["initialClass"] } : {}),
    ...(typeof record["pid"] === "number" ? { pid: record["pid"] } : {}),
    ...(at ? { at } : {}),
    ...(size ? { size } : {}),
    ...(typeof record["floating"] === "boolean" ? { floating: record["floating"] } : {}),
    ...(typeof record["visible"] === "boolean" ? { visible: record["visible"] } : {}),
    ...(typeof record["hidden"] === "boolean" ? { hidden: record["hidden"] } : {}),
    ...(typeof record["focusHistoryID"] === "number" ? { focusHistoryID: record["focusHistoryID"] } : {}),
    ...(workspace ? { workspace } : {}),
  }];
}

function normalizeNumberTuple(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    return undefined;
  }
  const first = raw[0];
  const second = raw[1];
  if (typeof first !== "number" || typeof second !== "number") {
    return undefined;
  }
  return [first, second];
}

function normalizeHyprlandWorkspace(raw: unknown): HyprlandWorkspace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["id"] === "number" ? { id: record["id"] } : {}),
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
  };
}

function normalizeState(raw: unknown, clientId: string, maxWindows: number, now: string): WorkspaceState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid workspace state.");
  }
  const record = raw as Record<string, unknown>;
  const layoutVerification = normalizeLayoutVerification(record["layoutVerification"]);
  return {
    schemaVersion: 1,
    clientId: typeof record["clientId"] === "string" ? normalizeClientId(record["clientId"]) : normalizeClientId(clientId),
    hyprlandAvailable: typeof record["hyprlandAvailable"] === "boolean" ? record["hyprlandAvailable"] : false,
    ...(typeof record["workspaceId"] === "number" ? { workspaceId: record["workspaceId"] } : {}),
    ...(typeof record["workspaceName"] === "string" ? { workspaceName: record["workspaceName"] } : {}),
    ...(typeof record["anchorCliAddress"] === "string" ? { anchorCliAddress: record["anchorCliAddress"] } : {}),
    controlMode: normalizeControlMode(record["controlMode"] ?? controlModeForLayout(normalizeLayout(record["activeLayout"]))),
    activeLayout: normalizeLayout(record["activeLayout"]),
    ...(isWorkspaceLayout(record["desiredLayout"]) ? { desiredLayout: record["desiredLayout"] } : {}),
    ...(isWorkspaceLayout(record["verifiedLayout"]) ? { verifiedLayout: record["verifiedLayout"] } : {}),
    ...(layoutVerification ? { layoutVerification } : {}),
    maxWindows,
    windows: normalizeWindowRecords(record["windows"]),
    ...(typeof record["lastCommand"] === "string" ? { lastCommand: record["lastCommand"] } : {}),
    ...(typeof record["lastCommandId"] === "string" ? { lastCommandId: record["lastCommandId"] } : {}),
    lastActionStatus: normalizeActionStatus(record["lastActionStatus"]),
    lastUpdatedAt: typeof record["lastUpdatedAt"] === "string" ? record["lastUpdatedAt"] : now,
    ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
  };
}

function normalizeWindowRecords(raw: unknown): WorkspaceWindowRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["address"] !== "string" || !record["address"].trim()) {
      return [];
    }
    const lastSeenAt = typeof record["lastSeenAt"] === "string" ? record["lastSeenAt"] : new Date(0).toISOString();
    const geometry = normalizeWindowGeometry(record["geometry"]);
    return [{
      address: record["address"].trim(),
      role: normalizeRole(record["role"]),
      ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
      ...(typeof record["className"] === "string" ? { className: record["className"] } : {}),
      ...(typeof record["initialClassName"] === "string" ? { initialClassName: record["initialClassName"] } : {}),
      ...(typeof record["pid"] === "number" ? { pid: record["pid"] } : {}),
      ...(typeof record["floating"] === "boolean" ? { floating: record["floating"] } : {}),
      ...(geometry ? { geometry } : {}),
      ...(typeof record["workspaceId"] === "number" ? { workspaceId: record["workspaceId"] } : {}),
      ...(typeof record["workspaceName"] === "string" ? { workspaceName: record["workspaceName"] } : {}),
      ownedByAyati: typeof record["ownedByAyati"] === "boolean" ? record["ownedByAyati"] : false,
      pinned: typeof record["pinned"] === "boolean" ? record["pinned"] : false,
      ...(typeof record["lastFocusedAt"] === "string" ? { lastFocusedAt: record["lastFocusedAt"] } : {}),
      ...(typeof record["lastUsedAt"] === "string" ? { lastUsedAt: record["lastUsedAt"] } : {}),
      lastSeenAt,
      ...(typeof record["contentHint"] === "string" ? { contentHint: record["contentHint"] } : {}),
    }];
  });
}

function normalizeLayoutVerification(raw: unknown): WorkspaceLayoutVerification | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const layout = normalizeLayout(record["layout"]);
  const measuredAt = typeof record["measuredAt"] === "string" ? record["measuredAt"] : new Date(0).toISOString();
  const axis = record["axis"] === "horizontal" || record["axis"] === "vertical" || record["axis"] === "overlap"
    ? record["axis"]
    : undefined;
  const strategy = record["strategy"] === "floating-exact" || record["strategy"] === "tiled-resize" || record["strategy"] === "none"
    ? record["strategy"]
    : undefined;
  const anchorGeometry = normalizeWindowGeometry(record["anchorGeometry"]);
  const primaryGeometry = normalizeWindowGeometry(record["primaryGeometry"]);
  const workArea = normalizeWindowGeometry(record["workArea"]);
  return {
    layout,
    verified: typeof record["verified"] === "boolean" ? record["verified"] : false,
    measuredAt,
    tolerance: typeof record["tolerance"] === "number" ? record["tolerance"] : 0.08,
    ...(typeof record["expectedCliRatio"] === "number" ? { expectedCliRatio: record["expectedCliRatio"] } : {}),
    ...(typeof record["actualCliRatio"] === "number" ? { actualCliRatio: record["actualCliRatio"] } : {}),
    ...(axis ? { axis } : {}),
    ...(strategy ? { strategy } : {}),
    ...(typeof record["anchorAddress"] === "string" ? { anchorAddress: record["anchorAddress"] } : {}),
    ...(typeof record["primaryAddress"] === "string" ? { primaryAddress: record["primaryAddress"] } : {}),
    ...(anchorGeometry ? { anchorGeometry } : {}),
    ...(primaryGeometry ? { primaryGeometry } : {}),
    ...(workArea ? { workArea } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
  };
}

function normalizeWindowGeometry(raw: unknown): WorkspaceWindowGeometry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const x = record["x"];
  const y = record["y"];
  const width = record["width"];
  const height = record["height"];
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
    return undefined;
  }
  return { x, y, width, height };
}

function resolveAnchorClient(
  clients: HyprlandClient[],
  uiContext: AgentUiContext | undefined,
  state: WorkspaceState,
): HyprlandClient | null {
  if (uiContext?.windowAddress) {
    const byAddress = clients.find((client) => client.address === uiContext.windowAddress);
    if (byAddress) {
      return byAddress;
    }
  }
  if (uiContext?.terminalPid) {
    const byPid = clients.find((client) => client.pid === uiContext.terminalPid);
    if (byPid) {
      return byPid;
    }
  }
  if (state.anchorCliAddress) {
    const stored = clients.find((client) => client.address === state.anchorCliAddress);
    if (stored) {
      return stored;
    }
  }
  const workspace = workspaceFromUiContext(uiContext) ?? currentWorkspace(state);
  return findTerminalClient(clients, workspace) ?? findTerminalClient(clients, null);
}

function findTerminalClient(clients: HyprlandClient[], workspace: HyprlandWorkspace | null): HyprlandClient | null {
  const terminals = clients.filter((client) => {
    if (client.hidden === true || client.visible === false || !client.address) {
      return false;
    }
    if (workspace && !isClientInWorkspace(client, workspace)) {
      return false;
    }
    const className = client.className?.toLowerCase() ?? "";
    const initialClassName = client.initialClassName?.toLowerCase() ?? "";
    return TERMINAL_CLASSES.has(className) || TERMINAL_CLASSES.has(initialClassName);
  });
  return terminals.sort((a, b) => (a.focusHistoryID ?? 9999) - (b.focusHistoryID ?? 9999))[0] ?? null;
}

function workspaceFromUiContext(uiContext: AgentUiContext | undefined): HyprlandWorkspace | null {
  if (!uiContext?.workspaceName && uiContext?.workspaceId === undefined) {
    return null;
  }
  return {
    ...(uiContext.workspaceId !== undefined ? { id: uiContext.workspaceId } : {}),
    ...(uiContext.workspaceName ? { name: uiContext.workspaceName } : {}),
  };
}

function currentWorkspace(state: WorkspaceState): HyprlandWorkspace | null {
  if (state.workspaceId === undefined && !state.workspaceName) {
    return null;
  }
  return {
    ...(state.workspaceId !== undefined ? { id: state.workspaceId } : {}),
    ...(state.workspaceName ? { name: state.workspaceName } : {}),
  };
}

function isClientInWorkspace(client: HyprlandClient, workspace: HyprlandWorkspace): boolean {
  if (workspace.id !== undefined && client.workspace?.id === workspace.id) {
    return true;
  }
  return Boolean(workspace.name && client.workspace?.name === workspace.name);
}

function mergeWindowRecord(
  client: HyprlandClient,
  state: WorkspaceState,
  anchorAddress: string | undefined,
  now: string,
): WorkspaceWindowRecord {
  const existing = client.address
    ? state.windows.find((window) => window.address === client.address)
    : undefined;
  const isAnchor = client.address !== undefined && client.address === anchorAddress;
  const role = isAnchor ? "cli" : existing?.role ?? inferRole(client);
  const geometry = geometryFromClient(client);
  return {
    address: client.address ?? "",
    role,
    ...(client.title ? { title: client.title } : {}),
    ...(client.className ? { className: client.className } : {}),
    ...(client.initialClassName ? { initialClassName: client.initialClassName } : {}),
    ...(client.pid !== undefined ? { pid: client.pid } : {}),
    ...(client.floating !== undefined ? { floating: client.floating } : {}),
    ...(geometry ? { geometry } : {}),
    ...(client.workspace?.id !== undefined ? { workspaceId: client.workspace.id } : {}),
    ...(client.workspace?.name ? { workspaceName: client.workspace.name } : {}),
    ownedByAyati: existing?.ownedByAyati ?? isAyatiClient(client),
    pinned: existing?.pinned ?? isAnchor,
    ...(client.focusHistoryID === 0 ? { lastFocusedAt: now } : existing?.lastFocusedAt ? { lastFocusedAt: existing.lastFocusedAt } : {}),
    lastUsedAt: client.focusHistoryID === 0 ? now : existing?.lastUsedAt ?? now,
    lastSeenAt: now,
    ...(existing?.contentHint ? { contentHint: existing.contentHint } : {}),
  };
}

function clientToWindowRecord(client: HyprlandClient, state: WorkspaceState, now: string): WorkspaceWindowRecord {
  return mergeWindowRecord(client, state, state.anchorCliAddress, now);
}

function updateWindowMetadata(
  state: WorkspaceState,
  address: string,
  input: Pick<ReuseOrOpenWorkspaceWindowInput, "contentHint" | "ownedByAyati" | "pinned" | "role">,
): WorkspaceState {
  return {
    ...state,
    windows: state.windows.map((window) => window.address === address
      ? {
        ...window,
        role: input.role,
        ownedByAyati: input.ownedByAyati ?? window.ownedByAyati,
        pinned: input.pinned ?? window.pinned,
        ...(input.contentHint?.trim() ? { contentHint: input.contentHint.trim() } : {}),
      }
      : window),
  };
}

function upsertWindow(windows: WorkspaceWindowRecord[], window: WorkspaceWindowRecord): WorkspaceWindowRecord[] {
  const others = windows.filter((candidate) => candidate.address !== window.address);
  return [...others, window];
}

function resolveTargetWindow(
  state: WorkspaceState,
  input: { role?: WorkspaceWindowRole; address?: string },
): WorkspaceWindowRecord | undefined {
  if (input.address?.trim()) {
    return state.windows.find((window) => window.address === input.address?.trim());
  }
  if (input.role) {
    return state.windows.find((window) => window.role === input.role);
  }
  return undefined;
}

function resolvePrimaryWindow(
  state: WorkspaceState,
  input: Pick<SetWorkspaceLayoutInput, "primaryAddress" | "primaryRole">,
): WorkspaceWindowRecord | undefined {
  if (input.primaryAddress) {
    return state.windows.find((window) => window.address === input.primaryAddress);
  }
  if (input.primaryRole) {
    return state.windows.find((window) => window.role === input.primaryRole && window.address !== state.anchorCliAddress);
  }
  return state.windows.find((window) => window.role === "primary" && window.address !== state.anchorCliAddress)
    ?? state.windows.find((window) => window.role !== "cli" && window.address !== state.anchorCliAddress);
}

function inferRole(client: HyprlandClient): WorkspaceWindowRole {
  const haystack = `${client.title ?? ""} ${client.className ?? ""} ${client.initialClassName ?? ""}`.toLowerCase();
  if (haystack.includes("preview")) return "preview";
  if (haystack.includes("browser") || haystack.includes("chrom") || haystack.includes("firefox")) return "browser";
  if (haystack.includes("code") || haystack.includes("cursor") || haystack.includes("vscode")) return "code";
  if (haystack.includes("reference") || haystack.includes("docs")) return "reference";
  if (haystack.includes("scratch")) return "scratch";
  if (TERMINAL_CLASSES.has(client.className?.toLowerCase() ?? "") || TERMINAL_CLASSES.has(client.initialClassName?.toLowerCase() ?? "")) {
    return "terminal";
  }
  if (isAyatiClient(client)) return "primary";
  return "secondary";
}

function isAyatiClient(client: HyprlandClient): boolean {
  const haystack = `${client.title ?? ""} ${client.className ?? ""} ${client.initialClassName ?? ""}`.toLowerCase();
  return haystack.includes("ayati");
}

function classMatches(client: HyprlandClient, classHint: string): boolean {
  const expected = classHint.toLowerCase();
  return (client.className?.toLowerCase().includes(expected) ?? false)
    || (client.initialClassName?.toLowerCase().includes(expected) ?? false);
}

function geometryFromClient(client: HyprlandClient): WorkspaceWindowGeometry | undefined {
  if (!client.at || !client.size) {
    return undefined;
  }
  const [x, y] = client.at;
  const [width, height] = client.size;
  return { x, y, width, height };
}

function inferSplitAxis(
  anchorGeometry: WorkspaceWindowGeometry,
  primaryGeometry: WorkspaceWindowGeometry,
): "horizontal" | "vertical" | "overlap" {
  const xDelta = Math.abs(anchorGeometry.x - primaryGeometry.x);
  const yDelta = Math.abs(anchorGeometry.y - primaryGeometry.y);
  if (xDelta === 0 && yDelta === 0) {
    return "overlap";
  }
  return xDelta >= yDelta ? "horizontal" : "vertical";
}

function ratioFromSizes(anchorSize: number, primarySize: number): number {
  const total = anchorSize + primarySize;
  if (total <= 0) {
    return 0;
  }
  return anchorSize / total;
}

function ratioDistance(actual: number | undefined, expected: number): number {
  return actual === undefined ? Number.POSITIVE_INFINITY : Math.abs(actual - expected);
}

function resizeCommandForMeasurement(
  verification: WorkspaceLayoutVerification,
  expected: number,
  direction: number,
  maxStep: number,
): { deltaX: number } | undefined {
  if (
    verification.axis !== "horizontal"
    || !verification.anchorGeometry
    || !verification.primaryGeometry
    || verification.anchorGeometry.x > verification.primaryGeometry.x
  ) {
    return undefined;
  }
  const totalWidth = verification.anchorGeometry.width + verification.primaryGeometry.width;
  if (totalWidth <= 0) {
    return undefined;
  }
  const targetWidth = totalWidth * expected;
  const rawDelta = targetWidth - verification.anchorGeometry.width;
  const deltaX = clamp(Math.round(rawDelta * direction), -maxStep, maxStep);
  if (deltaX === 0) {
    return undefined;
  }
  return { deltaX };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLayout(value: unknown): WorkspaceLayout {
  return isWorkspaceLayout(value)
    ? value
    : "30-70";
}

function normalizeControlMode(value: unknown): WorkspaceControlMode {
  return value === "agent-30-70" || value === "compose-50-50" ? value : "normal";
}

function controlModeForLayout(layout: WorkspaceLayout): WorkspaceControlMode {
  return layout === "30-70" ? "agent-30-70" : "normal";
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  return value === "50-50" || value === "30-70" || value === "20-80" || value === "grid" || value === "focus";
}

function normalizeRole(value: unknown): WorkspaceWindowRole {
  return value === "cli"
    || value === "primary"
    || value === "secondary"
    || value === "browser"
    || value === "code"
    || value === "preview"
    || value === "terminal"
    || value === "reference"
    || value === "scratch"
    ? value
    : "secondary";
}

function normalizeActionStatus(value: unknown): WorkspaceActionStatus {
  return value === "not_attempted"
    || value === "applied"
    || value === "unavailable"
    || value === "failed"
    || value === "reused"
    || value === "launched"
    || value === "closed"
    ? value
    : "not_attempted";
}

function expectedCliRatioForLayout(layout: WorkspaceLayout): number | undefined {
  if (layout === "50-50") return 0.5;
  if (layout === "30-70") return 0.3;
  if (layout === "20-80") return 0.2;
  return undefined;
}

function ratioArg(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function compareCleanupCandidates(a: WorkspaceWindowRecord, b: WorkspaceWindowRecord): number {
  const priority = cleanupPriority(a.role) - cleanupPriority(b.role);
  if (priority !== 0) {
    return priority;
  }
  const aTime = Date.parse(a.lastUsedAt ?? a.lastSeenAt);
  const bTime = Date.parse(b.lastUsedAt ?? b.lastSeenAt);
  return aTime - bTime;
}

function cleanupPriority(role: WorkspaceWindowRole): number {
  if (role === "scratch") return 0;
  if (role === "secondary" || role === "reference") return 1;
  if (role === "browser" || role === "preview") return 2;
  if (role === "terminal" || role === "code" || role === "primary") return 3;
  return 99;
}

function normalizeClientId(clientId: string): string {
  return clientId.trim() || "local";
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

const TERMINAL_CLASSES = new Set([
  "alacritty",
  "foot",
  "ghostty",
  "kitty",
  "org.wezfurlong.wezterm",
  "wezterm",
]);
