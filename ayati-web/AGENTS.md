<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Rules

- We are building a Next.js web app.
- Keep code human-readable, simple, and maintainable.
- Prefer efficient implementations that follow common, widely used best practices.
- Avoid niche or rarely used techniques unless there is a clear reason to use them.
- Use Zustand as the state management library when shared client state is needed.
- Keep each file under 300 lines whenever practical.
- If a file starts growing too large, split it into smaller components, hooks, utilities, or store modules.
- Favor clear naming, predictable structure, and straightforward logic over clever abstractions.
