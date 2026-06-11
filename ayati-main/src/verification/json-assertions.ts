function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProperty(value: unknown, key: string): unknown {
  if (Array.isArray(value) && /^\d+$/.test(key)) {
    return value[Number(key)];
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
}

export function readJsonPathValues(root: unknown, path: string): unknown[] {
  const trimmed = path.trim();
  if (trimmed === "$") {
    return [root];
  }
  if (!trimmed.startsWith("$.")) {
    return [];
  }

  const tokens = trimmed.slice(2).split(".").filter((token) => token.length > 0);
  let current: unknown[] = [root];

  for (const token of tokens) {
    const next: unknown[] = [];
    const wildcardArray = token.endsWith("[*]");
    const key = wildcardArray ? token.slice(0, -3) : token;

    for (const value of current) {
      if (token === "*") {
        if (Array.isArray(value)) {
          next.push(...value);
        } else if (isRecord(value)) {
          next.push(...Object.values(value));
        }
        continue;
      }

      const selected = key.length > 0 ? readProperty(value, key) : value;
      if (selected === undefined) {
        continue;
      }
      if (wildcardArray) {
        if (Array.isArray(selected)) {
          next.push(...selected);
        }
        continue;
      }
      next.push(selected);
    }

    current = next;
  }

  return current;
}

export function readJsonPathValue(root: unknown, path: string): unknown {
  const values = readJsonPathValues(root, path);
  return values[0];
}

export function jsonPathCount(root: unknown, path: string): number {
  const value = readJsonPathValue(root, path);
  if (Array.isArray(value)) {
    return value.length;
  }
  return readJsonPathValues(root, path).length;
}

