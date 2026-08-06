const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 32_000;

export interface VoiceRuntimeConfig {
  enabled: boolean;
  autoSend: boolean;
  notificationsEnabled: boolean;
  showTranscriptPreview: boolean;
  showReplyPreview: boolean;
  command: string;
  transcriptionTimeoutMs: number;
  maxTranscriptChars: number;
}

export function loadVoiceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): VoiceRuntimeConfig {
  return {
    enabled: readBoolean(env["AYATI_VOICE_ENABLED"], true),
    autoSend: readBoolean(env["AYATI_VOICE_AUTO_SEND"], false),
    notificationsEnabled: readBoolean(env["AYATI_VOICE_NOTIFICATIONS"], true),
    showTranscriptPreview: readBoolean(env["AYATI_VOICE_SHOW_TRANSCRIPT"], true),
    showReplyPreview: readBoolean(env["AYATI_VOICE_SHOW_REPLY"], true),
    command: env["AYATI_VOICE_COMMAND"]?.trim() || "voxtype",
    transcriptionTimeoutMs: readInteger(
      env["AYATI_VOICE_TRANSCRIPTION_TIMEOUT_MS"],
      DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
      5_000,
      300_000,
    ),
    maxTranscriptChars: readInteger(
      env["AYATI_VOICE_MAX_TRANSCRIPT_CHARS"],
      DEFAULT_MAX_TRANSCRIPT_CHARS,
      100,
      100_000,
    ),
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean voice setting: ${value}`);
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Voice setting must be an integer from ${minimum} through ${maximum}: ${value}`);
  }
  return parsed;
}
