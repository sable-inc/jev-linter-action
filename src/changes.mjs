import { planLint } from './lint.mjs';
import { digest, locate } from './locations.mjs';

/** Review added source lines against every rule, with built output as context. */
export async function reviewChanges(config, root, options, deps) {
  if (!options.apiKey?.trim()) throw new Error('TYPESAFE_API_KEY / api-key is required');
  const jobs = await planLint(config, root);
  // Reuse the same bounded context planner without judging unrelated existing text.
  const evidence = jobs.flatMap(job => job.suite.questions.map(q => ({
    suite: job.suite.name, id: q.id, question: q.question, expected: q.expect, passed: false,
    excerpts: job.files.map(({ content, ...source }) => ({ ...source, sha256: digest(content) })),
  })));
  const locations = await locate({ results: evidence }, root, { ...options, model: config.model, changedOnly: true }, deps);
  const incomplete = locations.omittedCandidates > 0;
  return {
    scope: 'added-lines', passed: !incomplete && locations.findings.length === 0,
    incomplete, split: jobs.some(job => job.review.split), requests: locations.requests,
    results: [], locations,
  };
}
