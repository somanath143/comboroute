import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
import {resolve,join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),paths=process.argv.slice(2);
const dirs=paths.length ? paths.map(p=>p==='core'?'packages/core/src':p==='api'?'apps/api/src':p) : ['packages/core/src','apps/api/src','apps/web/src','e2e'];
let count=0,textCount=0;
const textExtensions=new Set(['.js','.jsx','.mjs','.css','.html','.json']);
// UTF-8 bytes decoded as Windows-1252 produce these sequences. Keep escapes here
// so the check can inspect its own source without matching its pattern text.
const damagedText=/\uFFFD|[\u0080-\u009F]|\u00C2[\u0080-\u00BF]|[\u00C3\u00E2][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2010-\u203A\u20AC\u2122]|\u00F0\u0178/;
function scan(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){
  const file=join(dir,ent.name);
  if(ent.isDirectory()){scan(file);continue;}
  if(textExtensions.has(extname(file))){
    const content=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));
    if(damagedText.test(content))throw new Error(`Corrupted text encoding in ${file}. Save source as UTF-8.`);
    textCount++;
  }
  if(file.endsWith('.js')&&!file.endsWith('.test.js')){execFileSync(process.execPath,['--check',file]);count++;}
}}
for(const dir of dirs)scan(resolve(root,dir));
console.log(`Checked syntax of ${count} JavaScript files and UTF-8 encoding of ${textCount} text files. JSX is parsed by Vite during npm run build.`);
