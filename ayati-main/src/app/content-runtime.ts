import { resolve } from "node:path";
import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import { DirectoryLibrary } from "../files/directory-library.js";
import { FileLibrary } from "../files/file-library.js";
import { SessionAttachmentService } from "../files/session-attachment-service.js";

export interface ContentRuntimeOptions {
  projectRoot: string;
  config: AyatiRuntimeConfig;
}

export interface ContentRuntime {
  sessionAttachmentService: SessionAttachmentService;
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
  uploadsDir: string;
  httpHost: string;
  httpPort: number;
}

export async function createContentRuntime(options: ContentRuntimeOptions): Promise<ContentRuntime> {
  const dataDir = resolve(options.projectRoot, "data");
  const fileLibrary = new FileLibrary({ dataDir });
  const directoryLibrary = new DirectoryLibrary({ dataDir });
  const sessionAttachmentService = new SessionAttachmentService({
    fileLibrary,
    directoryLibrary,
  });

  return {
    sessionAttachmentService,
    fileLibrary,
    directoryLibrary,
    uploadsDir: resolve(dataDir, "uploads"),
    httpHost: options.config.http.host,
    httpPort: options.config.http.port,
  };
}
