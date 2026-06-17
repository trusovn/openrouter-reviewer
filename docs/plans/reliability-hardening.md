# OpenRouter Reviewer Reliability Hardening Plan

## Summary

Implement the feedback from the first real usage of `or-review`: environment loading was too brittle, total model failure was reported as success, there is no preflight diagnostic command, pricing is too manual, free models need clearer handling, and zero-dollar free-model budgets are currently rejected by config validation.

This is a targeted reliability pass. Keep the implementation surgical: update config/env loading, CLI exit behavior, preflight checks, pricing resolution, free-model guidance, and the skill template. Do not change context collection, report structure, or assessment behavior unless a task below explicitly requires it.

## Assumptions

- The CLI remains Node.js 20+, TypeScript, ESM, `commander`, and `zod`.
- Existing review commands remain `sdd`, `diff`, and `files`.
- `provider.dataCollection` keeps its current safe default of `deny`.
- Normal review commands may fetch OpenRouter model metadata for pricing preflight, but should use a short-lived cache so every run does not depend on an extra metadata call.
- `or-review doctor` should always be allowed to refresh pricing and endpoint metadata because diagnostics are its purpose.
- The repository currently contains `skill-template/SKILL.md`. If a consuming repository has `.agents/skills/openrouter-review/SKILL.md`, apply the same skill wording there when installing or updating the skill.

## Success Criteria

- A repository-local `.env` containing `OPENROUTER_API_KEY=...` is sufficient for review commands without manually sourcing it.
- Users can also pass an explicit env file, for example `--env-file .env.local`.
- Review commands return a nonzero exit code when every configured model fails.
- Partial model success still writes reports and returns success unless a stricter failure policy is intentionally added later.
- Config stores model IDs, budgets, and pricing-source policy rather than requiring users to manually copy current OpenRouter prices for normal use.
- `or-review doctor` and review preflight resolve current pricing from OpenRouter by default, with optional pinned pricing for stricter reproducibility.
- Fetched pricing is cached briefly so most runs can enforce budgets without an extra metadata dependency.
- `or-review doctor` checks config, model IDs, pricing resolution, API key availability, OpenRouter reachability, and selected model usability under `dataCollection: deny`.
- Config accepts `maxUsdPerRun: 0` for free models at both model and run budget levels.
- Skill instructions reflect the operational lessons: source `.env`, use escalated network after sandbox fetch failures, inspect report statuses even on exit code 0, warn about free models under `dataCollection: deny`, and prefer at least one cheap paid reviewer for stable reviews.

## Implementation Tasks

| # | Task | Files | Verification |
|---|---|---|---|
| T1 | Add `.env` and `--env-file` support | `src/config.ts`, `src/cli.ts`, tests | Unit and CLI tests prove `.env` is loaded before API key checks, explicit env files override discovery as documented, and missing files fail clearly |
| T2 | Return nonzero when all model executions fail | `src/cli.ts`, tests | CLI tests prove all-failed review runs reject/exit nonzero, while mixed success still writes a partial report and exits zero |
| T3 | Add `or-review doctor` preflight command | `src/cli.ts`, new preflight module, tests | Mocked tests cover each doctor check and exit code; live smoke can be run manually with a real key |
| T4 | Resolve pricing from OpenRouter by default | `src/config.ts`, `src/budget.ts`, new pricing/preflight module, tests | Tests prove OpenRouter pricing is fetched, cached, used for budget checks, and can be replaced by pinned pricing |
| T5 | Improve free-model handling | config/budget/openrouter/preflight/docs as needed | Tests and docs cover zero pricing, free model IDs, and warnings when free models may be unavailable under `dataCollection: deny` |
| T6 | Allow zero-dollar budgets | `src/config.ts`, `src/budget.ts`, tests | Schema tests accept `budget.maxUsdPerRun: 0` and `models[].maxUsdPerRun: 0`; budget tests allow estimated zero cost and reject nonzero estimates under a zero cap |
| T7 | Update skill instructions | `skill-template/SKILL.md`, installed skill copy if present | Package/docs tests still pass; manual read confirms the five requested warnings/instructions are present |
| T8 | Update user docs | `README.md`, plan references if needed | Docs mention `.env`, `--env-file`, `doctor`, pricing source, cache behavior, all-failed exit behavior, and free-model caveats |

