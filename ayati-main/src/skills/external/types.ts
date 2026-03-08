export interface ExternalSkillMeta {
  id: string;
  description: string;
  skillFilePath: string;
  skillDir: string;
  installed: boolean;
  start?: string;
  stop?: string;
}

export interface ExternalSkillManifest {
  id: string;
  description: string;
  dependency?: { check: string; install: string };
  start?: string;
  stop?: string;
}
