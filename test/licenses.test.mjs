import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dependencyNotices} from '../scripts/licenses.mjs';

test('license variants and notices are preserved while omitted dev and optional packages are skipped', t => {
 const dir = mkdtempSync(join(tmpdir(),'jev-license-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path = 'node_modules/example';
 mkdirSync(join(dir,path),{recursive:true});
 writeFileSync(join(dir,path,'package.json'),JSON.stringify({name:'example',version:'1',license:'MIT'}));
 writeFileSync(join(dir,path,'LICENCE'),'Full license text');
 writeFileSync(join(dir,path,'NOTICE.txt'),'Copyright Example');
 const root = pathToFileURL(dir+'/');
 const packages = {[path]:{},'node_modules/dev':{dev:true},'node_modules/optional':{optional:true}};
 const notices = dependencyNotices(root,packages);
 assert.match(notices,/Full license text/);
 assert.match(notices,/Copyright Example/);
 assert.throws(()=>dependencyNotices(root,{'node_modules/required':{}}),/Cannot read dependency metadata at node_modules\/required/);
 rmSync(join(dir,path,'LICENCE')); rmSync(join(dir,path,'NOTICE.txt'));
 assert.throws(()=>dependencyNotices(root,packages),/node_modules\/example.*no license\/notice text found/);
});
