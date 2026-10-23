import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),paths=process.argv.slice(2);
const dirs=paths.length ? paths.map(p=>p==='core'?'packages/core/src':p==='api'?'apps/api/src':p) : ['packages/core/src','apps/api/src','apps/web/src','e2e'];
let count=0;
function scan(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const file=join(dir,ent.name);if(ent.isDirectory())scan(file);else if(file.endsWith('.js')&&!file.endsWith('.test.js')){execFileSync(process.execPath,['--check',file]);count++;}}}
for(const dir of dirs)scan(resolve(root,dir));
console.log(`Checked syntax of ${count} JavaScript files. JSX is parsed by Vite during npm run build.`);
