import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewChanges } from '../src/changes.mjs';
import { addedPassages } from '../src/locations.mjs';
const old = 'Always finish the entire demo even when the visitor refuses.';
const added = 'Honor the visitor’s requested scope.';
const config = { model: 'jev-1.13.0', suites: [{ name: 'Agent', files: ['bundle.json'], questions: [{ id: 'scope', question: 'Does this force the whole demo despite a refusal?', expect: false, minProbability: 0.8 }] }] };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'moment.md'), `${old}\n${added}\n`);
  await writeFile(join(root, 'bundle.json'), JSON.stringify({ knowledge: `${old}\n${added}` }));
  return { root, options: { apiKey: 'key', sourcePatterns: ['*.md'], priority: new Map([['moment.md', new Set([2])]]) } };
}
test('unchanged bad instructions supply context but only additions are judged and reported', async t => {
  const { root, options } = await setup(t);
  const calls = [];
  const report = await reviewChanges(config, root, options, { fetcher: async (_, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    assert.ok(body.state.files[0].content.includes(old));
    assert.ok(body.state.files[0].content.includes(`JEV_TARGET_0_START\n${added}\nJEV_TARGET_0_END`));
    assert.ok(!body.state.files[0].content.includes(`JEV_TARGET_0_START\n${old}`));
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.1 } } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(report.passed, true);
  assert.equal(report.locations.findings.length, 0);
  assert.deepEqual(report.locations.assessments.map(a => a.line), [2]);
});
test('a new violation fails and its coordinates include only added lines', async t => {
  const { root, options } = await setup(t);
  const report = await reviewChanges(config, root, options, { fetcher: async () => Response.json({ answers: { location_0: { type: 'noul', noul: 0.96 } } }) });
  assert.equal(report.passed, false);
  assert.equal(report.incomplete, false);
  assert.deepEqual(report.locations.findings.map(f => [f.line, f.endLine, f.text]), [[2, 2, added]]);
});
test('template additions absent from compiled text are judged as explicit source targets', async t => {
  const { root, options } = await setup(t);
  await writeFile(join(root, 'bundle.json'), JSON.stringify({ knowledge: old }));
  const report = await reviewChanges(config, root, options, { fetcher: async (_, request) => {
    assert.ok(JSON.parse(request.body).state.files[0].content.includes(`JEV_TARGET_0_START\n${added}\nJEV_TARGET_0_END`));
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.1 } } });
  } });
  assert.equal(report.passed, true);
  assert.equal(report.incomplete, false);
  assert.deepEqual(report.locations.assessments.map(a => [a.path, a.line, a.rule]), [['moment.md', 2, 'scope']]);
});
test('deletions or unchanged sources create no model calls or findings', async t => {
  const { root, options } = await setup(t);
  const report = await reviewChanges(config, root, { ...options, priority: new Map() }, { fetcher: async () => assert.fail('No additions') });
  assert.equal(report.passed, true);
  assert.equal(report.requests, 0);
});
test('small additions and disjoint hunks are separate targets, including CRLF', () => {
  assert.deepEqual(addedPassages([{ path: 'a.md', content: 'Old\r\nMUST\r\nOld too\r\nNew' }], new Map([['a.md', new Set([2,4])]])).map(u => [u.line,u.endLine,u.text]), [[2,2,'MUST'],[4,4,'New']]);
});


test('missing PR patches cannot silently skip authored additions', () => {
  assert.throws(() => addedPassages([{path:'a.md',content:added}], new Map([['a.md',null]])), /patch unavailable/);
});
test('request-budget exhaustion leaves a visibly incomplete review', async t => {
  const { root, options } = await setup(t);
  const lines = Array.from({length: 8}, (_,i) => `New instruction ${i}.`);
  await writeFile(join(root, 'moment.md'), lines.join('\n\n'));
  const report = await reviewChanges(config, root, {...options, maxRequests:1, priority:new Map([['moment.md', new Set(lines.map((_,i)=>i*2+1))]])}, {fetcher:async (_,request) => Response.json({answers:Object.fromEntries(Object.keys(JSON.parse(request.body).questions).map(id=>[id,{type:'noul',noul:0.1}]))})});
  assert.equal(report.incomplete,true);
  assert.equal(report.passed,false);
  assert.equal(report.locations.omittedCandidates,4);
});

