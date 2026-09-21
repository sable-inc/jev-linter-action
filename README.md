# Jev Linter Action

Review repository files using your own yes/no questions. [TypeSafe Jev](https://docs.typesafe.ai/api) returns probabilities; the action passes only when every expected answer meets its configured threshold. No dependencies, generated bundle, or installation step. Runs on Node 24.

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: sable-inc/jev-linter-action@v1
    with:
      config: .jev-lint.json
      api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

Create `.jev-lint.json`:

```json
{
  "model": "jev-1.13.0",
  "suites": [{
    "name": "Prompt consistency",
    "files": ["prompts/*.md"],
    "questions": [{
      "id": "contradictions",
      "question": "Do these instructions impose incompatible requirements in the same situation, after honoring explicit override precedence?",
      "expect": false,
      "minProbability": 0.8
    }]
  }]
}
```

Each suite sends all matching files together, preserving filenames, so it can find conflicts across files. Set `"perFile": true` to evaluate each matched file independently, useful when each file contains an assembled agent configuration. Suites and question IDs must be unique. All patterns must match a file. Paths are relative to the repository root; imports outside the root, including symlinks, are refused.

For an expected `false`, the passing probability is `1 - P(yes)`. A probability of 0.5 fails; uncertainty needs review. Thresholds are explicit and must exceed 0.5. Calibrate questions and thresholds using labeled acceptable and violating examples. Pin a model version for repeatability; `jev-latest` is also accepted. The model can be wrong, and static lint does not measure how an agent behaves in a call.

Selected file contents and questions are sent to TypeSafe. Select only files appropriate for that service; do not target credentials. The key is used only with the fixed HTTPS TypeSafe endpoint. The action does not execute target files or follow redirects. Use `pull_request`, not privileged execution of untrusted PR code. Fork workflows do not receive repository secrets; skip this job explicitly for forks or run offline checks there. PRs that can edit this action's configuration can change the rubric and targets; retain review for those changes.

Missing keys/files/answers, malformed configuration, API errors, and over-limit input fail closed. Rate limits and transient HTTP failures retry up to three attempts with bounded backoff; each attempt times out after 30 seconds. Provider error bodies and target contents are not logged. Each request is limited to 512 KiB, with at most 128 files per suite and 16 MiB total for a per-file suite. These are byte guards, **not token counts**: respect your model's documented context window and split large documents at meaningful boundaries. Content is never silently truncated.

Outputs: `passed` and `report` (a JSON report path). GitHub gets a step summary and failure annotations. Reports contain filenames, questions, model IDs, raw yes probabilities, thresholds, and verdicts, not target contents. Upload the report explicitly if retention is needed.

Local use:

```sh
TYPESAFE_API_KEY=... node /path/to/jev-linter-action/src/main.mjs .jev-lint.json
npm test
```

Exit codes: 0 passed, 1 review check failed, 2 configuration/provider failure. Tests use mocked HTTP responses and need no key. MIT licensed.
