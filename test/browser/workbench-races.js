// Run with playwright-cli run-code using this file's complete contents.
// A separate browser context mocks every API request; no real SSH actions occur.
async (page) => {
  const context = await page.context().browser().newContext();
  const p = await context.newPage();
  const failures = [], passed = [];
  const check = (condition, label) => (condition ? passed : failures).push(label);
  let releaseRead, readStarted, delayRead = false;
  const sessions = ['a1','a2','b1'].map(sessionName => ({ sessionName, connectionName: sessionName[0] === 'a' ? 'alpha' : 'beta', closed: false, pid: 1, startedAt: "first", cols: 120, rows: 30 }));
  const servers = ['alpha','beta'].map(name => ({ name, host: name, username: 'test', port: 22, connected: true, initialPath: '/fixture' }));
  await p.addInitScript(() => { sessionStorage.setItem('ssh-agent-host','alpha'); sessionStorage.setItem('ssh-agent-view','terminal'); });
  await p.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/ui/api','');
    let value = {};
    if(path === '/servers') value = {servers,defaultConnectionName:'alpha'};
    else if(path === '/sessions') value = sessions;
    else if(path.match(/^\/sessions\/[^/]+\/read$/)) {
      const restarted=path.includes('/b1/')&&sessions[2].pid===2;
      if(restarted&&Number(url.searchParams.get('offset'))>3) return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Offset exceeds session output'})});
      value={output:Number(url.searchParams.get('offset'))?'':restarted?'NEW':'terminal output\n',nextOffsetChars:restarted?3:16,closed:false};
    }
    else if(path === '/files') value = {resolvedPath:'/fixture',entries:[{name:'one',type:'file'},{name:'two',type:'file'}]};
    else if(path === '/file') {
      if(delayRead) { delayRead=false; const wait=new Promise(resolve=>{releaseRead=resolve;}); readStarted?.(); await wait; }
      value = {content:'original '+url.searchParams.get('path'),sha256:'a'.repeat(64)};
    } else if(path === '/file/edit') value={afterSha256:'b'.repeat(64),backupPath:'/fixture/backup'};
    else if(path === '/activity/events') return route.fulfill({contentType:'text/event-stream',body:'data: {"type":"snapshot","records":[]}\n\n'});
    else if(path === '/forwards') value=[];
    else if(path === '/jobs') value={output:''};
    else if(path === '/connect') value={connected:JSON.parse(route.request().postData()).connectionName};
    else return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Unexpected test request: '+path})});
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  try {
    await p.goto(new URL('/ui/', page.url()).href);
    await p.locator('#session-tabs button').first().waitFor();
    const serverButton=p.getByRole('button',{name:'alpha 已连接',exact:true});
    await serverButton.focus();
    await p.waitForResponse(response=>new URL(response.url()).pathname==='/ui/api/sessions');
    await p.evaluate(()=>new Promise(requestAnimationFrame));
    check(await serverButton.evaluate(el=>el===document.activeElement), 'server focus survives automatic refresh');
    const sessionButton=p.locator('#session-tabs button').filter({hasText:'a1'});
    await sessionButton.focus();
    await p.waitForResponse(response=>new URL(response.url()).pathname==='/ui/api/sessions');
    await p.evaluate(()=>new Promise(requestAnimationFrame));
    check(await sessionButton.evaluate(el=>el===document.activeElement), 'terminal tab focus survives automatic refresh');
    await p.locator('#takeover').click(); await p.locator('#command').fill('command meant only for alpha/a1');
    await p.locator('#session-tabs button').filter({hasText:'a2'}).click();
    check(await p.locator('#command').inputValue()==='', 'unsent command cleared on terminal switch');
    await p.locator('#takeover').click(); await p.locator('#command').fill('command meant only for alpha');
    await p.getByRole('button',{name:'beta 已连接',exact:true}).click();
    await p.locator('#session-tabs button').filter({hasText:'b1'}).waitFor();
    check(await p.locator('#command').inputValue()==='', 'unsent command cleared on server switch');
    await p.locator('#takeover').click(); await p.locator('#command').fill('input for old worker only');
    sessions[2]={...sessions[2],pid:2,startedAt:'second',nextOffsetChars:3};
    await p.waitForFunction(()=>document.querySelector('#terminal-output').textContent==='NEW'||document.querySelector('#notice').textContent.includes('Offset exceeds'));
    check(await p.locator('#terminal-output').textContent()==='NEW','same-name restarted terminal resets output cursor');
    check(await p.locator('#command').inputValue()===''&&await p.locator('#command').isDisabled(),'same-name restart clears input and returns to read-only');
    await p.getByRole('button',{name:'文件管理',exact:true}).click();
    await p.locator('#file-list button').filter({hasText:'one'}).click();
    await p.waitForFunction(()=>document.querySelector('#file-name').textContent==='one');
    const started=new Promise(resolve=>{readStarted=resolve;}); delayRead=true;
    await p.locator('#file-list button').filter({hasText:'two'}).click(); await started;
    await p.locator('#file-content').fill('new draft typed while read is pending');
    releaseRead();
    await p.waitForFunction(()=>document.querySelector('#file-name').textContent==='two'||document.querySelector('#notice').textContent.includes('草稿已保留'));
    check(await p.locator('#file-content').inputValue()==='new draft typed while read is pending', 'late file response preserves newer draft');
    if(!failures.length) {
      await p.locator('#preview-file').click(); await p.locator('#apply-file').click();
      await p.locator('#restore-file').waitFor();
      const startedRestore=new Promise(resolve=>{readStarted=resolve;}); delayRead=true;
      await p.locator('#restore-file').click(); await startedRestore;
      await p.locator('#file-content').fill('new draft typed while restore is pending'); releaseRead();
      await p.waitForFunction(()=>document.querySelector('#notice').textContent.includes('恢复'));
      check(await p.locator('#file-content').inputValue()==='new draft typed while restore is pending', 'backup restore preserves newer draft');
    }
    if(failures.length) throw Error(JSON.stringify({passed,failures}));
    return {passed};
  } finally {releaseRead?.();await context.close();}
}
