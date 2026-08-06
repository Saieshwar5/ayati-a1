import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface VoiceRuntimePaths {
  runtimeDirectory: string;
  transcriptDirectory: string;
  controlSocketPath: string;
  voxtypeStatePath: string;
}

export function resolveVoiceRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid?.() ?? 0,
): VoiceRuntimePaths {
  const configuredRuntimeDirectory = env["XDG_RUNTIME_DIR"]?.trim();
  const runtimeBase = configuredRuntimeDirectory && isAbsolute(configuredRuntimeDirectory)
    ? configuredRuntimeDirectory
    : resolve(tmpdir(), `ayati-runtime-${uid}`);
  const ayatiRuntimeDirectory = resolve(runtimeBase, "ayati");
  const configuredSocket = env["AYATI_VOICE_SOCKET_PATH"]?.trim();
  if (configuredSocket && !isAbsolute(configuredSocket)) {
    throw new Error("AYATI_VOICE_SOCKET_PATH must be an absolute path");
  }

  return {
    runtimeDirectory: ayatiRuntimeDirectory,
    transcriptDirectory: resolve(ayatiRuntimeDirectory, "voice-transcripts"),
    controlSocketPath: configuredSocket || resolve(ayatiRuntimeDirectory, "voice.sock"),
    voxtypeStatePath: resolve(runtimeBase, "voxtype", "state"),
  };
}
