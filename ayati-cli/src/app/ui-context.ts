import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentUiContext } from "./types.js";

const execFileAsync = promisify(execFile);

interface HyprlandWorkspace {
  id?: number;
  name?: string;
}

interface HyprlandClient {
  address?: string;
  className?: string;
  title?: string;
  pid?: number;
  visible?: boolean;
  hidden?: boolean;
  workspace?: HyprlandWorkspace;
  focusHistoryID?: number;
}

export async function detectAgentCliUiContext(): Promise<AgentUiContext | undefined> {
  if (!process.env["HYPRLAND_INSTANCE_SIGNATURE"]) {
    return undefined;
  }

  try {
    const [clients, processTreePids] = await Promise.all([
      readHyprlandClients(),
      readProcessAncestors(process.pid),
    ]);
    const client = findClientForProcessTree(clients, processTreePids) ?? findFocusedVisibleClient(clients);
    if (!client && processTreePids.length === 0) {
      return undefined;
    }

    return {
      source: "agent-cli",
      processPid: process.pid,
      ...(processTreePids.length > 0 ? { processTreePids } : {}),
      ...(client?.pid ? { terminalPid: client.pid } : {}),
      ...(client?.address ? { windowAddress: client.address } : {}),
      ...(client?.className ? { windowClass: client.className } : {}),
      ...(client?.title ? { windowTitle: client.title } : {}),
      ...(typeof client?.workspace?.id === "number" ? { workspaceId: client.workspace.id } : {}),
      ...(client?.workspace?.name ? { workspaceName: client.workspace.name } : {}),
      detectedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function readHyprlandClients(): Promise<HyprlandClient[]> {
  const result = await execFileAsync("hyprctl", ["clients", "-j"], { encoding: "utf8" });
  const parsed = JSON.parse(String(result.stdout)) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap(normalizeHyprlandClient);
}

async function readProcessAncestors(pid: number): Promise<number[]> {
  const pids: number[] = [];
  const seen = new Set<number>();
  let current = pid;

  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    pids.push(current);
    const parent = await readParentPid(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }

  return pids;
}

async function readParentPid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const rest = stat.slice(closeParen + 1).trim().split(/\s+/);
    const ppid = Number.parseInt(rest[1] ?? "", 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function normalizeHyprlandClient(raw: unknown): HyprlandClient[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const record = raw as Record<string, unknown>;
  const workspace = normalizeWorkspace(record["workspace"]);
  return [{
    ...(typeof record["address"] === "string" ? { address: record["address"] } : {}),
    ...(typeof record["class"] === "string" ? { className: record["class"] } : {}),
    ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    ...(typeof record["pid"] === "number" ? { pid: record["pid"] } : {}),
    ...(typeof record["visible"] === "boolean" ? { visible: record["visible"] } : {}),
    ...(typeof record["hidden"] === "boolean" ? { hidden: record["hidden"] } : {}),
    ...(typeof record["focusHistoryID"] === "number" ? { focusHistoryID: record["focusHistoryID"] } : {}),
    ...(workspace ? { workspace } : {}),
  }];
}

function normalizeWorkspace(raw: unknown): HyprlandWorkspace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["id"] === "number" ? { id: record["id"] } : {}),
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
  };
}

function findClientForProcessTree(clients: HyprlandClient[], processTreePids: number[]): HyprlandClient | null {
  const pidSet = new Set(processTreePids);
  const candidates = clients.filter((client) => (
    client.pid !== undefined
    && pidSet.has(client.pid)
    && client.hidden !== true
  ));
  return sortByFocus(candidates)[0] ?? null;
}

function findFocusedVisibleClient(clients: HyprlandClient[]): HyprlandClient | null {
  return sortByFocus(clients.filter((client) => client.hidden !== true && client.visible !== false))[0] ?? null;
}

function sortByFocus(clients: HyprlandClient[]): HyprlandClient[] {
  return [...clients].sort((a, b) => (a.focusHistoryID ?? 9999) - (b.focusHistoryID ?? 9999));
}
