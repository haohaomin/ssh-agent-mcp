import { writeFileSync, mkdirSync } from 'node:fs';
import { toolCatalog } from './tool-catalog.js';
const entries = toolCatalog();
mkdirSync('docs',{recursive:true});
writeFileSync('docs/TOOLS.md', '# MCP 工具参考\n\n由 `npm run docs:tools` 从实际工具定义生成。共 '+entries.length+' 个工具。参数统一使用 camelCase，时间单位为毫秒，偏移明确区分字节和字符。\n\n'+entries.map(t=>'## '+t.name+'\n\n'+t.description+'\n\n```json\n'+JSON.stringify(t.schema,null,2)+'\n```\n'+(t.outputSchema?'\n结构化返回（structuredContent）：\n\n```json\n'+JSON.stringify(t.outputSchema,null,2)+'\n```\n':'')).join('\n'));
console.log(`Generated ${entries.length} tool definitions`);
