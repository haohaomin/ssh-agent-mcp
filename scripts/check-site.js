import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../_site/',import.meta.url));
const files=fs.readdirSync(root).filter(file=>file.endsWith('.html'));
const contents=new Map(files.map(file=>[file,fs.readFileSync(path.join(root,file),'utf8')]));
const ids=new Map([...contents].map(([file,html])=>[file,new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]))]));
const failures=[];let checked=0;
for(const [file,html] of contents){
  const localIds=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(localIds.length!==new Set(localIds).size)failures.push(`${file}: duplicate ids`);
  for(const [,value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)){
    if(/^(?:https?:|mailto:|data:)/.test(value))continue;
    const [target,hash]=value.split('#');const name=decodeURIComponent(target.split('?')[0]||file);checked++;
    if(!fs.existsSync(path.join(root,name)))failures.push(`${file}: missing ${name}`);
    if(hash&&ids.has(name)&&!ids.get(name).has(decodeURIComponent(hash)))failures.push(`${file}: missing anchor ${name}#${hash}`);
  }
}
const index=JSON.parse(fs.readFileSync(path.join(root,'search-index.json'),'utf8'));
for(const entry of index){const [file,hash]=entry.url.split('#');if(!contents.has(file)||(hash&&!ids.get(file).has(hash)))failures.push(`Invalid search destination: ${entry.url}`);}
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
console.log(`Checked ${files.length} pages, ${checked} local links/assets, ${index.length} search entries: all valid.`);
