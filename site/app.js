const menu=document.querySelector('.menu-toggle');
const sidebar=document.querySelector('#sidebar');
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'关闭导航':'打开导航');sidebar.classList.toggle('open',open);});
const closeMenu=()=>{menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','打开导航');sidebar.classList.remove('open');};
sidebar.addEventListener('click',e=>{if(e.target.closest('a'))closeMenu();});
document.addEventListener('click',e=>{if(!sidebar.contains(e.target)&&!menu.contains(e.target))closeMenu();});
for(const pre of document.querySelectorAll('pre')){
  const wrap=document.createElement('div');wrap.className='code-wrap';pre.replaceWith(wrap);wrap.append(pre);
  const button=document.createElement('button');button.className='copy-button';button.type='button';button.textContent='复制';button.setAttribute('aria-label','复制代码');wrap.append(button);
  button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(pre.textContent);button.textContent='已复制';document.querySelector('#copy-status').textContent='代码已复制到剪贴板';}catch{button.textContent='请选择复制';document.querySelector('#copy-status').textContent='剪贴板不可用，请选择代码后复制';}setTimeout(()=>button.textContent='复制',2000);});
}
const input=document.querySelector('#site-search'),results=document.querySelector('#search-results'),status=document.querySelector('#search-status');
let indexPromise;
const index=()=>indexPromise??=(fetch('search-index.json').then(r=>{if(!r.ok)throw new Error('index');return r.json();}).catch(e=>{indexPromise=undefined;throw e;}));
const closeSearch=()=>{results.hidden=true;input.setAttribute('aria-expanded','false');};
let sequence=0;
input.addEventListener('input',async()=>{
  const request=++sequence,query=input.value.trim().toLowerCase();results.replaceChildren();if(!query){closeSearch();return;}
  results.hidden=false;input.setAttribute('aria-expanded','true');const message=document.createElement('p');message.textContent='正在搜索…';results.append(message);
  try{const entries=await index();if(request!==sequence)return;const terms=query.split(/\s+/);const matches=entries.filter(item=>terms.every(term=>(item.title+' '+item.text).toLowerCase().includes(term))).sort((a,b)=>Number(b.title.toLowerCase().includes(query))-Number(a.title.toLowerCase().includes(query))).slice(0,12);results.replaceChildren();
    for(const item of matches){const a=document.createElement('a');a.href=item.url;a.textContent=item.title;const detail=document.createElement('small');detail.textContent=item.text.replace(/\s+/g,' ').slice(0,90);a.append(detail);results.append(a);}
    if(!matches.length){message.textContent='没有找到相关内容，试试「配置」「tmux」或工具名称。';results.append(message);}status.textContent=`找到 ${matches.length} 条结果`;
  }catch{if(request!==sequence)return;message.textContent='暂时无法加载搜索索引，请使用左侧导航。';status.textContent=message.textContent;}
});
input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('a')?.focus();}if(e.key==='Enter'){const first=results.querySelector('a');if(first){e.preventDefault();first.click();}}});
results.addEventListener('keydown',e=>{const links=[...results.querySelectorAll('a')],at=links.indexOf(document.activeElement);if(e.key==='ArrowDown'){e.preventDefault();links[Math.min(at+1,links.length-1)]?.focus();}if(e.key==='ArrowUp'){e.preventDefault();at<=0?input.focus():links[at-1].focus();}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();}if(e.key==='Escape'){const fromResults=results.contains(document.activeElement);++sequence;closeSearch();closeMenu();if(fromResults)input.focus();}});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))closeSearch();});
const filter=document.querySelector('#tool-filter');
filter?.addEventListener('input',()=>{const query=filter.value.toLowerCase().trim();let count=0;for(const card of document.querySelectorAll('.tool-card')){card.hidden=!card.dataset.search.toLowerCase().includes(query);if(!card.hidden)count++;}for(const group of document.querySelectorAll('.tool-group'))group.hidden=![...group.querySelectorAll('.tool-card')].some(card=>!card.hidden);document.querySelector('#tool-count').textContent=`显示 ${count} 个工具`;document.querySelector('#tool-empty').hidden=count>0;});
