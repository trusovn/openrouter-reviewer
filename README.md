# openrouter-reviewer

Standalone Node.js 20+ CLI for asking configured OpenRouter models to review SDD artifacts, git diffs, or explicit files.

## Install

```bash
npm install
npm run build
npm link
```

The package exposes the `or-review` binary.

## Configure

```bash
or-review init
```

Edit `or-review.config.json` and fill `models[]` with explicit OpenRouter model IDs and pricing. No model IDs are hardcoded.

Config precedence:

1. CLI flags
2. `./or-review.config.json`
3. `~/.config/or-review/config.json`

Set `OPENROUTER_API_KEY` before running a review. Reports are written under `.or-review/runs/` by default; consuming repos should add `.or-review/` to `.gitignore`.

## Commands

```bash
or-review sdd --feature job-search --instruction "Review acceptance criteria coverage"
or-review diff --base HEAD --instruction "Review this change for regressions"
or-review files --file docs/features/job-search/spec.md --instruction "Review this spec"
or-review assess <run-id> --model primary-reviewer --usefulness 4 --note "Caught one real issue"
```

## Privacy And Budget

The CLI excludes binary files, ignored files, `.env*`, secret-like file names, oversized files, and redacts obvious key/token/password fields plus private-key blocks before sending context.

OpenRouter requests include provider privacy preferences:

```json
{ "dataCollection": "deny", "zdr": false }
```

Each review performs a local cost preflight from configured model prices, context size, and output token caps. Runs fail closed when prices are missing or estimated cost exceeds configured caps.

## Optional Skill

`skill-template/SKILL.md` contains a Codex skill wrapper template for “review externally” workflows. It is optional; humans can use the CLI directly.
