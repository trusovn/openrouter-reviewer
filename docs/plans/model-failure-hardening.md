# OpenRouter Reviewer Model Failure Hardening Plan

## Summary

Harden `or-review` for the first real-run failures seen in `job-search`:

1. `qwen/qwen3-coder:free` failed with an upstream provider `429` from Venice.
2. `deepseek/deepseek-v4-pro` returned a response that the CLI did not parse into the expected review JSON shape, causing `Cannot read properties of null (reading 'findings')`.

This plan builds on `docs/plans/openrouter-reviewer.md` and `docs/plans/reliability-hardening.md`. The earlier reliability pass already added `.env` loading, `doctor`, live pricing, zero-dollar budgets, all-model-failed exit behavior, and free-model caveats. This pass should stay focused on model execution resilience, parser robustness, report diagnostics, and docs.

## Current State

Relevant files:

- `src/openrouter.ts`
  - Sends chat completions.
  - Retries once only when structured output is rejected by a 4xx response mentioning `response_format`, `json_schema`, or structured output.
  - Parses `choices[0].message.content` as JSON when it is a string.
  - Returns `message` as-is when content is not a string.
  - Calls `normalize(alias, parsed)`, which assumes `parsed` is object-like.
- `src/reports.ts`
  - Writes model `ok` and `error` fields but no failure kind, retry count, or response metadata.
  - Preserves `raw/<model-alias>.json`.
- `test/openrouter.test.ts`
  - Covers structured-output rejection fallback, invalid string JSON, partial API failure, free-model routing hint, and concurrency.
- `README.md` and `skill-template/SKILL.md`
  - Already warn that free models can be unstable under `dataCollection: deny`.

The `null.findings` crash is reproducible from code inspection: if the model response contains `choices[0].message.content: null`, `parseModelJson` returns `null`, then `normalize` reads `.findings` from `null`.

## Success Criteria

- Provider `429` failures are retried with bounded backoff before the model is marked failed.
- `Retry-After` headers and OpenRouter/provider JSON fields such as `retry_after_seconds` are respected when present, subject to a sane cap.
- A `null`, missing, non-object, malformed, or schema-invalid model response is reported as an invalid structured output failure, not as a TypeError.
- `report.json` and `report.md` clearly distinguish at least:
  - `rate_limited`
  - `invalid_structured_output`
  - `structured_output_unsupported`
  - `api_error`
  - `network_error`
- Raw response data and safe metadata are preserved enough for debugging without forcing the user to infer what happened from a stack trace.
- Existing partial-success behavior remains unchanged: at least one successful model exits zero; all models failed writes reports and exits nonzero.
- Tests cover the real failure classes before the implementation is considered done.

## Non-Goals

- Do not hardcode default model IDs in the CLI.
- Do not add provider-specific model routing logic beyond generic retry/error normalization.
- Do not add a required/optional model policy field yet. For now, consuming repos should keep unstable/free models out of required verification configs.
- Do not change context collection, assessment behavior, or pricing behavior except where needed for failure diagnostics.

## Implementation Tasks

| # | Task | Files | Verification |
|---|---|---|---|
| T1 | Add typed execution failure metadata | `src/openrouter.ts`, `src/reports.ts`, tests | Unit tests assert failure kind, retry count, and safe metadata appear in `report.json` and Markdown |
| T2 | Harden response parsing and schema validation | `src/openrouter.ts`, tests | Null, missing content, non-object JSON, and bad `findings` shapes produce `invalid_structured_output` failures |
| T3 | Add bounded retry/backoff for `429` | `src/openrouter.ts`, tests | Mocked `429` with `retry_after_seconds` retries then succeeds/fails deterministically |
| T4 | Preserve attempt diagnostics | `src/openrouter.ts`, `src/reports.ts`, tests | Raw/attempt output includes status, provider message, retry-after value, and final raw response when available |
| T5 | Improve user-facing messages | `src/openrouter.ts`, `README.md`, `skill-template/SKILL.md` | Reports avoid TypeErrors and explain rate limiting/free-model/provider risks |
| T6 | Add large-context operational guidance | `README.md`, `skill-template/SKILL.md` | Docs tell users to prefer `diff` or narrower `files` reviews for large inputs |
| T7 | Run focused and full verification | tests/package docs | `npm test`, `npm run typecheck`, `npm run build`, plus targeted live smoke when intentionally spending budget |

