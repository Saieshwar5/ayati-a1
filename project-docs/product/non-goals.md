# Non-Goals

Do not assume Ayati is trying to be:

- A single prompt wrapper around one provider.
- A CLI-only chatbot.
- A coding assistant only for developers.
- A hosted SaaS product by default.
- A browser-first application in the current codebase.
- A framework-specific coding assistant only for software projects.
- A one-shot automation script that forgets the user after each run.
- A system that creates a new repository for every small feature, lesson, or
  follow-up inside one durable workstream.
- A task system that requires users to understand internal repository or
  context-window implementation details.
- A system that should expose process, filesystem, Python, or database tools to untrusted users without careful policy and deployment review.

Current development should preserve the daemon/client separation and modular runtime shape instead of tightly coupling providers, tools, memory, plugins, and clients together.
