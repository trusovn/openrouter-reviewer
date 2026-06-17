# openrouter-reviewer

Standalone Node.js 20+ CLI for asking configured OpenRouter models to review SDD artifacts, git diffs, or explicit files. It writes Markdown and JSON reports under the reviewed repository and never edits reviewed files.

## Install `or-review`

Build and link the CLI from this repository:

```bash
cd /path/to/openrouter-reviewer
npm install
npm run build
npm link
```

The package exposes the `or-review` binary from `dist/src/cli.js`. Confirm the linked binary is available before switching to the repository you want to review:

```bash
or-review --help
```

For a publish/install smoke:

```bash
npm run build
npm pack --dry-run
npm pack
```

Install the generated `.tgz` into a temporary project and run:

```bash
npm install /path/to/openrouter-reviewer/openrouter-reviewer-<version>.tgz
or-review --help
or-review init
```

## Configure The Reviewed Repo

Run configuration commands from the repository you want OpenRouter to review, not from this tool repository:

```bash
cd /path/to/target-repo
or-review init
```

This writes `or-review.config.json` with empty model IDs. Fill in explicit OpenRouter model IDs before the first review; the CLI has no hardcoded model defaults.

Minimal shape:

```json
{
  "models": [
    {
      "alias": "primary-reviewer",
      "id": "openrouter/model-id",
      "perspective": "general code and artifact reviewer",
      "maxUsdPerRun": 0.1
    }
  ],
  "pricingSource": "openrouter",
  "provider": { "dataCollection": "deny", "zdr": false },
  "budget": { "maxUsdPerRun": 0.25, "maxOutputTokensPerModel": 2000 },
  "limits": { "maxFileBytes": 200000, "maxContextChars": 120000 },
  "reports": { "dir": ".or-review/runs" },
  "assessmentLedger": {}
}
```

Config precedence:

1. CLI flags
2. `./or-review.config.json`
3. `~/.config/or-review/config.json`

Set `OPENROUTER_API_KEY` before running a review. Review commands and `or-review doctor` auto-load a repository-local `.env` for missing environment keys, and you can pass an explicit file with `--env-file .env.local`.

For stable automation, configure at least one cheap paid reviewer. Free models can be useful for smoke tests, but they may be unavailable under `dataCollection: deny`.

## Output And Gitignore

Reports are written to `.or-review/runs/<timestamp>-<short-id>/` by default:

```text
.or-review/runs/<run-id>/report.md
.or-review/runs/<run-id>/report.json
.or-review/runs/<run-id>/context-preview.md
.or-review/runs/<run-id>/raw/<model-alias>.json
```

After `or-review assess`, the run also gets `assessment.json`, and a JSONL assessment is appended to `~/.local/share/or-review/assessments.jsonl` unless `assessmentLedger.path` or `--assessment-ledger-path` overrides it.

Add local review output to the consuming repository's `.gitignore`:

```gitignore
.or-review/
```

Keep `or-review.config.json` in the reviewed repository if the team should share model aliases, budgets, limits, and report location. Keep secrets out of config; the API key is read from `OPENROUTER_API_KEY`.

## Commands

```bash
or-review sdd --feature job-search --instruction "Review acceptance criteria coverage"
or-review diff --base HEAD --instruction "Review this change for regressions"
or-review files --file docs/features/job-search/spec.md --instruction "Review this spec"
or-review doctor
or-review assess <run-id> --model primary-reviewer --usefulness 4 --note "Caught one real issue"
```

Useful overrides:

```bash
or-review doctor --env-file .env.local
or-review diff --base HEAD --instruction "Review this diff" --max-usd-per-run 0.10
or-review files --file README.md --instruction "Review docs" --reports-dir .or-review/runs
or-review assess <run-id> --model primary-reviewer --usefulness 3 --note "Partially useful" --assessment-ledger-path ./assessments.jsonl
```

For large context reviews, prefer `or-review diff --base HEAD` when a diff is available, or `or-review files --file <small-set>` with a narrow set of paths. Broad inputs increase the chance of invalid structured output; if one model fails and another succeeds, use the successful partial report and assess the failed model as low usefulness. If every model fails on a large context, retry with a narrower `files` or `diff` scope before assuming the tool is broken.

