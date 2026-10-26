import fs from 'node:fs';
import { SshMcpServer } from './mcp-server.js';
import { CommandLineParser } from '../cli/command-line-parser.js';
import { readService } from './shared-service.js';

// Configuration travels over a private inherited IPC channel, not daemon argv.
process.once('message', async (message: {args:string[];id:string;key:string;token:string;filename:string}) => {
  if (!process.send) return;
  const {args,id,key,token,filename}=message;
  const parsed=CommandLineParser.parseArgs(args);
  const daemonArgs=[...args,'--ui','--http-host','127.0.0.1','--http-token',token];
  process.once('exit',()=> { if (readService(filename)?.id===id) fs.rmSync(filename,{force:true}); });
  try {
    await new SshMcpServer().run(daemonArgs,{id,ready:endpoint => {
      const ui=new URL(parsed.uiPath+'/',endpoint).href;
      const service={id,key,pid:process.pid,endpoint,ui,token};
      const temp=filename+'.'+id+'.tmp';
      fs.writeFileSync(temp,JSON.stringify(service),{mode:0o600,flag:'wx'}); fs.renameSync(temp,filename);
      process.send?.({ready:service});
    }});
  } catch(error) {
    process.send?.({error:(error as Error).message}); process.exitCode=1; setTimeout(()=>process.exit(1),100);
  }
});
