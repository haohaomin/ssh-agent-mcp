import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../_site/',import.meta.url));
if(!fs.existsSync(path.join(root,'index.html')))throw new Error('Run npm run docs:build first');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer((request,response)=>{
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
  let file;try{const url=new URL(request.url,'http://localhost');let name=decodeURIComponent(url.pathname);if(name.endsWith('/'))name+='index.html';file=path.resolve(root,'.'+name);}catch{response.writeHead(400);response.end();return;}
  if(!file.startsWith(root)){response.writeHead(403);response.end();return;}
  fs.readFile(file,(error,data)=>{if(error){response.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});response.end('Page not found');return;}response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(request.method==='HEAD'?undefined:data);});
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log(`Documentation preview: http://127.0.0.1:${server.address().port}`));
