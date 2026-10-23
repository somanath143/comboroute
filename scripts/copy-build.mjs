import {cpSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
const mapping={core:['packages/core/src','packages/core/dist'],api:['apps/api/src','apps/api/dist']};
if(!mapping[mode]){console.error('Usage: node scripts/copy-build.mjs core|api');process.exit(1);}
const [source,target]=mapping[mode].map(p=>resolve(dirname(fileURLToPath(import.meta.url)),'..',p));
if(!existsSync(source))throw new Error(`Missing source directory: ${source}`);
rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
cpSync(source,target,{recursive:true,filter:p=>!p.endsWith('.test.js')});
console.log(`JavaScript sources copied: ${source} → ${target}`);
