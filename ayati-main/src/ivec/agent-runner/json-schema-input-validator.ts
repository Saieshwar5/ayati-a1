export function validateJsonSchemaInput(
  value: unknown,
  schema: Record<string, unknown>,
  options: {
    enforceAdditionalProperties?: boolean;
  } = {},
): string | null {
  return validateNode(value, schema, "", options);
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  options: {
    enforceAdditionalProperties?: boolean;
  },
): string | null {
  const oneOf = Array.isArray(schema["oneOf"])
    ? schema["oneOf"].filter(isRecord)
    : [];
  if (oneOf.length > 0) {
    const discriminated = validateKindDiscriminatedOneOf(
      value,
      oneOf,
      path,
      options,
    );
    if (discriminated.applicable) {
      if (discriminated.error) return discriminated.error;
    } else {
      const results = oneOf.map((candidate) =>
        validateNode(value, candidate, path, options));
      const matches = results.filter((result) => result === null).length;
      if (matches !== 1) {
        const firstFailure = results.find((result): result is string => result !== null);
        return matches === 0
          ? firstFailure ?? `${displayPath(path)} must match one allowed shape`
          : `${displayPath(path)} matches more than one allowed shape`;
      }
    }
  }

  if ("const" in schema && !sameJsonValue(value, schema["const"])) {
    return `${displayPath(path)} must equal ${JSON.stringify(schema["const"])}`;
  }
  if (
    Array.isArray(schema["enum"])
    && !schema["enum"].some((candidate) => sameJsonValue(value, candidate))
  ) {
    return `${displayPath(path)} must be one of ${schema["enum"].map((item) => JSON.stringify(item)).join(", ")}`;
  }

  const expectedType = typeof schema["type"] === "string"
    ? schema["type"]
    : undefined;
  if (expectedType && !matchesJsonSchemaType(value, expectedType)) {
    return `field '${displayPath(path)}' expected type '${expectedType}', got '${describeJsonType(value)}'`;
  }

  if (typeof value === "string") {
    if (
      typeof schema["minLength"] === "number"
      && value.length < schema["minLength"]
    ) {
      return `field '${displayPath(path)}' must contain at least ${schema["minLength"]} characters`;
    }
    if (
      typeof schema["maxLength"] === "number"
      && value.length > schema["maxLength"]
    ) {
      return `field '${displayPath(path)}' must contain at most ${schema["maxLength"]} characters`;
    }
    if (typeof schema["pattern"] === "string") {
      try {
        if (!new RegExp(schema["pattern"]).test(value)) {
          return `field '${displayPath(path)}' does not match the required format`;
        }
      } catch {
        return `field '${displayPath(path)}' uses an invalid validation pattern`;
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      return `field '${displayPath(path)}' must be at least ${schema["minimum"]}`;
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      return `field '${displayPath(path)}' must be at most ${schema["maximum"]}`;
    }
  }

  if (Array.isArray(value)) {
    if (
      typeof schema["minItems"] === "number"
      && value.length < schema["minItems"]
    ) {
      return `field '${displayPath(path)}' must contain at least ${schema["minItems"]} items`;
    }
    if (
      typeof schema["maxItems"] === "number"
      && value.length > schema["maxItems"]
    ) {
      return `field '${displayPath(path)}' must contain at most ${schema["maxItems"]} items`;
    }
    if (schema["uniqueItems"] === true) {
      const keys = value.map(stableJson);
      if (new Set(keys).size !== keys.length) {
        return `field '${displayPath(path)}' must not contain duplicate items`;
      }
    }
    if (isRecord(schema["items"])) {
      for (const [index, item] of value.entries()) {
        const error = validateNode(
          item,
          schema["items"],
          joinPath(path, String(index)),
          options,
        );
        if (error) return error;
      }
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema["properties"])
      ? schema["properties"]
      : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].map(String)
      : [];
    for (const field of required) {
      if (value[field] === undefined || value[field] === null) {
        return `missing required field '${joinPath(path, field)}'`;
      }
    }
    if (
      typeof schema["minProperties"] === "number"
      && Object.keys(value).length < schema["minProperties"]
    ) {
      return `field '${displayPath(path)}' must contain at least ${schema["minProperties"]} properties`;
    }
    if (
      options.enforceAdditionalProperties === true
      && schema["additionalProperties"] === false
    ) {
      const unexpected = Object.keys(value).find((field) => !(field in properties));
      if (unexpected) {
        return `field '${joinPath(path, unexpected)}' is not allowed`;
      }
    }
    for (const [field, propertySchema] of Object.entries(properties)) {
      if (value[field] === undefined || !isRecord(propertySchema)) continue;
      const error = validateNode(
        value[field],
        propertySchema,
        joinPath(path, field),
        options,
      );
      if (error) return error;
    }
  }

  return null;
}

function validateKindDiscriminatedOneOf(
  value: unknown,
  candidates: Record<string, unknown>[],
  path: string,
  options: {
    enforceAdditionalProperties?: boolean;
  },
): { applicable: false } | { applicable: true; error: string | null } {
  if (!isRecord(value)) return { applicable: false };
  const branches = candidates.map(kindDiscriminatedBranch);
  if (branches.some((branch) => branch === undefined)) {
    return { applicable: false };
  }
  const typedBranches = branches.filter(
    (branch): branch is { kind: string; schema: Record<string, unknown> } =>
      branch !== undefined,
  );
  const kinds = typedBranches.map((branch) => branch.kind);
  if (new Set(kinds).size !== kinds.length) return { applicable: false };

  const kind = value["kind"];
  if (kind === undefined || kind === null) {
    return {
      applicable: true,
      error: `missing required field '${joinPath(path, "kind")}'`,
    };
  }
  const selected = typedBranches.find((branch) => branch.kind === kind);
  if (!selected) {
    return {
      applicable: true,
      error: `field '${joinPath(path, "kind")}' must be one of ${kinds.map((item) => JSON.stringify(item)).join(", ")}`,
    };
  }
  return {
    applicable: true,
    error: validateNode(value, selected.schema, path, options),
  };
}

function kindDiscriminatedBranch(
  schema: Record<string, unknown>,
): { kind: string; schema: Record<string, unknown> } | undefined {
  const properties = isRecord(schema["properties"])
    ? schema["properties"]
    : undefined;
  const kindSchema = properties && isRecord(properties["kind"])
    ? properties["kind"]
    : undefined;
  const required = Array.isArray(schema["required"])
    ? schema["required"].map(String)
    : [];
  return kindSchema
    && typeof kindSchema["const"] === "string"
    && required.includes("kind")
    ? { kind: kindSchema["const"], schema }
    : undefined;
}

function matchesJsonSchemaType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  if (expectedType === "object") return isRecord(value);
  if (expectedType === "string") return typeof value === "string";
  if (expectedType === "boolean") return typeof value === "boolean";
  return true;
}

function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function displayPath(path: string): string {
  return path || "input";
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