## T1 - Add `.env` and `--env-file` Support

Add a minimal env-file loader rather than introducing a dependency unless the parser becomes more complex than expected. The loader only needs to support common dotenv syntax:

- Blank lines and `#` comments.
- `KEY=value`.
- Optional single or double quotes around values.
- Do not override an already-set shell environment variable unless the explicit product decision is to let `--env-file` win. Prefer shell environment precedence because it matches common CLI behavior.

Recommended precedence:

1. Existing `process.env`.
2. Explicit `--env-file <path>` for missing keys.
3. Default `<cwd>/.env` for missing keys.

Add `envFile?: string` to CLI override plumbing and make all review commands and `doctor` accept `--env-file`. `assess` does not need it because it does not call OpenRouter.

Verification:

- Unit test parses comments, quoted values, and unquoted values.
- Config/API-key test proves `requireApiKey` succeeds when `.env` exists and the shell does not contain `OPENROUTER_API_KEY`.
- CLI test proves `or-review files --env-file .env.local ...` reaches the injected model executor.
- Test proves missing explicit `--env-file` returns an actionable error.
- Test proves `.env*` files are still excluded from review context collection.

## T2 - Return Nonzero When All Models Fail

After `executeModels` completes and before or after writing the report, inspect the returned statuses. Preserve report output so the user can inspect failures, but raise a `UserError` when every result has `ok: false`.

Suggested behavior:

- All failed: write `report.md`, `report.json`, and raw outputs, print report paths if practical, then exit nonzero with a message such as `All 2 models failed. See <report.md>.`
- Mixed success/failure: write partial report and exit zero.
- No configured models remains invalid through config validation.

Verification:

- CLI test with injected `executeModels` returning all failed results rejects with `All 2 models failed`.
- Test asserts report files still exist for all-failed runs.
- Existing partial failure report tests continue to pass or are extended to assert zero exit for mixed results.

## T3 - Add `or-review doctor`

Add a dedicated preflight command that runs checks without collecting review context or writing a run report.

Proposed command:

```text
or-review doctor [--config <path>] [--env-file <path>]
```

Checks:

- Config file is found and parses.
- Model aliases are present and unique.
- Model IDs are filled.
- Pricing resolves successfully from the configured source. Treat missing OpenRouter pricing as an error in default mode. Treat pinned zero pricing as valid only when both input and output prices are zero.
- `budget.maxUsdPerRun` and `models[].maxUsdPerRun` are valid, including zero.
- API key is available from shell, `--env-file`, or `.env`.
- OpenRouter API is reachable.
- Selected models have usable endpoints under `provider.dataCollection: deny`.

Implementation shape:

- Add a small `doctor.ts` module that returns structured check results: `{ name, ok, severity, message }`.
- Keep network calls injectable for tests.
- Use OpenRouter model metadata for reachability, pricing, and endpoint checks when possible. If endpoint suitability cannot be proven from metadata alone, perform a minimal chat-completions probe with `max_tokens: 1` only when the user has explicitly run `doctor`.
- Print a compact checklist and exit nonzero when any error-level check fails. Warning-level checks should not fail the command.

Verification:

- Mocked tests cover config parse failure, blank model ID, missing/unresolvable pricing, missing API key, unreachable OpenRouter, and deny-incompatible model.
- Test proves warning-only output exits zero.
- Test proves doctor never writes `.or-review/runs`.

## T4 - Resolve Pricing From OpenRouter By Default

Move normal config away from manually copied prices. Config should store the model IDs, budgets, and pricing policy:

```json
{
  "models": [
    {
      "alias": "primary-reviewer",
      "id": "provider/model",
      "maxUsdPerRun": 0.1
    }
  ],
  "pricingSource": "openrouter",
  "budget": {
    "maxUsdPerRun": 0.25,
    "maxOutputTokensPerModel": 2000
  }
}
```

Pricing policy:

- Default `pricingSource` to `"openrouter"`.
- Support `"pinned"` for users who want stricter reproducibility or fully offline budget estimates.
- In `"openrouter"` mode, ignore any stale config pricing for budget enforcement unless it is explicitly used as pinned fallback by a documented option.
- In `"pinned"` mode, require `models[].pricing` and validate it locally.
- Keep `models[].pricing` optional and describe it as pinned pricing, not the normal setup path.

