import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestFor, fits, planRequests } from '../src/requests.mjs';
import { evaluate, lint } from '../src/lint.mjs';
const question = { id: 'consistent', question: 'Is the agent consistent?', expect: true, minProbability: 0.8 };
const suite = { name: 'Agent', files: ['*.json'], questions: [question] };

test('small artifacts are reviewed together unchanged', () => {
 const files = [{path:'agent.json',content:'All prompt sections.'},{path:'skills.md',content:'Skill content.'}];
 const jobs=planRequests(suite,files,'jev-1.13.0');
 assert.equal(jobs.length,1); assert.deepEqual(jobs[0].files,files);
 assert.equal(jobs[0].review.split,false);
});
test('an oversized artifact retains every Unicode character, overlaps boundaries, and budgets questions and escaping', () => {
 const content=('界🌍\\\"\u0001\nInstructions. ').repeat(5000);
 const original=Array.from(content);
 const jobs=planRequests(suite,[{path:'agent.json',content}],'jev-1.13.0');
 assert.ok(jobs.length>1);
 let covered=0;
 for(const job of jobs) {
  assert.ok(fits(requestFor(suite,job.files,'jev-1.13.0',job.review)));
  assert.equal(job.review.split,true);
  const part=job.files[0];
  assert.ok(part.startCharacter<=covered); // No gaps, including between requests.
  if(covered)assert.ok(part.startCharacter<covered); // Actual overlap.
  assert.equal(part.content,original.slice(part.startCharacter,part.endCharacter).join(''));
  covered=part.endCharacter;
 }
 assert.equal(covered,original.length);
});
test('state plus longest question and state plus all questions have separate bounds', () => {
 const files=[{path:'agent.json',content:'x'.repeat(20000)}];
 assert.ok(fits(requestFor(suite,files,'jev-1.13.0')));
 assert.equal(fits(requestFor({...suite,questions:[{...question,question:'x'.repeat(12000)}]},files,'jev-1.13.0')),false);
 const questions=Array.from({length:64},(_,i)=>({...question,id:`q_${i}`,question:'x'.repeat(1000)}));
 assert.throws(()=>planRequests({...suite,questions},files,'jev-1.13.0'),/questions alone/);
});
test('every planned job is validated before paid requests, even when a later suite cannot fit', async t => {
 const root=await mkdtemp(join(tmpdir(),'jev-budget-')); t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'agent.json'),'{}'); let calls=0;
 await assert.rejects(lint({model:'jev-1.13.0',suites:[suite,{...suite,name:'Invalid',questions:[{...question,question:'x'.repeat(32000)}]}]},root,'key',{fetcher:async()=>{calls++;}}),/questions alone/);
 assert.equal(calls,0);
 await assert.rejects(evaluate(suite,[{path:'x',content:'x'.repeat(40000)}],'jev-1.13.0','key',{fetcher:async()=>{calls++;}}),/context budget/);
 assert.equal(calls,0);
});
test('a failing excerpt fails the whole artifact and reports its source span without content', async t => {
 const root=await mkdtemp(join(tmpdir(),'jev-parts-')); t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'agent.json'),'x'.repeat(70000));let calls=0;
 const report=await lint({model:'jev-1.13.0',suites:[suite]},root,'key',{fetcher:async()=>Response.json({answers:{consistent:{type:'noul',noul:++calls===2?0.1:0.95}}})});
 assert.ok(report.split);assert.equal(report.passed,false);assert.ok(report.requests>1);
 const failed=report.results.find(r=>!r.passed);
 assert.equal(failed.files[0],'agent.json');assert.ok(failed.excerpts[0].startCharacter>0);
 assert.ok(!JSON.stringify(report).includes('x'.repeat(100)));
});
