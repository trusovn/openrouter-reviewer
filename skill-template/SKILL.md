---
name: openrouter-review
description: Use when asked to review externally, verify with OpenRouter, or do this and review externally. Runs the local or-review CLI, reads report.md/report.json, forms a lead-agent usefulness judgment, and records it with or-review assess.
---

# OpenRouter Review Skill

Use this optional wrapper after the `or-review` CLI is installed and configured.

1. Choose the command:
   - SDD feature artifact review: `or-review sdd --feature <slug> --instruction "<goal>"`
   - Current diff review: `or-review diff --base HEAD --instruction "<goal>"`
   - Explicit file review: `or-review files --file <path> --instruction "<goal>"`
2. Read the generated `report.md` and `report.json`.
3. Decide which feedback is useful using your own project judgment.
4. Record that judgment:
   `or-review assess <run-id> --model <alias> --usefulness <1-5> --note "<why>"`

This skill is optional. The CLI remains usable directly by humans.

