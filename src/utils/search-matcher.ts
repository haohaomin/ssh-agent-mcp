import { Worker, isMainThread, parentPort } from 'node:worker_threads';
export type SearchOptions = { regex?: boolean; ignoreCase?: boolean; outputMode?: 'content'|'files'|'count'; contextBefore?: number; contextAfter?: number; filePattern?: string; includeHidden?: boolean; maxFileBytes?: number };
export function matchContent(content: string, pattern: string, options: SearchOptions, limit: number) {
  const lines = content.split('\n');
  const expression = options.regex ? new RegExp(pattern, options.ignoreCase ? 'i' : '') : undefined;
  const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
  const matches: number[] = [];
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = expression ? expression.test(lines[i]) : (options.ignoreCase ? lines[i].toLowerCase() : lines[i]).includes(needle);
    if (match) { count++; if (matches.length < limit) matches.push(i); }
  }
  const selected = new Set<number>();
  for (const i of matches) for (let j = Math.max(0, i - (options.contextBefore || 0)); j <= Math.min(lines.length-1,i+(options.contextAfter || 0)); j++) selected.add(j);
  const matched = new Set(matches);
  return { count, truncated: count > matches.length, lines: [...selected].sort((a,b)=>a-b).map(i=>({line:i+1,text:lines[i],match:matched.has(i)})) };
}
if (!isMainThread && parentPort) parentPort.on('message', ({content, pattern, options, limit}) => {
  try { parentPort!.postMessage({result:matchContent(content,pattern,options,limit)}); }
  catch(e) { parentPort!.postMessage({error:(e as Error).message}); }
});
export class SearchMatcher {
  private worker?: Worker;
  async match(content: string, pattern: string, options: SearchOptions, limit: number): Promise<ReturnType<typeof matchContent>> {
    if (!options.regex) return matchContent(content,pattern,options,limit);
    this.worker ??= new Worker(new URL('./search-matcher.js', import.meta.url));
    const worker = this.worker;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);worker.removeListener('message',message);worker.removeListener('error',error);};
      const error=(e:Error)=>{cleanup();reject(e);};
      const message=(data:any)=>{cleanup();data.error ? reject(new Error(data.error)) : resolve(data.result);};
      const timer=setTimeout(()=>{cleanup();void worker.terminate();this.worker=undefined;reject(new Error('Regular expression exceeded the 2 second execution budget'));},2000);
      worker.once('message',message);worker.once('error',error);worker.postMessage({content,pattern,options,limit});
    });
  }
  close() { void this.worker?.terminate(); this.worker=undefined; }
}
