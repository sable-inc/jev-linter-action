# Jev Linter Action

Review repository files using your own yes/no questions. [TypeSafe Jev](https://docs.typesafe.ai/api) returns probabilities; the action passes only when every expected answer meets its configured threshold. Runs on Node 24 with a checked-in bundle; consumers need no installation step.

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: sable-inc/jev-linter-action@v1
    with:
      model: jev-1.13.0
      glob: 'prompts/**/*.md'
      questions: |
        - Are these instructions internally consistent after honoring explicit overrides?
        - Do these instructions avoid duplicating the same behavioral rule?
        - Are navigation paths grounded in supplied evidence rather than guessed?
      api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

No configuration file is needed. `questions` is a YAML list inside a workflow
block scalar (`|`). A plain question expects **yes**, with probability at least
**0.8**. Write questions as properties that should hold. For negative questions
or custom thresholds, use an object:

```yaml
questions: |
  - id: contradictions
    question: Do these instructions contain contradictory requirements?
    expect: false
    minProbability: 0.85
  - Does the prompt respect the user's requested scope?
```

`glob` accepts one pattern or a newline-separated list. All matched files are
reviewed together by default; `per-file: true` reviews each file independently.
Missing inputs, malformed questions and ambiguous combinations fail before calls.

## Review a complete agent

Build first, then select the artifact. For Sable, `--bundle` includes the resolved configuration,
moments, and local skills; ordinary config output does not include skill bodies:

```yaml
- run: sable build --bundle -f acme/demo
- uses: sable-inc/jev-linter-action@<reviewed-commit>
  with:
    model: jev-1.13.0
    glob: 'acme/demo/.sable/build/agent.bundle.json'
    questions: |
      - Are the agent's prompts, moments, and skills consistent with its personality?
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

No `.jev` files or `per-file` switch are needed. Discover agent folders in your workflow and run
one matrix job per agent. `glob` always selects the actual files to review; the action does not
execute builds or know how to resolve a project's imports. Build all relevant sources first.
Only locally bundled skills are reviewed, not remote-only platform skills.

For multi-suite configurations, the existing `config: .jev-lint.json` input
remains supported (and local CLI file arguments still work). Do not mix `config`
with inline inputs. Its JSON schema is:

```json
{"model":"jev-1.13.0","suites":[{"name":"Prompts","files":["prompts/*.md"],"questions":[{"id":"consistent","question":"Are these instructions consistent?","expect":true,"minProbability":0.8}]}]}
```

Each suite sends all matching files together, preserving filenames, so it can find conflicts across files. Set `"perFile": true` to evaluate each matched file independently, useful when each file contains an assembled agent configuration. Suites and question IDs must be unique. All patterns must match a file. Paths are relative to the repository root; imports outside the root, including symlinks, are refused.

For an expected `false`, the passing probability is `1 - P(yes)`. A probability of 0.5 fails; uncertainty needs review. Thresholds default to 0.8 for inline questions and must exceed 0.5. Calibrate questions and thresholds using labeled acceptable and violating examples. Pin a model version for repeatability; `jev-latest` is also accepted. The model can be wrong, and static lint does not measure how an agent behaves in a call.

Selected file contents and questions are sent to TypeSafe. Select only files appropriate for that service; do not target credentials. The key is used only with the fixed HTTPS TypeSafe endpoint. The action does not execute target files or follow redirects. Use `pull_request`, not privileged execution of untrusted PR code. Fork workflows do not receive repository secrets; skip this job explicitly for forks or run offline checks there. PRs that can edit this action's configuration can change the rubric and targets; retain review for those changes.

Missing keys/files/answers, malformed configuration, API errors, and over-limit input fail closed. Rate limits and transient HTTP failures retry up to three attempts with bounded backoff; each attempt times out after 30 seconds. Provider error bodies and target contents are not logged. Each suite reads at most 128 files, 2 MiB per file and 16 MiB total. Before any paid request,
the action plans the whole review and rejects inputs needing more than 512 requests.

[Jev 1.13](https://docs.typesafe.ai/models) permits 32k tokens for state plus the longest question,
and 64k for state plus all questions. There is no documented public Jev tokenizer. The action
therefore uses conservative **serialized UTF-8 byte budgets**, 28,000 and 60,000 respectively,
leaving room for provider framing. These are not exact token counts and can split text earlier
than necessary. Filenames, escaping, review metadata, and question instructions all count.
Provider errors still fail the check; they are never treated as a pass.

Oversized inputs are split only in memory for API requests; your build artifact stays whole.
Excerpts preserve every Unicode character, carry source character ranges, and overlap by up to
256 characters. The report and GitHub summary identify split reviews. Every request must pass.
**Distant batches are not compared together**: a green split review is not proof of global
consistency. Content is never silently truncated. Questions too large to leave useful context
fail before requests; split the question set in that case.

Outputs: `passed` and `report` (a JSON report path). GitHub gets a step summary and failure annotations. Reports contain filenames, questions, model IDs, raw yes probabilities, thresholds, and verdicts, not target contents. Upload the report explicitly if retention is needed.

Local use:

```sh
npm ci
TYPESAFE_API_KEY=... node /path/to/jev-linter-action/src/main.mjs .jev-lint.json
npm test
npm run build # Rebuild the checked-in Node bundle after changes
```

Install the exact Bun version in [`.bun-version`](.bun-version) before rebuilding.
Local builds enforce this pin and CI reads the same file. Commit the rebuilt
`dist/` files with source changes; CI prints any bundle drift and fails with rebuild instructions.

Exit codes: 0 passed, 1 review check failed, 2 configuration/provider failure. Tests use mocked HTTP responses and need no key. MIT licensed.
