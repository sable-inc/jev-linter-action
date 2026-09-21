import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inside, lint } from './lint.mjs';

const escape = text => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const markdown = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
try {
  const root = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const configPath = await inside(root, process.env.INPUT_CONFIG || process.argv[2] || '.jev-lint.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const report = await lint(config, root, process.env['INPUT_API-KEY'] || process.env.TYPESAFE_API_KEY);
  const reportPath = resolve(process.env.RUNNER_TEMP || tmpdir(), `jev-lint-${process.pid}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  for (const result of report.results) {
    const message = `${result.suite} / ${result.files.join(', ')} / ${result.id}: expected ${result.expected}, probability ${result.probability.toFixed(3)}, required ${result.minProbability}`;
    if (!result.passed && process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${escape(message)}`);
    else console.log(`${result.passed ? 'PASS' : 'FAIL'} ${escape(message)}`);
  }
  console.log(`Report: ${reportPath}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `report=${reportPath}\npassed=${report.passed}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = report.results.map(r => `| ${markdown(r.suite)} | ${markdown(r.files.join(', '))} | ${markdown(r.id)} | ${r.probability.toFixed(3)} | ${r.minProbability} | ${r.passed ? 'Pass' : 'Fail / review'} |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, ['## Jev lint', '', '| Suite | Files | Question | Expected-answer probability | Required | Result |', '| --- | --- | --- | --- | --- | --- |', ...rows, '', 'Probabilistic review checks; failures need review. This does not replace behavioral evals or code review.', ''].join('\n'));
  }
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(`::error::${escape(error.message)}`);
  process.exitCode = 2;
}
