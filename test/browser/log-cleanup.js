// Run with playwright-cli run-code. API calls are isolated fixtures; no user logs are deleted.
async (page) => {
  const context = await page.context().browser().newContext();
  const p = await context.newPage(), errors = [];
  let deletes = 0, removed = false, failPreview = false;
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(() => sessionStorage.setItem('ssh-agent-view', 'activity'));
  await p.route('**/api/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/api/')[1];
    if (name === 'activity/events') return route.fulfill({contentType:'text/event-stream',body:'data: {"type":"snapshot","records":[]}\n\n'});
    let value = {};
    if (name === 'servers') value = {servers:[]};
    else if (name === 'logs/cleanup') {
      const args = route.request().postDataJSON();
      if (failPreview) return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'fixture error'})});
      if (!args.dryRun) {
        if (args.expectedPreview !== 'fixture-preview') throw Error('missing preview binding');
        deletes++; removed = true;
      }
      value = {dryRun:args.dryRun,previewId:'fixture-preview',candidates:removed?[]:['/fixture/old.log'],deleted:args.dryRun?[]:['/fixture/old.log'],reclaimableBytes:removed?0:2048,freedBytes:args.dryRun?0:2048,skipped:['/fixture/active.log'],errors:[]};
    } else throw Error('Unexpected request '+name);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  const check = (ok, label) => { if (!ok) throw Error(label); };
  try {
    await p.goto(new URL('/ui/',page.url()).href);
    await p.locator('#retention-preview').waitFor();
    check(await p.locator('#retention-delete').isDisabled(),'delete disabled before preview');
    await p.locator('#retention-preview').click();
    await p.waitForFunction(() => !document.querySelector('#retention-delete').disabled);
    check((await p.locator('#retention-summary').textContent()).includes('2.0 KiB'),'preview uses reclaimable bytes');
    p.once('dialog',d=>d.dismiss()); await p.locator('#retention-delete').click();
    check(deletes===0,'cancel must not delete');
    await p.locator('#retention-scope').selectOption('exec');
    check(await p.locator('#retention-delete').isDisabled(),'scope change invalidates preview');
    await p.locator('#retention-policy').selectOption('all');
    await p.locator('#retention-preview').click();
    await p.waitForFunction(() => !document.querySelector('#retention-delete').disabled);
    p.once('dialog',d=>d.accept()); await p.locator('#retention-delete').click();
    await p.waitForFunction(() => document.querySelector('#retention-summary').textContent.includes('已删除 1'));
    check(deletes===1,'exactly one deletion');
    check(await p.locator('#retention-delete').isDisabled(),'delete disabled after success');
    check((await p.locator('#retention-summary').textContent()).includes('2.0 KiB'),'freed bytes shown');
    await p.locator('#retention-preview').click();
    await p.waitForFunction(() => document.querySelector('#retention-summary').textContent.includes('发现 0'));
    check(await p.locator('#retention-delete').isDisabled(),'empty preview disables delete');
    failPreview=true; await p.locator('#retention-preview').click();
    await p.waitForFunction(() => document.querySelector('#retention-summary').textContent.includes('fixture error'));
    check(await p.locator('#retention-delete').isDisabled(),'failed preview disables delete');
    await p.setViewportSize({width:390,height:844});
    check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile overflow');
    check(errors.length===0,errors.join('\n'));
    return {passed:10,deletes,pageErrors:errors};
  } finally { await context.close(); }
}
