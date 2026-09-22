import { appendFile } from 'node:fs/promises';
import { collect } from './lint.mjs';
import { publishLocations, findingFingerprint } from './github.mjs';

export function mergeReports(files, source) {
  const findings = new Map();
  let passed = true;
  for (const file of files) {
    const report = JSON.parse(file.content);
    if (!source.commit || !source.repository || !source.runId ||
        ['commit', 'repository', 'runId'].some(key => report.source?.[key] !== source[key])) throw new Error('Report does not belong to the current repository, PR head, and workflow run');
    if (typeof report.passed !== 'boolean') throw new Error('Invalid saved review verdict');
    passed &&= report.passed;
    if (!report.locations) continue; // The original job retains any localization failure.
    if (!Array.isArray(report.locations.findings)) throw new Error('Invalid saved source findings');
    for (const finding of report.locations.findings) {
      if (typeof finding.path !== 'string' || !finding.path || finding.path.startsWith('/') || finding.path.split(/[\\/]/).includes('..') ||
          !Number.isInteger(finding.line) || finding.line < 1 || !Number.isInteger(finding.endLine) || finding.endLine < finding.line ||
          typeof finding.text !== 'string' || !finding.text || finding.text.length > 1800 ||
          (finding.advisory !== undefined && typeof finding.advisory !== 'boolean') ||
          typeof finding.rule !== 'string' || typeof finding.question !== 'string' || typeof finding.expected !== 'boolean' ||
          !Number.isFinite(finding.probability) || finding.probability < 0.8 || finding.probability > 1) throw new Error('Invalid saved source finding');
      const id = findingFingerprint(finding);
      if (!findings.has(id)) findings.set(id, finding);
    }
  }
  return { passed, locations: { findings: [...findings.values()] } };
}

export async function publishReports(root, env, event, patterns) {
  if (['INPUT_CONFIG', 'INPUT_MODEL', 'INPUT_GLOB', 'INPUT_QUESTIONS'].some(key => env[key]?.trim()) || env.INPUT_LOCATE === 'true' || env['INPUT_POST-COMMENTS'] === 'true') throw new Error('publish-reports cannot be combined with lint or localization inputs');
  if (env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('publish-reports requires a pull_request event');
  for (const pattern of patterns) {
    if (pattern.startsWith('/') || pattern.split(/[\\/]/).includes('..')) throw new Error('publish-reports must be repository-relative');
  }
  // Saved assessments can exceed source size; this mode never sends report contents to Jev.
  const files = await collect(root, patterns, false, { maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });
  const report = mergeReports(files, { repository: env.GITHUB_REPOSITORY, commit: event?.pull_request?.head?.sha, runId: env.GITHUB_RUN_ID });
  const publication = await publishLocations(report, { event, eventName: env.GITHUB_EVENT_NAME, repo: env.GITHUB_REPOSITORY,
    token: env['INPUT_GITHUB-TOKEN'], reviewId: env['INPUT_REVIEW-ID'] || 'jev', maxComments: Number(env['INPUT_MAX-COMMENTS'] || 5) });
  console.log(`Reviewed ${files.length} saved reports; posted ${publication.comments} inline findings in at most one PR review.`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `## Jev inline publication\n\nReports: ${files.length}. Unique localized findings: ${report.locations.findings.length}. Inline comments: ${publication.comments}. Outside the diff: ${publication.outsideDiff}. Unverified: ${publication.unmapped}. Already reported: ${publication.duplicates}.\n\nOriginal lint verdicts and full source findings remain in the agent checks and artifacts. No conversation summaries are posted.\n`);
  return publication;
}
