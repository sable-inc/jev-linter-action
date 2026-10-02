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
