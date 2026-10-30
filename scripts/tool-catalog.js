import { z } from 'zod';
import { registerAllTools } from '../build/tools/index.js';
export function toolCatalog() {
  const entries=[];
  registerAllTools({registerTool(name,meta){entries.push({name,description:meta.description,outputSchema:meta.outputSchema?z.toJSONSchema(z.object(meta.outputSchema)):undefined,schema:z.toJSONSchema(z.object(meta.inputSchema||{}),{io:"input"})});}});
  return entries.sort((a,b)=>a.name.localeCompare(b.name));
}
