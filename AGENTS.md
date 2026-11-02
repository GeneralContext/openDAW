Readability and maintainability are the driving thesis of this repository. Everything must make sense to a cold reader. Prefer one obvious path over options. Delete a concept before you add one. Add nothing that the work does not use. Everything that developers or agents touch must work.

Use short, direct prose. Add no fluff. Rewrite affected sections when docs change; do not append duplicate rules or change histories.

Start every GitHub description with a summary that takes 10 seconds to understand. Use concise diagrams or code snippets when they improve readability.

Follow the [contributor guide](CONTRIBUTING.md) for this work. Its rules are mandatory wherever they apply.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
