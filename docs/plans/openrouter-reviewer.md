# OpenRouter External Review CLI Handoff

## Summary
Create a standalone TypeScript/Node CLI repo named `openrouter-reviewer`, with a binary named `or-review`, plus an optional Codex skill wrapper. The tool lets Codex or a human ask one or more OpenRouter models to review SDD artifacts, diffs, or explicit files, then stores Markdown + JSON reports and later lead-agent usefulness assessments.

This plan should first be saved in this repo as `docs/plans/openrouter-reviewer.md` so another agent can implement the standalone repo from it.

## Key Decisions
- Runtime: Node.js 20+, TypeScript, ESM, `pnpm`.
- CLI library: `commander`.
- Validation: `zod`.
- OpenRouter integration: `@openrouter/sdk` or direct chat completions if SDK friction appears; do not use the OpenRouter Agent SDK in v1.
- Reports are read-only: the CLI never edits reviewed files or suggests patches as executable diffs.
- Default privacy: OpenRouter `provider.dataCollection = "deny"` and `provider.zdr = false`.
- Model defaults: no hardcoded model IDs; first run requires explicit config.
- Cost policy: cheap paid models are allowed, bounded by config; v1 estimates cost preflight from configured model prices and context size, caps output tokens, and refuses a run before sending if the estimate exceeds the configured run or model budget.

## CLI Interface
- `or-review init`
  - Creates `or-review.config.json` with empty model slots and documented examples.
- `or-review sdd --feature <slug> --instruction "<goal>"`
  - Reviews SDD artifacts for `docs/features/<slug>`.
- `or-review diff --base HEAD --instruction "<goal>"`
  - Reviews current git diff against the selected base.
- `or-review files --file <path>... --instruction "<goal>"`
  - Reviews explicit files only.
- `or-review assess <run-id> --model <alias> --usefulness 1-5 --note "<text>"`
  - Records lead-agent judgment of how useful each model’s feedback was.

Config precedence order:
1. CLI flags where present
2. `./or-review.config.json`
3. `~/.config/or-review/config.json`

Secret:
- `OPENROUTER_API_KEY`

## Config And Reports
Config should include:
- `models[]`: `{ alias, id, perspective?, maxUsdPerRun? }`
- `provider`: `{ dataCollection: "deny", zdr: false }`
- `budget`: `{ maxUsdPerRun: 0.25, maxOutputTokensPerModel: 2000 }`
- `limits`: `{ maxFileBytes: 200000, maxContextChars: 120000 }`
- `reports`: local untracked output directory

Default report location:
- Use `.or-review/runs/<timestamp>-<short-id>/` in the reviewed repository by default.
- Store the cross-project usefulness ledger under `~/.local/share/or-review/assessments.jsonl` unless overridden in config.
- Ensure `.or-review/` is documented as gitignored by consuming repos.

Each run writes:
- `report.md`
- `report.json`
- `context-preview.md`
- `raw/<model-alias>.json`
- `assessment.json` after assessments are recorded

Also append assessments to a local JSONL ledger so model usefulness can be analyzed later.

## Context Collection
Implement curated collectors:
- `sdd`
  - Include `docs/architecture-map.md`, `docs/adr/*.md`, and current feature artifacts: `CONTEXT.md`, `.size`, `spec.md`, `sad.md`, `data-model.md`, `contracts/`, `tasks.json`, and task docs when present.
- `diff`
  - Include `git diff --stat <base>` and `git diff <base>`.
  - Include both staged and unstaged tracked-file changes by default.
  - Ignore untracked files in v1 unless they are passed through `files --file`.
- `files`
  - Include only paths passed with `--file`.

Automatic safety controls:
- Skip binary files, ignored files, `.env*`, secret files, and files larger than `limits.maxFileBytes`.
- Stop context assembly before `limits.maxContextChars`; list skipped/truncated inputs in `context-preview.md`.
- Redact obvious key/token/password patterns before sending: env-style assignments or JSON/YAML fields containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, plus PEM/private-key blocks.
- Write `context-preview.md` automatically; do not require manual approval before sending.

