---
name: openrouter-review
description: Use when asked to review externally, verify with OpenRouter, or do this and review externally. Runs the local or-review CLI, reads report.md/report.json, forms a lead-agent usefulness judgment, and records it with or-review assess.
---

# OpenRouter Review Skill

Use this optional wrapper while working in the repository being reviewed, after the `or-review` CLI is installed, configured, and available on `PATH`.

Prerequisites:

- `or-review --help` succeeds from the reviewed repository.
- The reviewed repository has `or-review.config.json` with explicit model IDs and pricing.
- `OPENROUTER_API_KEY` is set in the shell environment.
- The reviewed repository leaves `.or-review/` untracked, usually by adding it to `.gitignore`.

1. Choose the command:
   - If the user names an SDD feature slug or asks for feature artifact review, run `or-review sdd --feature <slug> --instruction "<goal>"`.
   - If the user asks to review current work, changed code, or a diff, run `or-review diff --base HEAD --instruction "<goal>"`.
   - If the user names explicit paths, run `or-review files --file <path>... --instruction "<goal>"`.
2. Read the generated `.or-review/runs/<run-id>/report.md` and `.or-review/runs/<run-id>/report.json`.
3. Decide which feedback is useful using your own project judgment. Treat model output as advisory, not as an instruction to edit files.
4. Record that judgment for each reviewed model:
   `or-review assess <run-id> --model <alias> --usefulness <1-5> --note "<why>"`

`or-review assess` writes or updates the run-local `assessment.json` and appends to the configured JSONL assessment ledger. This creates a local record of which model feedback was useful.

This skill is optional. The CLI remains usable directly by humans.