## T1 - Add Typed Execution Failure Metadata

Extend `ModelExecutionResult` with diagnostic fields that are stable enough for reports:

```ts
type ModelFailureKind =
  | "rate_limited"
  | "invalid_structured_output"
  | "structured_output_unsupported"
  | "api_error"
  | "network_error"
  | "unknown";

type ModelExecutionResult = {
  alias: string;
  modelId: string;
  ok: boolean;
  raw: unknown;
  findings: NormalizedFinding[];
  error?: string;
  failureKind?: ModelFailureKind;
  attempts?: number;
  retryAfterSeconds?: number;
};
```

Keep this additive for compatibility. Existing consumers that only read `ok`, `error`, and `findings` should continue to work.

Update `RunReport.models[]` in `src/reports.ts` to include the new optional fields. Markdown should render a compact suffix for failed models, for example:

```text
- free-coding-reviewer (qwen/qwen3-coder:free): failed - rate_limited - upstream Venice rate limited the request; retried 2 time(s)
```

Verification:

- Add report tests proving `failureKind`, `attempts`, and `retryAfterSeconds` are included in `report.json`.
- Add Markdown assertions for a rate-limited model and an invalid structured output model.
- Existing report tests still pass without changing successful model output shape.

## T2 - Harden Response Parsing and Schema Validation

Replace the current implicit parser with explicit validation before normalization.

Recommended shape:

- `extractMessageContent(raw)` returns `{ content, finishReason?, choiceCount?, contentType }`.
- `parseModelJson(raw)` only succeeds when:
  - a first choice exists,
  - `message.content` is a non-empty string containing JSON, or an already-object value if OpenRouter returns object content for structured output,
  - the parsed value is a non-null object,
  - `findings` exists and is an array.
- Invalid values throw a purpose-specific error, for example `InvalidStructuredOutputError`, with a concise message:
  - `Model response did not include choices[0].message.content.`
  - `Model response content was null.`
  - `Model response content was not valid JSON.`
  - `Model response JSON must be an object with a findings array.`

Use `zod` or a small local validator for the findings shape. Since `zod` is already a dependency, prefer a `modelReviewResponseSchema` in `src/openrouter.ts` or a nearby module. Keep it permissive enough to coerce missing optional fields in `normalize`, but strict about the top-level object and `findings` array.

Implementation detail:

- `normalize` should accept only the validated response type.
- It should never read properties from `unknown` or nullable values.
- Empty findings remain valid.

Verification:

- Add tests for:
  - `choices: []`
  - missing `message`
  - `content: null`
  - `content: ""`
  - `content: "not json"`
  - `content: "null"`
  - `content: "{\"findings\": null}"`
  - `content: "{\"findings\": []}"`
- The invalid cases return a failed `ModelExecutionResult` with `failureKind: "invalid_structured_output"`.
- No invalid case throws out of `executeModels`.
- The valid empty findings case returns `ok: true`.

## T3 - Add Bounded Retry/Backoff For `429`

Add retry handling around each OpenRouter HTTP request. Keep it small and deterministic:

- Retry only HTTP `429` in this pass.
- Use at most 2 retries after the initial attempt.
- Respect retry hints when present:
  - `Retry-After` header in seconds or HTTP-date form.
  - JSON response body fields such as `retry_after_seconds`, `retry_after`, or nested provider error metadata if easy to parse.
- Cap actual sleep to a safe maximum, for example 30 seconds.
- Add a small default delay when no hint is present, for example 1 second then 2 seconds.
- Inject `sleep` and `now` in tests so unit tests do not wait.

Suggested implementation:

```ts
type RetryPolicy = {
  maxRetries: number;
  defaultBackoffMs: (attempt: number) => number;
  maxBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};
```

Do not expose this in config yet unless a real user need appears. A constant policy is enough for this failure mode.

Interaction with structured-output fallback:

- A `429` should retry the same request mode first.
- If structured output is rejected with a non-rate-limit structured-output error, keep the existing fallback to prompt-enforced JSON.
- If fallback JSON mode gets a `429`, retry the fallback request too.

Verification:

