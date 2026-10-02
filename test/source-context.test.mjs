import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextIndex, passageContext } from '../src/source-context.mjs';

test('deep generated JSON retains its leaf without recursive stack overflow', () => {
  const content = '['.repeat(20000) + '"Instruction"' + ']'.repeat(20000);
  assert.equal(contextIndex([{path:'deep.json',content}])[0].content, 'Instruction');
});
test('plain files and top-level JSON primitives remain available as context', () => {
  for (const path of ['guide.md', 'guide.txt', 'guide.json']) {
    for (const content of ['123', 'true', 'null']) assert.deepEqual(contextIndex([{path,content}]), [{path,content}]);
  }
  assert.deepEqual(contextIndex([{path:'guide.md',content:'"Quoted text"'}]), [{path:'guide.md',content:'"Quoted text"'}]);
});
test('small documents without headings have neutral labels and complete context', () => {
  const source = {path:'guide.md',content:'Intro\nHonor scope.'};
  const context = passageContext([source], contextIndex([source]), [{path:source.path,line:2,endLine:2,text:'Honor scope.'}]);
  assert.match(context.text, /enclosing source \(document\)/);
  assert.equal(context.truncated, false);
});
test('cropping neighbors, clipping selected entries, and omitted entries disclose truncation', () => {
  const unit = {path:'guide.md',line:1,endLine:1,text:'Honor scope.'};
  const source = {path:unit.path,content:unit.text};
  for (const [sources, entries] of [
    [[{...source,content:unit.text+'\nOld.'.repeat(30)}], []],
    [[source], [{path:'instructions.md',content:'Long context '.repeat(1000)}]],
    [[source], [{path:'bundle.json/unrelated',content:'Other topic'}]],
  ]) assert.equal(passageContext(sources,entries,[unit]).truncated,true);
});
