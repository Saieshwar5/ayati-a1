export interface AgentUiContext {
  source: "agent-cli";
  terminalPid?: number;
  processPid?: number;
  processTreePids?: number[];
  windowAddress?: string;
  windowClass?: string;
  windowTitle?: string;
  workspaceId?: number;
  workspaceName?: string;
  monitor?: string;
  detectedAt?: string;
}
