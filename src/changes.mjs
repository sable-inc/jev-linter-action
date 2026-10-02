import { collect, evaluate, validate } from './lint.mjs';
import { addedPassages, collectSources, digest, focusedBatchRequest } from './locations.mjs';
import { contextIndex, passageContext } from './source-context.mjs';
import { classifyWhitespace } from './whitespace.mjs';

/** Each added passage is assessed once per suite/rule, not once per bundle chunk. */
export async function reviewChanges(config, root, options, deps) {
  if (!options.apiKey?.trim()) throw new Error('TYPESAFE_API_KEY / api-key is required');
  validate(config);
  const maxRequests = options.maxRequests ?? 32;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 512) throw new Error('locate-max-requests must be 1–512');
  const sources = await collectSources(root, options.sourcePatterns);
  const additions = addedPassages(sources, options.priority ?? new Map());
  const units = additions.filter(unit => unit.text);
  const whitespace = classifyWhitespace(sources, additions);
  const locations = { findings: [], assessments: [], requests: 0, candidatePassages: units.length * config.suites.length,
    unlocatedGroups: 0, omittedCandidates: 0,
    unchangedWhitespace: whitespace.unchanged, unreviewedWhitespace: whitespace.unreviewed };
  // Validate all inputs and plan requests before spending API budget.
  const queues = [];
  for (const suite of config.suites) {
    const files = await collect(root, suite.files);
    if ([...files, ...sources].some(file => file.content.includes('JEV_TARGET_'))) throw new Error('Authored text collides with review markers');
    queues.push({ suite, index: contextIndex(files), offset: 0 });
  }
  const jobs = [];
  while (jobs.length < maxRequests) {
    let progress = false;
    for (const queue of queues) {
      if (queue.offset >= units.length || jobs.length >= maxRequests) continue;
      const failures = queue.suite.questions.map(q => ({ ...q, suite: queue.suite.name, expected: q.expect }));
      let count = Math.min(4, Math.floor(64 / failures.length), units.length - queue.offset), request, targets;
      for (; count > 0; count--) {
        targets = units.slice(queue.offset, queue.offset + count);
        const context = passageContext(sources, queue.index, targets);
        try {
          request = focusedBatchRequest(context.text, targets, failures, config.model, true);
          request.contextTruncated ||= context.truncated;
          break;
        } catch (error) { if (count === 1) throw error; }
      }
      jobs.push({ ...request, targets, failures });
      queue.offset += count;
      progress = true;
    }
    if (!progress) break;
  }
  locations.omittedCandidates = locations.candidatePassages - jobs.reduce((n, job) => n + job.targets.length, 0);
  for (const job of jobs) {
    const answers = await evaluate(job.suite, job.files, config.model, options.apiKey, deps);
    locations.requests++;
    answers.forEach((answer, index) => {
      const failure = job.failures[index % job.failures.length];
      const unit = job.targets[Math.floor(index / job.failures.length)];
      locations.assessments.push({ path: unit.path, line: unit.line, endLine: unit.endLine, rule: failure.id,
        suite: failure.suite, violationProbability: answer.probability, localized: answer.passed });
      if (!answer.passed) return;
      locations.findings.push({ id: digest(JSON.stringify([failure.suite, failure.id, unit.path, unit.line, unit.endLine, unit.text])).slice(0, 24),
        suite: failure.suite, rule: failure.id, question: failure.question, expected: failure.expected,
        ...unit, probability: answer.probability, contextTruncated: job.contextTruncated });
    });
  }
  const incomplete = locations.omittedCandidates > 0 || locations.unreviewedWhitespace.length > 0;
  return { scope: 'added-lines', contextScope: 'source-neighbors-and-selected-built-context',
    passed: !incomplete && locations.findings.length === 0, incomplete,
    split: jobs.some(job => job.contextTruncated), requests: locations.requests, results: [], locations };
}