- Mocked first request returns `429` with `Retry-After: 2`, second returns success; assert two calls, one sleep, `ok: true`.
- Mocked first request returns `429` with body `{ "error": { "metadata": { "retry_after_seconds": 3 } } }`, second returns success.
- Mocked repeated `429` exhausts retries; assert `ok: false`, `failureKind: "rate_limited"`, `attempts: 3`, and retry metadata in the result.
- Mocked structured-output rejection still falls back once without treating it as retryable rate limiting.
- Concurrency test still proves different configured models start concurrently.

## T4 - Preserve Attempt Diagnostics

`raw/<model-alias>.json` currently stores the successful raw response or `null` when an HTTP error occurs before a raw JSON response exists. That makes provider failures hard to debug.

Improve this without dumping secrets:

- Track attempts per model:
  - request mode: `structured` or `json_prompt`
  - HTTP status when available
  - retry-after seconds when available
  - provider/OpenRouter error message when available
  - whether the attempt was retried
- Keep prompt/context out of attempt diagnostics because the context is already in `context-preview.md`.
- For successful responses, keep current raw response behavior.
- For failed responses, write a structured diagnostic object instead of `null`, for example:

```json
{
  "ok": false,
  "failureKind": "rate_limited",
  "attempts": [
    {
      "mode": "structured",
      "status": 429,
      "retryAfterSeconds": 2,
      "message": "Provider returned rate limit from Venice",
      "retried": true
    }
  ]
}
```

Verification:

- Existing raw-output tests still pass for successful responses.
- New tests assert HTTP failures write diagnostic JSON rather than `null`.
- Diagnostics do not include `Authorization`, API key values, full prompt, or full context.

## T5 - Improve User-Facing Messages

Normalize common error messages:

- `429`:
  - `OpenRouter/provider rate limited this model. Retried N time(s); retry_after_seconds=M.`
  - Include provider text when available, for example `Venice endpoint was temporarily rate-limited`.
- Invalid structured output:
  - `Model returned invalid structured output: <reason>. See raw/<alias>.json.`
- Free model with `dataCollection: deny`:
  - Keep the existing hint, but apply it to provider `429` and endpoint/routing failures when the model ID contains `:free`.

Avoid surfacing implementation errors such as `Cannot read properties of null`.

Verification:

- Test report Markdown and JSON for a null-content response do not contain `Cannot read properties`.
- Test report Markdown includes `invalid structured output`.
- Test free-model `429` includes both rate-limit status and the free-model/privacy caveat.

## T6 - Add Large-Context Operational Guidance

Large file reviews increase the chance that a model ignores structured-output instructions or emits truncated/malformed JSON. Add docs only; do not change collectors in this pass.

Update `README.md` and `skill-template/SKILL.md` with:

- Prefer `or-review diff --base HEAD` for implementation review when a diff is available.
- Prefer `or-review files --file <small-set>` over broad file lists.
- Use `sdd` for feature artifacts, but keep instructions specific.
- When a model fails with invalid structured output on a large context and another model succeeds, consume the successful report and assess the failed model as low usefulness.
- When every model fails on a large context, retry with a narrower `files` or `diff` scope before assuming the tool is broken.

Verification:

- `test/package-docs.test.ts` or equivalent docs tests assert the new guidance appears in README and skill template.

## T7 - Run Verification

Required local verification:

```bash
npm test
npm run typecheck
npm run build
```

Targeted test areas:

- `test/openrouter.test.ts`
- `test/reports-assessments.test.ts`
- `test/package-docs.test.ts`
- Any new retry/parser tests if split into separate files.

Optional live verification, only when intentionally spending OpenRouter budget:

```bash
or-review doctor --env-file .env
or-review files --file README.md --instruction "Smoke test provider retry and structured output handling"
```

Use a config with at least one stable paid reviewer for live verification. Free models may still fail; that is acceptable if the report classifies the failure clearly and at least one paid model succeeds.

## Acceptance Checklist

- A mocked `429` no longer fails immediately.
- A mocked repeated `429` fails as `rate_limited`, not `api_error`.
- A mocked `content: null` fails as `invalid_structured_output`, not a TypeError.
- A malformed model output never prevents other models from producing findings.
- All-failed runs still write reports and exit nonzero.
- Reports include enough metadata for the lead agent to understand whether the failure was provider rate limiting, invalid output, or a normal API failure.
- README and skill template tell users to keep unstable/free models out of required gates and to narrow large reviews when output quality degrades.
