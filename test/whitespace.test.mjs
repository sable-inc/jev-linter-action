import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyWhitespace} from '../src/whitespace.mjs';
const check = (content, line, path='example.md') => classifyWhitespace([{path,content}], [{path,line,endLine:line,text:''}]);
test('redundant blank separators preserve Markdown structure', () => {
 assert.equal(check('# Title\n\n\nParagraph.\n',3).unchanged.length,1);
 assert.equal(check('---\ntitle: Demo\n---\n\n# Title\n',4).unchanged.length,1);
});
test('paragraph breaks, list looseness and literal code whitespace stay unreviewed', () => {
 for (const [text,line] of [['First\n\nSecond',2],['- One\n\n- Two',2],['```\nfirst\n\nsecond\n```',3],['    first\n\n    second',2]]) {
  assert.equal(check(text,line).unreviewed.length,1,text);
 }
});
test('frontmatter and template whitespace cannot be exempted by Markdown parsing', () => {
 assert.equal(check('---\n\ntitle: Demo\n---\nBody',2).unreviewed.length,1);
 assert.equal(check('{{- template "x" . -}}\n\n\n# Title',3).unreviewed.length,1);
 assert.equal(check('# Title\n\n\nBody',3,'example.tmpl').unreviewed.length,1);
});
test('GFM table separation is a structural change', () => {
 assert.equal(check('| A |\n\n| --- |\n| B |',2).unreviewed.length,1);
});
test('unterminated and newly exposed frontmatter cannot be exempted', () => {
 assert.equal(check('---\nNo close\n\nBody',3).unreviewed.length,1);
 assert.equal(check('\n---\ntitle: Demo\n---\nBody',1).unreviewed.length,1);
});
test('ranged blanks are checked as a complete removal', () => {
 const unit = {path:'example.md',line:3,endLine:4,text:''};
 const result = classifyWhitespace([{path:unit.path,content:'# Title\n\n\n\nBody'}],[unit]);
 assert.deepEqual(result.unchanged,[{path:unit.path,line:3,endLine:4}]);
 const changed = classifyWhitespace([{path:unit.path,content:'```\nFirst\n\n\nLast\n```'}],[unit]);
 assert.equal(changed.unreviewed.length,1);
});
