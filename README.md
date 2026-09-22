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
        - Are navigation paths grounded in supplied evidence rather than guessed?
      api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

Do not use whole-bundle contradiction or semantic-duplication questions as consistency
checks: oversized bundles are split and distant chunks are never compared. Source
localization cannot recover a missing comparison or establish a contradiction pair.
Focused comparisons need representative labeled evaluation before adoption.

No configuration file is needed. `questions` is a YAML list inside a workflow
block scalar (`|`). A plain question expects **yes**, with probability at least
**0.8**. Write questions as properties that should hold. For negative questions
or custom thresholds, use an object:

```yaml
questions: |
  - id: forced_scope
    question: Do the instructions require finishing the itinerary even after the visitor explicitly declines it?
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
      - id: forced_scope
        question: Do the instructions require finishing the itinerary even after the visitor explicitly declines it?
        expect: false
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

No `.jev` files or `per-file` switch are needed. Discover agent folders in your workflow and run
one matrix job per agent. `glob` always selects the actual files to review; the action does not
execute builds or know how to resolve a project's imports. Build all relevant sources first.
Only locally bundled skills are reviewed, not remote-only platform skills.

## Find the authored lines

Enable `locate` to ask **Jev itself** which authored paragraphs contribute to failed rules.
No generative LLM or second provider is needed. `glob` still selects the built agent;
`source-glob` selects the original source files to map findings back to:

```yaml
permissions:
  contents: read
  pull-requests: write # Only needed for post-comments.
steps:
  - uses: actions/checkout@v4
    with:
      ref: ${{ github.event.pull_request.head.sha || github.sha }}
      persist-credentials: false
  - run: sable build --bundle -f acme/demo
  - uses: sable-inc/jev-linter-action@<reviewed-commit>
    with:
      model: jev-1.13.0
      glob: acme/demo/.sable/build/agent.bundle.json
      questions: |
        - id: forced_scope
          question: Must the visitor finish the itinerary even after explicitly declining it?
          expect: false
      locate: true
      source-glob: |
        acme/demo/system/**/*.md
        acme/demo/journey/**/*.md
        acme/demo/skills/**/*.md
        prompts/**/*.md
      locate-max-requests: 32
      post-comments: true
      github-token: ${{ github.token }}
      review-id: acme/demo
      max-comments: 5
      api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

The first review decides pass/fail. For failures, code splits source into paragraphs, finds
unique exact matches in the reviewed text (including JSON-escaped strings), and records the
real file/line ranges. Jev judges a marked passage in the failed review's context against the
failed rules. A localization probability of at least 0.8 produces an annotation. It never
changes the original verdict. Context is cropped around a target only when necessary to keep
both Jev budgets; this is recorded on the finding.

This is conservative text matching, not a compiler source map. Duplicate/ambiguous matches,
transformed text, paragraphs shorter than 32 characters, and individual lines longer than
1,800 characters may remain unlocalized. The failed check remains visible. Localization is
bounded to 32 additional requests by default (configurable 1–512), batching up to four
passages against the failed rules per request and rotating across failed contexts; omitted candidates are reported. A contradiction requires supporting instructions
in that bounded context. These are probabilistic findings, not ground truth or generated fixes.

Annotations work without PR-write access. With a GitHub token having `pull-requests: read`,
localization prioritizes passages in the diff. With `post-comments`, verified findings on added
lines are submitted together in **one PR review**, capped by `max-comments`. No conversation
summaries, empty reviews, or comments about missing findings are posted. Unchanged-line findings,
unmapped passages, and coverage statistics stay in check summaries and report artifacts.
Identical findings are deduplicated across retries and commits, even if line numbers shift.

For a matrix, leave `post-comments: false` in every worker. Upload each worker's `report` output,
then download those artifacts in **one downstream job** and invoke the action once:

```yaml
- uses: sable-inc/jev-linter-action@<reviewed-commit>
  with:
    publish-reports: jev-reports/**/jev-lint-*.json
    github-token: ${{ github.token }}
    review-id: prompt-lint
    max-comments: 5
```

That publishing job needs `contents: read`, `actions: read` for artifact download, and
`pull-requests: write`. It must run after the lint matrix even when judgments fail, using an
`always()` condition that excludes cancelled runs and fork PRs. Reports must belong to the same
repository, head SHA, and workflow run. Publication does not call Jev or need a TypeSafe key;
it merges all findings and applies **one comment limit for the whole PR review**. Its successful
exit means publishing succeeded, not that the original lint checks passed. Use a stable review ID
and workflow concurrency per PR to serialize publication.

Build and localize the PR head as in the checkout example, so coordinates refer to the same
revision used for publication. Stale PR heads and forks cannot receive writes. A merge checkout
may contain base-only changes that make coordinates unverified; GitHub may also omit inline
content for large files. Those findings remain in checks and artifacts. Source patterns may
individually match no files; the total source set must not be empty.

The GitHub token goes only to `api.github.com`; TypeSafe receives the selected review context
and localization questions. The JSON report includes verified source passages when localization
is enabled, so keep report artifacts within the repository's intended audience. Localization
or posting errors return exit code 2 and preserve the original review report/verdict.

For multi-suite configurations, the existing `config: .jev-lint.json` input
remains supported (and local CLI file arguments still work). Do not mix `config`
with inline inputs. Its JSON schema is:

```json
{"model":"jev-1.13.0","suites":[{"name":"Prompts","files":["prompts/*.md"],"questions":[{"id":"forced_scope","question":"Do the instructions require finishing the itinerary even after the visitor explicitly declines it?","expect":false,"minProbability":0.8}]}]}
```

Each suite sends all matching files together, preserving filenames. Only passages present together in a request can be compared. Set `"perFile": true` to evaluate each matched file independently, useful when each file contains an assembled agent configuration. Suites and question IDs must be unique. All patterns must match a file. Paths are relative to the repository root; imports outside the root, including symlinks, are refused.

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

Outputs: `passed` and `report` (a JSON report path). GitHub gets a step summary and failure annotations. Base reports contain filenames, content hashes, questions, model IDs, probabilities, thresholds, and verdicts. Optional localization adds exact source passages and line ranges. Upload the report explicitly if retention is needed.

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

### PR additions as the review target

Set `changed-lines-only: true` with `locate: true`, `source-glob`, and `github-token`
on a same-repository `pull_request` event. Keep `glob` pointed at the full built artifact:
it supplies context. Every rule is asked about actual added source lines, including short
additions, rather than about old problems in neighboring unchanged text. This mode does
not first gate on whole-file judgments. A finding requires at least 0.80 probability of the
opposite of the rule's expected answer. The usual `minProbability` pass gate still applies
to whole-input mode and fixtures. Absence of a finding is not proof of correctness.

Only additions can receive inline comments in either mode; diff context and deleted lines
are never anchors. A changed-line review returns exit 1 for findings, exit 2 for provider
errors, unavailable PR patches or exhausted request limits, and exit 0 otherwise. Source coordinates come directly from the added lines, including template directives,
and are verified again before publishing. Built excerpts supply context. Reports disclose
omitted targets and cropped context. Deletion-only regressions are not covered, and a
finding does not prove that the edit introduced a new behavior relative to the base commit.

Manual full audits and synthetic calibration fixtures should leave this option disabled.
