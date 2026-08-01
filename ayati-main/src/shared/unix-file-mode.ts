export interface UnixFileMode {
  modeOctal: string;
  modeSymbolic: string;
}

export function formatUnixFileMode(mode: number): UnixFileMode {
  const permissions = mode & 0o7777;
  return {
    modeOctal: permissions.toString(8).padStart(4, "0"),
    modeSymbolic: [
      bit(permissions, 0o400, "r"),
      bit(permissions, 0o200, "w"),
      executeBit(permissions, 0o100, 0o4000, "s", "S"),
      bit(permissions, 0o040, "r"),
      bit(permissions, 0o020, "w"),
      executeBit(permissions, 0o010, 0o2000, "s", "S"),
      bit(permissions, 0o004, "r"),
      bit(permissions, 0o002, "w"),
      executeBit(permissions, 0o001, 0o1000, "t", "T"),
    ].join(""),
  };
}

export function parseUnixFileMode(
  modeOctal: unknown,
  modeSymbolic: unknown,
): UnixFileMode | undefined {
  if (
    typeof modeOctal !== "string"
    || !/^[0-7]{4}$/.test(modeOctal)
    || typeof modeSymbolic !== "string"
  ) {
    return undefined;
  }
  const normalized = formatUnixFileMode(Number.parseInt(modeOctal, 8));
  return normalized.modeOctal === modeOctal
    && normalized.modeSymbolic === modeSymbolic
    ? normalized
    : undefined;
}

function bit(mode: number, mask: number, enabled: string): string {
  return (mode & mask) !== 0 ? enabled : "-";
}

function executeBit(
  mode: number,
  executeMask: number,
  specialMask: number,
  enabledSpecial: string,
  disabledSpecial: string,
): string {
  const executable = (mode & executeMask) !== 0;
  if ((mode & specialMask) === 0) {
    return executable ? "x" : "-";
  }
  return executable ? enabledSpecial : disabledSpecial;
}