Cache behavior:

- Cache fetched model pricing and relevant endpoint metadata briefly, for example under `.or-review/cache/openrouter-models.json`.
- Include a cache timestamp and source URL/version if available.
- Use a conservative TTL, such as 1 hour, unless a shorter value is needed after implementation.
- `or-review doctor` should refresh or at least validate the cache against OpenRouter by default.
- If OpenRouter metadata fetch fails during a normal run and a fresh enough cache exists, use the cache and emit a warning.
- If no pricing can be resolved, fail before sending review context.

Verification:

- Config tests prove `pricingSource` defaults to `"openrouter"` and accepts `"pinned"`.
- Schema tests prove `models[].pricing` is optional in `"openrouter"` mode and required in `"pinned"` mode.
- Budget tests prove estimates use fetched OpenRouter pricing in default mode.
- Cache tests prove fresh cached pricing avoids a metadata fetch and expired cache is refreshed.
- Failure tests prove review preflight refuses to call model execution when pricing cannot be resolved.
- Doctor tests prove it reports pricing source and cache status clearly.

## T5 - Improve Free-Model Handling

Free models are useful for experimentation but were unstable under `dataCollection: deny`. Improve handling without promising reliability the provider may not offer.

Implementation details:

- Treat OpenRouter-resolved or pinned pricing `{ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }` as valid free pricing.
- In `doctor`, warn when a model ID appears to be a free model and provider privacy is `dataCollection: deny`.
- If OpenRouter returns a provider-routing or no-endpoint error for a free model, preserve the exact failure in the report and include a clearer normalized message.
- Document that at least one cheap paid reviewer is recommended for stable automation.

Verification:

- Unit tests cover free pricing and zero-cost estimates.
- Mocked OpenRouter tests cover a deny/no-endpoint error and assert the failure is visible in `report.md` or `report.json`.
- README and skill template include the free-model caveat.

## T6 - Allow Zero-Dollar Budgets

Change schema validation from `positive()` to `nonnegative()` for:

- `models[].maxUsdPerRun`
- `budget.maxUsdPerRun`

Budget behavior should remain strict:

- Estimated zero cost under cap zero is allowed.
- Any estimated cost greater than zero under cap zero is rejected.
- Negative values remain invalid.

Verification:

- `configSchema` accepts a free model with `maxUsdPerRun: 0`.
- `configSchema` accepts `budget.maxUsdPerRun: 0`.
- Tests reject negative model and run caps.
- Budget tests cover zero estimate allowed and nonzero estimate rejected.

## T7 - Update Skill Instructions

Update `skill-template/SKILL.md` so the optional wrapper tells agents to:

- Source `.env` or pass `--env-file` before checking `OPENROUTER_API_KEY`.
- Use escalated network execution when sandboxed fetches fail with likely network errors.
- Treat exit code 0 as insufficient evidence of review quality; inspect `report.json` model statuses and `report.md`.
- Warn that free models may fail under `dataCollection: deny`.
- Prefer at least one cheap paid reviewer for stable automated reviews.

If `.agents/skills/openrouter-review/SKILL.md` exists in a consuming workspace, update that installed copy with the same operational guidance.

Verification:

- Package/docs test covers the skill template file if existing tests already inspect it.
- Manual check confirms the exact operational guidance is present.

## T8 - Update User Docs

Update `README.md` after implementation so users can discover the new behavior without reading tests.

Docs should include:

- `.env` auto-loading and `--env-file`.
- `or-review doctor` examples.
- `pricingSource: "openrouter"` as the default and `pricingSource: "pinned"` for reproducible/offline estimates.
- Short-lived pricing cache behavior and how to refresh it with `doctor`.
- Exit-code behavior for all-failed versus partial reviews.
- Free-model caveats with `dataCollection: deny`.
- Example free-only config using `maxUsdPerRun: 0`.
- Recommendation to include at least one cheap paid model for stable automation.

Verification:

- `npm run typecheck`
- `npm test`
- `npm run build`
- Manual CLI smoke:

```text
or-review doctor --config or-review.config.json --env-file .env
```

Use escalated network permissions for the live smoke if the sandbox blocks OpenRouter access.
