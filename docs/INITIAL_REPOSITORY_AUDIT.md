# Axiom Repository Audit — Initial Pass

Branch: `axiom/product-rebuild`

## Product direction

Axiom is an AI-first software-building app. The default experience should center on ideas, project conversations, task progress, previews, and human-readable change topics. Source editing, terminal access, and detailed diffs remain optional power-user capabilities.

## Existing architecture observed

The current repository is a TypeScript/SolidJS webview and VS Code extension that uses the OpenCode SDK. The current empty-session UI renders the chat input and permission prompts; the conversation UI renders messages, file-change summaries, context information, and permissions.

## Preserve for now

- OpenCode SDK/provider/session integration
- Message streaming and synchronization state
- Prompt composer and file mention support
- Permission prompts and response flow
- Message queue, cancellation, edit/revert flow
- File change summary and context indicator
- Existing Vitest, Playwright, TypeScript, and build scripts

These capabilities should only be removed if a replacement is implemented and verified.

## Initial changes made

- Added `AXIOM_PRODUCT_DIRECTION.md` defining the product principles and staged architecture.
- Rewrote the README to explain Axiom's conversation-first direction.
- Added `WelcomeScreen.tsx` with a project-building welcome experience and clickable prompt starters.
- Integrated the welcome screen into the empty-session view; starters populate the existing prompt input rather than bypassing the established send flow.
- Added responsive styling for the new welcome experience.
- Updated the package's display name and description and changed the standalone page title to Axiom.

## Cleanup decision

No source files or dependencies have been deleted in this pass. A reliable unused-dependency report requires installing dependencies and running package/build/test tooling in a checkout. Deleting files remotely before that check risks breaking extension packaging or existing functionality.

## Workflow milestone: prompt → plan → execute → verify → explain

The first vertical slice should be implemented in this order:

1. **Plan:** represent a proposed plan explicitly and make the transition from plan to execution visible.
2. **Execute:** use the existing SDK/runtime and session events; don't introduce a parallel execution path.
3. **Verify:** report only checks that actually ran, capture their results, and distinguish failed checks from checks that were not available.
4. **Explain:** group results into human-readable topics, with affected files and detailed diffs behind an expandable control.
5. **Recover:** classify failures, apply bounded retries only where safe, and keep the original error available.

## Intelligence expansion gates

- **Agent delegation:** introduce after task state and execution events can represent parent/child tasks and dependencies.
- **Combos:** define as versioned workflow configuration (model preferences, worker policy, budget, permissions, and verification), not hard-coded UI presets.
- **Local-model recovery:** detect provider/server errors, timeouts, malformed output, context overflow, and tool/build errors separately.
- **Context optimization:** start with relevance-based retrieval and compact summaries; measure token count, latency, and task success before claiming savings.
- **Plugins:** document a capability API and permissions before loading third-party extensions; do not execute untrusted plugins with unrestricted access.

## Validation status

This remote editing pass did not run a local package install, TypeScript check, unit tests, Playwright tests, or extension packaging. Run those in a checkout before merging. Review branding changes carefully because internal command IDs and protocol names may need to remain OpenCode-compatible.