## OpenRouter Behavior
- Run configured models concurrently.
- Use structured JSON output where supported.
- If structured output is rejected, retry once with prompt-enforced JSON and validate locally.
- If retry output is still invalid JSON, mark that model as failed, preserve its raw output, and continue with a partial report.
- If one model fails, keep successful results and mark the failed model in the partial report.
- Normalize findings into:
  - `id`
  - `modelAlias`
  - `severity`
  - `category`
  - `location`
  - `finding`
  - `evidence`
  - `recommendation`
  - `confidence`

## Codex Skill Wrapper
Ship an optional skill template that triggers on:
- “review externally”
- “verify with OpenRouter”
- “do this and review externally”

Skill behavior:
- Choose `sdd`, `diff`, or `files` based on the user request.
- Run `or-review`.
- Read `report.md` and `report.json`.
- Give Codex’s own opinion on which model feedback is useful.
- Record that opinion with `or-review assess`.

## Implementation Tasks

Implementation target: create the standalone repository `openrouter-reviewer`; keep this file as the handoff contract. Tasks are ordered so each one can be verified independently before the next layer depends on it.

| # | Task | Depends on | Primary verification |
|---|---|---|---|
| T1 | Scaffold the standalone TypeScript CLI package | - | Build, typecheck, test, and `or-review --help` work |
| T2 | Implement config schema, loading, and `init` | T1 | Config precedence and skeleton tests pass |
| T3 | Implement safety, file filtering, and redaction utilities | T1 | Secret/binary/ignored/size-limit fixture tests pass |
| T4 | Implement `sdd`, `diff`, and `files` context collectors | T2, T3 | Collector fixture tests produce expected context previews |
| T5 | Implement budget and cost preflight | T2, T4 | Over-budget runs refuse before any OpenRouter call |
| T6 | Implement OpenRouter model execution | T2, T5 | Mocked success, failure, retry, and invalid JSON tests pass |
| T7 | Implement report normalization and run output | T4, T6 | Markdown, JSON, raw output, and partial report tests pass |
| T8 | Implement `assess` and the usefulness ledger | T2, T7 | Per-run assessment and JSONL append tests pass |
| T9 | Wire CLI commands end to end | T2-T8 | CLI integration tests cover `init`, `sdd`, `diff`, `files`, and `assess` |
| T10 | Add the optional Codex skill template | T9 | Local dry run proves the wrapper invokes `or-review` and records assessment |
| T11 | Add docs, packaging, and release checks | T9, T10 | Pack/install smoke proves the published binary works |
| T12 | Run final acceptance verification | T11 | Fresh fixture repo run produces complete reports without touching reviewed files |

### T1 - Scaffold the standalone TypeScript CLI package

Create a new Node.js 20+, TypeScript, ESM, `pnpm` package with a binary named `or-review`. Add `commander`, `zod`, a test runner, build/typecheck scripts, and the minimal command surface that prints help without implementing behavior yet.

Verification:
- `pnpm install` completes.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- `or-review --help` lists `init`, `sdd`, `diff`, `files`, and `assess`.
- The package metadata exposes the `or-review` binary after a local pack/install smoke.

### T2 - Implement config schema, loading, and `init`

Define the config schema with `zod`, including models, provider privacy settings, budgets, limits, reports, and assessment ledger override. Implement precedence: CLI flags, then `./or-review.config.json`, then `~/.config/or-review/config.json`. Implement `or-review init` so it writes a documented skeleton with empty model slots and no hardcoded model IDs.

Verification:
- Unit tests prove config precedence for every supported override.
- `or-review init` writes a config that validates against the schema.
- Missing config produces an actionable error before context collection starts.
- Missing `OPENROUTER_API_KEY` produces an actionable error before any network call is attempted.
- Provider defaults validate as `dataCollection: "deny"` and `zdr: false`.