## Privacy

The CLI excludes binary files, ignored files, `.env*`, secret-like file names, and files over `limits.maxFileBytes`. It redacts obvious key/token/password fields and private-key blocks before sending context.

OpenRouter requests include provider privacy preferences from config:

```json
{ "dataCollection": "deny", "zdr": false }
```

With `dataCollection: deny`, free models may fail when OpenRouter cannot find a matching privacy-compatible endpoint. The failure is preserved in `report.md` and `report.json`.

`context-preview.md` is written with the assembled review context, included files, skipped files, truncated inputs, and redaction notes so the run can be audited locally.

## Budget

Every review performs a local cost preflight before any OpenRouter call. By default, `"pricingSource": "openrouter"` resolves current pricing from OpenRouter and caches model metadata briefly at `.or-review/cache/openrouter-models.json`. Run `or-review doctor` to refresh and validate pricing, API key availability, OpenRouter reachability, and selected model usability.

Use `"pricingSource": "pinned"` only when you need reproducible or offline estimates. In pinned mode, provide `models[].pricing` in config.

The CLI fails closed when:

- pricing cannot be resolved from OpenRouter or pinned config
- a model estimate exceeds `models[].maxUsdPerRun`
- the total estimate exceeds `budget.maxUsdPerRun`

Output token caps are passed to each model request.

Free-only smoke configs may use zero caps:

```json
{
  "models": [{ "alias": "free-smoke", "id": "provider/model:free", "maxUsdPerRun": 0 }],
  "pricingSource": "openrouter",
  "provider": { "dataCollection": "deny", "zdr": false },
  "budget": { "maxUsdPerRun": 0, "maxOutputTokensPerModel": 1000 }
}
```

If every configured reviewer fails, the command still writes reports and exits nonzero with `All models failed`. If at least one reviewer succeeds, the command writes a partial report and exits zero.

## Optional Skill

`skill-template/SKILL.md` contains a Codex skill wrapper template for "review externally", "verify with OpenRouter", and "do this and review externally" workflows. It is optional; humans can use the CLI directly.

Use the skill when you want Codex, while working in another repository, to call the external reviewer and then judge the result.

1. Install or link `or-review` from this repository and confirm `or-review --help` works on your shell `PATH`.
2. In the target repository, run `or-review init`, edit `or-review.config.json`, set `OPENROUTER_API_KEY` directly or through `.env`/`--env-file`, run `or-review doctor`, and add `.or-review/` to that repository's `.gitignore`.
3. Copy or install `skill-template/SKILL.md` as a Codex skill, for example under your Codex skills directory as `openrouter-review/SKILL.md`.
4. Start Codex in the target repository and use a trigger phrase such as "review externally", "verify with OpenRouter", or "do this and review externally".

The skill chooses the CLI mode from the user request:

- `or-review sdd --feature <slug>` when the request names an SDD feature slug or asks for feature artifact review.
- `or-review diff --base HEAD` when the request asks to review current work, changed code, or a diff.
- `or-review files --file <path>...` when the request names explicit paths.

After the review, the skill reads `.or-review/runs/<run-id>/report.md` and `report.json`, decides which model feedback is useful using Codex's own project judgment, and records that judgment with:

```bash
or-review assess <run-id> --model <alias> --usefulness <1-5> --note "<why>"
```

`or-review assess` updates the run-local `assessment.json` and appends to the configured assessment ledger, so repeated skill use creates a local usefulness history for the reviewed repository and selected models.

## Live Smoke

Only run a live smoke when you intentionally want to spend OpenRouter budget:

```bash
export OPENROUTER_API_KEY=...
or-review doctor
or-review files --file README.md --instruction "Smoke test the reviewer packaging and docs"
```

Confirm the command prints the run directory plus Markdown and JSON report paths, then inspect `.or-review/runs/<run-id>/context-preview.md` before sharing or committing anything from the run.

For local mocked acceptance tests, set `OPENROUTER_BASE_URL` to an OpenAI-compatible server root, for example `http://127.0.0.1:3000/v1`. Normal usage does not need this variable; requests default to OpenRouter.