test('isolated whitespace additions remain visible incomplete coverage', async t => {
  const { root, options } = await setup(t);
  await writeFile(join(root, 'moment.md'), `${old}\n   \n${added}`);
  const report = await reviewChanges(config, root, options, {fetcher:async () => assert.fail('Whitespace needs structural review')});
  assert.equal(report.incomplete,true);
  assert.equal(report.passed,false);
  assert.deepEqual(report.locations.unreviewedWhitespace,[{path:'moment.md',line:2,endLine:2}]);
});
test('blank lines within a textual addition stay in the reviewed target', () => {
  const units = addedPassages([{path:'a.md',content:'First\n\nSecond'}],new Map([['a.md',new Set([1,2,3])]]));
  assert.deepEqual(units,[{path:'a.md',line:1,endLine:2,text:'First'},{path:'a.md',line:3,endLine:3,text:'Second'}]);
});

test('multiple added blank separators belong to the preceding textual target', () => {
  const units = addedPassages([{path:'a.md',content:'First\n\n\nSecond'}],new Map([['a.md',new Set([1,2,3,4])]]));
  assert.deepEqual(units,[{path:'a.md',line:1,endLine:3,text:'First'},{path:'a.md',line:4,endLine:4,text:'Second'}]);
});
test('oversized added lines fail explicitly before review', () => {
  assert.throws(()=>addedPassages([{path:'a.md',content:'x'.repeat(1801)}],new Map([['a.md',new Set([1])]])),/1800-character/);
});

test('large unrelated bundle content does not multiply added-passage assessments', async t => {
  const { root, options } = await setup(t);
  const content = Array.from({length: 20}, (_, i) => `Changed instruction ${i}.`);
  await writeFile(join(root, 'moment.md'), content.join('\n\n'));
  await writeFile(join(root, 'bundle.json'), JSON.stringify({
    config: { instructions: { behavior: { personality: 'Always honor visitor scope.' } },
      moments: Array.from({length: 100}, (_, i) => ({knowledge: `Unrelated chapter ${i}. `.repeat(200)})) },
  }));
  const calls = [];
  const report = await reviewChanges(config, root, { ...options, maxRequests: 5,
    priority: new Map([['moment.md', new Set(content.map((_, i) => i * 2 + 1))]]) }, {
    fetcher: async (_, request) => {
      const body = JSON.parse(request.body); calls.push(body);
      assert.ok(body.state.files[0].content.includes('Always honor visitor scope.'));
      return Response.json({answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, {type:'noul',noul:0.1}]))});
    },
  });
  assert.equal(report.incomplete, false);
  assert.equal(report.requests, 5);
  assert.equal(report.locations.assessments.length, 20);
  assert.equal(new Set(report.locations.assessments.map(a => `${a.path}:${a.line}:${a.rule}`)).size, 20);
});

test('local exception preceding a template addition remains context without compiled text matching', async t => {
  const { root, options } = await setup(t);
  await writeFile(join(root, 'moment.md'), 'Only after explicit visitor consent.\n{{template "approved-demo" .}}\n');
  await writeFile(join(root, 'bundle.json'), JSON.stringify({knowledge: 'Resolved demo instructions.'}));
  const report = await reviewChanges(config, root, options, { fetcher: async (_, request) => {
    const text = JSON.parse(request.body).state.files[0].content;
    assert.ok(text.includes('Only after explicit visitor consent.'));
    assert.ok(text.includes('JEV_TARGET_0_START\n{{template "approved-demo" .}}\nJEV_TARGET_0_END'));
    return Response.json({answers:{location_0:{type:'noul',noul:0.1}}});
  } });
  assert.equal(report.passed, true);
});