### T3 - Implement safety, file filtering, and redaction utilities

Build shared utilities for safe file reads and context preparation: skip binary files, ignored files, `.env*`, likely secret files, and files over `limits.maxFileBytes`; cap assembled context at `limits.maxContextChars`; redact env-style, JSON, and YAML key/token/password patterns; redact PEM/private-key blocks.

Verification:
- Fixture tests prove binary, ignored, `.env*`, secret-named, and oversized files are skipped.
- Redaction tests cover env assignments, JSON fields, YAML fields, and PEM/private-key blocks.
- Tests assert skipped and truncated inputs are listed for `context-preview.md`.
- Tests assert no raw fixture secret appears in the assembled model context.

### T4 - Implement `sdd`, `diff`, and `files` context collectors

Implement curated collectors for all three review modes. `sdd` collects foundation docs and feature artifacts when present. `diff` collects `git diff --stat <base>` and `git diff <base>` for staged and unstaged tracked-file changes while ignoring untracked files. `files` collects only explicit paths passed through `--file`.

Verification:
- `sdd` fixture tests include `docs/architecture-map.md`, `docs/adr/*.md`, and existing feature artifacts.
- `sdd` fixture tests tolerate missing optional feature artifacts and list them in the preview.
- `diff` fixture tests include staged and unstaged tracked changes.
- `diff` fixture tests prove untracked files are ignored unless passed to `files`.
- `files` fixture tests prove only requested paths are included.
- Every collector writes a deterministic `context-preview.md` with included, skipped, truncated, and redacted inputs.

### T5 - Implement budget and cost preflight

Estimate each run before sending data to OpenRouter using configured model prices, context size, and `budget.maxOutputTokensPerModel`. Enforce per-model and per-run budget caps and fail closed when a model lacks enough price information to estimate cost.

Verification:
- Unit tests cover within-budget, per-model over-budget, run over-budget, and missing-price cases.
- Mocked integration tests assert OpenRouter is not called when preflight fails.
- Error messages include the estimated cost, configured cap, and model alias.
- Output token caps are passed into the model request for each configured model.

### T6 - Implement OpenRouter model execution

Implement the OpenRouter client adapter using `@openrouter/sdk` or direct chat completions. Run configured models concurrently. Request structured JSON where supported; if rejected, retry once with prompt-enforced JSON and validate locally. Preserve raw output and continue when one model fails.

Verification:
- Mocked integration tests cover successful structured JSON output.
- Mocked integration tests cover structured-output rejection followed by valid retry output.
- Mocked integration tests cover invalid JSON after retry and mark only that model as failed.
- Mocked integration tests cover one API failure while other models still produce a partial report.
- Tests assert provider privacy settings are sent on each request.

### T7 - Implement report normalization and run output

Normalize model responses into the shared finding shape and write each run under `.or-review/runs/<timestamp>-<short-id>/`. Generate `report.md`, `report.json`, `context-preview.md`, `raw/<model-alias>.json`, and partial-report failure details when needed.

Verification:
- Schema tests validate normalized findings with `id`, `modelAlias`, `severity`, `category`, `location`, `finding`, `evidence`, `recommendation`, and `confidence`.
- Snapshot or golden-file tests cover Markdown report formatting.
- Integration tests prove raw model outputs are preserved under `raw/`.
- Partial failure tests prove successful findings are still written and failed models are clearly marked.
- Tests assert reviewed source files are never modified by report generation.

### T8 - Implement `assess` and the usefulness ledger

Implement `or-review assess <run-id> --model <alias> --usefulness 1-5 --note "<text>"`. Write or update the run-local `assessment.json` and append the assessment to `~/.local/share/or-review/assessments.jsonl` unless config overrides the ledger path.

Verification:
- Unit tests validate usefulness range, required model alias, and required note handling.
- Integration tests prove `assessment.json` is written for a run.
- Integration tests prove the JSONL ledger appends without overwriting prior assessments.
- Tests cover a configured ledger override path.
- Tests reject assessment for an unknown run or unknown model alias with an actionable error.

