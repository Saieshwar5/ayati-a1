export type ExternalSkillType = "cli" | "shell";
export type ExternalSkillRuntime = "direct" | "plugin";
export type ExternalSkillSource = "project" | "global";

export interface ExternalSkillMeta {
  id: string;
  type: ExternalSkillType;
  runtime: ExternalSkillRuntime;
  source: ExternalSkillSource;
  resolvedFrom: string;
  plugin?: string;
  command?: string;
  commands?: string[];
  aliases?: string[];
  description: string;
  skillFilePath: string;
  skillDir: string;
  installed: boolean;
  start?: string;
  stop?: string;
}

export interface ExternalSkillManifest {
  id: string;
  type?: ExternalSkillType;
  runtime?: ExternalSkillRuntime;
  plugin?: string;
  command?: string;
  commands?: string[];
  aliases?: string[];
  description: string;
  dependency?: { check?: string; install?: string };
  start?: string;
  stop?: string;
}

export interface ExternalSkillScanRoot {
  skillsDir: string;
  source?: ExternalSkillSource;
}
