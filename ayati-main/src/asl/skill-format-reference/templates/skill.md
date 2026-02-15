# Skill: your-skill-id

## Purpose

Explain what this skill does in plain language for humans.

## When To Use

1. The user request clearly matches this skill domain.
2. Required credentials are available.
3. The requested operation is allowed by guardrails.

## Typical Flow

1. Choose the right tool from `tools.json`.
2. Provide inputs using that tool schema.
3. Follow policy from `guardrails.json`.
4. Use credentials as declared in `credentials.json`.
5. Check setup requirements in `prerequisites.json`.
6. Use `tests.json` scenarios to validate behavior during development.

## Examples

1. User asks for domain task A -> use `your-skill-id.run`.
2. User asks for domain task B -> use `your-skill-id.run` with different input.