### T9 - Wire CLI commands end to end

Connect `init`, `sdd`, `diff`, `files`, and `assess` through `commander`, including flags, validation, exit codes, and user-facing messages.

Verification:
- CLI tests cover happy paths for all commands.
- CLI tests cover missing required flags: `--feature`, `--file`, `--instruction`, `--model`, `--usefulness`, and `--note`.
- CLI tests assert failure cases return non-zero exit codes.
- CLI tests assert successful review commands print the run directory and report paths.
- CLI tests run against a fixture repo and prove reports land in `.or-review/runs/`.

### T10 - Add the optional Codex skill template

Ship a skill template that chooses `sdd`, `diff`, or `files`, runs `or-review`, reads `report.md` and `report.json`, forms Codex's usefulness opinion, and records it through `or-review assess`.

Verification:
- A local dry-run fixture proves each trigger phrase maps to the intended mode.
- A dry-run script proves the wrapper can invoke `or-review` and read generated reports.
- A dry-run script proves the wrapper records an assessment through `or-review assess`.
- Documentation makes clear the skill is optional and the CLI remains usable by humans.

### T11 - Add docs, packaging, and release checks

Document installation, config, privacy behavior, budget behavior, `.or-review/` gitignore guidance, command examples, and optional live smoke testing. Add package files needed for publishing without including test fixtures or local run output.

Verification:
- `pnpm pack` succeeds.
- Installing the packed tarball into a temporary project exposes `or-review`.
- The packed binary can run `or-review init` and `or-review --help`.
- Package contents exclude `.or-review/`, fixtures that should not ship, and local environment files.
- README examples match the implemented flags and config schema.

### T12 - Run final acceptance verification

Perform a clean acceptance pass in a fresh fixture repo with a mocked OpenRouter server. Exercise each review mode and assessment flow from the packaged CLI.

Verification:
- `or-review sdd --feature <slug> --instruction "<goal>"` writes all expected run files.
- `or-review diff --base HEAD --instruction "<goal>"` includes tracked staged and unstaged changes.
- `or-review files --file <path> --instruction "<goal>"` includes only explicit files.
- A partial model failure still produces usable `report.md` and `report.json`.
- `or-review assess <run-id> --model <alias> --usefulness 1-5 --note "<text>"` updates both assessment outputs.
- A file checksum check before and after each review proves the reviewed files were not edited.

## Test Plan
- Unit tests:
  - Config precedence.
  - Missing config and missing API key errors.
  - SDD, diff, and file collectors.
  - Redaction and exclusions.
  - Report schema validation.
  - Assessment ledger append behavior.
- CLI tests:
  - `init` writes a valid config skeleton.
  - Partial model failure still writes a usable report.
  - Invalid model JSON is handled predictably.
- Integration tests:
  - Mock OpenRouter success, API failure, invalid JSON, and structured-output rejection.
  - Optional live smoke test only when explicitly enabled with env vars.

## Assumptions
- The implementation plan file should live in this repo at `docs/plans/openrouter-reviewer.md`.
- The actual CLI should be implemented in a separate repo named `openrouter-reviewer`.
- V1 does not support tool-enabled remote agents.
- V1 does not choose models automatically from OpenRouter’s catalog.
- Centralized model-quality analytics beyond JSONL assessment storage is a later story.

## Ambiguity Review
No blocking ambiguities remain for v1 implementation.

Resolved defaults:
- Packaging: standalone CLI repo, with current repo handoff doc.
- Runtime: TypeScript/Node.
- Review style: single-shot reviewers.
- Scope: SDD artifacts, diffs, and explicit files.
- Output: Markdown + JSON.
- Reports: local untracked storage.
- Privacy: automatic scrub/exclude plus OpenRouter data-collection deny.
- Failure policy: partial reports.
- Lead-agent usefulness feedback: persisted via `or-review assess`.
