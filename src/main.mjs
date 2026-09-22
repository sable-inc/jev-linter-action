import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { lint } from './lint.mjs';
import { loadConfig } from './inputs.mjs';
import { locate, locationOptions } from './locations.mjs';
import { publishLocations, sourceLink, reviewDiff } from './github.mjs';
import { publishReports } from './reports.mjs';

const escape = text => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const markdown = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const property = text => escape(text).replaceAll(',', '%2C').replaceAll(':', '%3A');
async function main() {
  const root = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : undefined;
  const reports = (process.env['INPUT_PUBLISH-REPORTS'] || '').split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  if (reports.length) return publishReports(root, process.env, event, reports);
  const config = await loadConfig(root, process.env, process.argv[2]);
  const options = locationOptions(process.env);
  const apiKey = process.env['INPUT_API-KEY'] || process.env.TYPESAFE_API_KEY;
  const report = await lint(config, root, apiKey);
  report.source = { repository: process.env.GITHUB_REPOSITORY, commit: event?.pull_request?.head?.sha || process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID };
  let extensionFailed = false;
  if (options.enabled) {
    try {
      const priority = process.env['INPUT_GITHUB-TOKEN'] && report.results.some(r => !r.passed) ? await reviewDiff({ event, eventName: process.env.GITHUB_EVENT_NAME, repo: process.env.GITHUB_REPOSITORY, token: process.env['INPUT_GITHUB-TOKEN'] }) : new Map();
      report.locations = await locate(report, root, { ...options, model: config.model, apiKey, priority });
      for (const finding of report.locations.findings) {
        const message = `${finding.advisory ? 'Advisory' : 'Possible'} ${finding.rule} finding: ${finding.question} Required answer: ${finding.expected ? 'yes' : 'no'}. Jev localized this passage with probability ${finding.probability.toFixed(2)}. Review it in context.`;
        if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${finding.advisory ? 'warning' : 'error'} file=${property(finding.path)},line=${finding.line},endLine=${finding.endLine},title=${property(`Jev: ${finding.rule}`)}::${escape(message)}`);
        else console.log(`${finding.path}:${finding.line}-${finding.endLine} ${escape(message)}`);
      }
      if (options.post && report.locations.findings.length > 0) {
        report.locations.publication = await publishLocations(report, { event, eventName: process.env.GITHUB_EVENT_NAME, repo: process.env.GITHUB_REPOSITORY,
          token: process.env['INPUT_GITHUB-TOKEN'], reviewId: process.env['INPUT_REVIEW-ID'], maxComments: options.maxComments });
      }
    } catch (error) {
      extensionFailed = true;
      report.localizationError = error.message;
      console.error(`::error::Source localization/reporting failed: ${escape(error.message)}. Original Jev verdict is unchanged.`);
    }
  }
  const reportPath = resolve(process.env.RUNNER_TEMP || tmpdir(), `jev-lint-${process.pid}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (report.split) console.log('::warning::Review split to respect the Jev context budget. All content is covered with overlapping excerpts; conflicts between distant batches may be missed.');
  for (const result of report.results) {
    const batch = result.review.split ? ` / batch ${result.review.batch}/${result.review.batches}` : '';
    const message = `${result.suite}${batch} / ${result.files.join(', ')} / ${result.id}: expected ${result.expected}, probability ${result.probability.toFixed(3)}, required ${result.minProbability}`;
    if (!result.passed && process.env.GITHUB_ACTIONS === 'true') console.log(`::${result.advisory ? 'warning' : 'error'}::${escape(message)}`);
    else console.log(`${result.passed ? 'PASS' : result.advisory ? 'ADVISORY' : 'FAIL'} ${escape(message)}`);
  }
  console.log(`Report: ${reportPath}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `report=${reportPath}\npassed=${report.passed}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = report.results.map(r => `| ${markdown(r.suite)} | ${markdown(r.files.join(', '))} | ${markdown(r.id)} | ${r.probability.toFixed(3)} | ${r.minProbability} | ${r.passed ? 'Pass' : r.advisory ? 'Advisory / review' : 'Fail / review'} |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, ['## Jev lint', '', '| Suite | Files | Question | Expected-answer probability | Required | Result |', '| --- | --- | --- | --- | --- | --- |', ...rows, '', `Requests: ${report.requests}. Split review: ${report.split ? 'yes — distant batches are not compared together' : 'no'}.`, '', 'Probabilistic review checks; failures need review. This does not replace behavioral evals or code review.', ''].join('\n'));
    if (report.locations) {
      const locations = report.locations;
      const lines = locations.findings.map(f => {
        const label = `${markdown(f.path)}:${f.line}–${f.endLine}`;
        const location = report.source.repository && report.source.commit ? `[${label}](${sourceLink(report.source.repository, report.source.commit, f)})` : label;
        return `- ${location} — **${markdown(f.rule)}**, localization probability ${f.probability.toFixed(2)}${f.contextTruncated ? ' (cropped context)' : ''}`;
      });
      await appendFile(process.env.GITHUB_STEP_SUMMARY, ['\n## Source findings', '', ...lines, '', `${locations.requests} localization requests; ${locations.omittedCandidates} candidate passages omitted by the request limit; ${locations.unlocatedGroups} contexts had no unambiguous source match. Unlocalized blocking checks still fail; advisory findings never block CI.`, '', 'Locations are source-verified probabilistic findings, not ground truth. Exact passages are in the JSON report.', ''].join('\n'));
    }
  }
  process.exitCode = extensionFailed ? 2 : report.passed ? 0 : 1;
}
try {
  await main();
} catch (error) {
  console.error(`::error::${escape(error.message)}`);
  process.exitCode = 2;
}
