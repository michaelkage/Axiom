# Axiom

**Build software by describing what you want.**

Axiom is an AI-first software-building workspace. Instead of making source code the center of the experience, Axiom lets people describe an outcome, collaborate with an AI agent, follow progress, preview results, and review changes as clear, human-readable topics.

Axiom is being developed from an existing OpenCode-oriented VS Code extension and webview. The current codebase is the starting point: we will preserve useful agent, model, and tool integrations while evolving the product toward a conversation-first experience. Code editing, terminal access, Git details, and raw diffs can remain available as optional power tools.

## Product principles

- **Outcome-first:** describe what you want to build or change.
- **Conversation-first:** iterate on a project naturally.
- **Understandable changes:** summarize changes by topic, with details and diffs available on demand.
- **Visible agents:** explain plans, progress, blockers, and verification.
- **Reliable execution:** validate results, recover from failures with bounded strategies, and report honestly.
- **Flexible models and tools:** keep providers and extensions replaceable.

## Current status

Axiom is in an early transformation stage. The existing repository still contains its original VS Code extension architecture and OpenCode-oriented branding in some areas. The product direction and initial implementation milestone are documented in [AXIOM_PRODUCT_DIRECTION.md](./AXIOM_PRODUCT_DIRECTION.md).

## Development

The current project uses pnpm, TypeScript, SolidJS, Vite, and the OpenCode SDK. Start by reviewing [AGENTS.md](./AGENTS.md) and [HOW-TO-RUN.md](./HOW-TO-RUN.md) for the existing development workflow.

Do not remove existing infrastructure until its role has been checked and the replacement has been tested.
