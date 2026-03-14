export type ExternalSkillType = "cli" | "shell";
export type ExternalSkillRuntime = "direct" | "plugin";

export interface ExternalSkillMeta {
  id: string;
  type: ExternalSkillType;
  runtime: ExternalSkillRuntime;
  plugin?: string;
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
  description: string;
  dependency?: { check: string; install: string };
  start?: string;
  stop?: string;
}
