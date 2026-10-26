const { chromium } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const repo = path.resolve(__dirname, '../..');
const out = process.env.X8000_TEST_OUTPUT_DIR || path.join(repo, 'test-results');
fs.mkdirSync(out, {recursive:true});
const tests = [];
const server = http.createServer((req,res) => {
  const file = req.url.startsWith('/card.js') ? path.join(repo,'frontend/bticino-programs-card.js') : path.join(repo,'tests/frontend/harness.html');
  res.setHeader('Content-Type',req.url.startsWith('/card.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true});
  async function test(name, fn, query='') {
    const page=await browser.newPage({viewport:{width:1100,height:1500}});const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(url)?route.continue():route.abort());
    await page.goto(url+query);await page.locator('bticino-programs-card [data-action=refresh]').waitFor();
    await page.waitForFunction(()=>!demoCard._busy);
    try{await fn(page);assert.deepEqual(errors,[]);tests.push({name,passed:true});}
    catch(e){tests.push({name,passed:false,error:e.message});}
    await page.close();
  }
  await test('week and known temperatures render',async p=>{
    assert.equal(await p.locator('.week-row').count(),7);
    assert.match(await p.locator('.legend').innerText(),/18/);
    assert.equal(await p.locator('[data-field=active]').inputValue(),'2');
    await p.locator('bticino-programs-card').screenshot({path:path.join(out,'bticino-programs-desktop.png')});
  });
  await test('edit and verified save send edited slots',async p=>{
    await p.locator('[data-action=open][data-number="1"]').click();await p.waitForFunction(()=>!demoCard._busy);
    await p.locator('[data-field=time][data-index="1"]').fill('10:15');
    assert.equal(await p.locator('[data-action=activate]').isDisabled(),true);
    await p.locator('[data-action=save]').click();await p.waitForFunction(()=>!demoCard._busy);
    const save=await p.evaluate(()=>demoCalls.find(c=>c.operation==='save'));
    assert.equal(save.days.monday[1].time,'10:15');assert.equal(save.revision,'revision-1');
    assert.match(await p.locator('.success').innerText(),/verificato/);
  });
  await test('create and copy a day across the week',async p=>{
    await p.locator('[data-action=new]').click();
    await p.locator('[data-field=name]').fill('Nuova settimana');
    await p.locator('[data-action=add-slot]').click();await p.locator('[data-field=time][data-index="1"]').fill('10:00');
    await p.locator('[data-action=add-slot]').click();await p.locator('[data-field=preset][data-index="2"]').selectOption('PROTECTION');
    await p.locator('[data-action=copy]').click();await p.locator('[data-action=save]').click();await p.waitForFunction(()=>!demoCard._busy);
    const save=await p.evaluate(()=>demoCalls.find(c=>c.operation==='save'));
    assert.equal(save.number,3);assert.equal(save.revision,null);assert.equal(save.days.sunday[1].time,'10:00');
  });
  await test('stale revision preserves unsaved draft',async p=>{
    await p.locator('[data-field=name]').fill('Modifica locale');await p.evaluate(()=>demoPrograms[2].sha256='external-change');
    await p.locator('[data-action=save]').click();await p.waitForFunction(()=>!demoCard._busy);
    assert.match(await p.locator('.error').innerText(),/cambiato/);assert.equal(await p.locator('[data-field=name]').inputValue(),'Modifica locale');
  });
  await test('selection activates a program without saving',async p=>{
    await p.locator('[data-field=active]').selectOption('1');await p.waitForFunction(()=>!demoCard._busy);
    assert.equal(await p.evaluate(()=>demoActive),1);assert.equal(await p.evaluate(()=>demoCalls.filter(c=>c.operation==='save').length),0);
  });
  await test('active program cannot be deleted',async p=>{
    assert.equal(await p.locator('[data-action=delete]').isDisabled(),true);
  });
  await test('delete inactive program requires confirmation',async p=>{
    p.on('dialog',d=>d.accept());await p.locator('[data-action=open][data-number="1"]').click();await p.waitForFunction(()=>!demoCard._busy);
    await p.locator('[data-action=delete]').click();await p.waitForFunction(()=>!demoCard._busy);
    assert.equal(await p.evaluate(()=>Boolean(demoPrograms[1])),false);
  });
  await test('non-admin can read but cannot edit',async p=>{
    assert.equal(await p.locator('[data-action=new]').isDisabled(),true);assert.equal(await p.locator('[data-field=name]').isDisabled(),true);
    assert.equal(await p.locator('[data-field=active]').isDisabled(),true);
  },'?readonly=1');
  await test('failed initial connection does not become a polling loop',async p=>{
    await p.evaluate(()=>{for(let i=0;i<10;i++)demoCard.hass=demoHass});await p.waitForTimeout(60);
    assert.equal(await p.evaluate(()=>demoCalls.filter(c=>c.operation==='list').length),1);
  },'?fail=1');
  await test('program names are escaped as text',async p=>{
    await p.locator('[data-action=new]').click();await p.locator('[data-field=name]').fill('<img src=x onerror=window.hacked=1>');
    await p.locator('[data-action=save]').click();await p.waitForFunction(()=>!demoCard._busy);
    assert.equal(await p.locator('bticino-programs-card img').count(),0);assert.equal(await p.evaluate(()=>window.hacked),undefined);
  });
  await test('mobile dark layout has no horizontal document overflow',async p=>{
    await p.setViewportSize({width:390,height:1800});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.locator('bticino-programs-card').screenshot({path:path.join(out,'bticino-programs-mobile-dark.png')});
  },'?dark=1');
  await test('english labels render',async p=>{assert.match(await p.locator('h2').innerText(),/Weekly/);},'?lang=en');
  await test('switching thermostat ignores a pending response for the previous entity',async p=>{
    await p.evaluate(()=>{
      const original=demoHass.callWS;
      demoHass.callWS=async function(msg){if(msg.entity_id==='climate.atrio'&&msg.operation==='list')await new Promise(r=>setTimeout(r,80));return original.call(this,msg)};
      demoCard._load(true);
      demoHass.states['climate.other']={state:'auto',attributes:{friendly_name:'Other',program_number:2,program_mode:'AUTOMATIC',current_function:'HEATING'}};
      demoCard.setConfig({entity:'climate.other'});
    });
    await p.waitForFunction(()=>!demoCard._busy&&demoCard._catalog&&demoCalls.at(-1).entity_id==='climate.other');
    assert.equal(await p.locator('.subtitle').innerText(),'Other');assert.equal(await p.locator('.error').count(),0);
  });
  await test('export downloads the editable weekly program',async p=>{
    const pending=p.waitForEvent('download');await p.locator('[data-action=export]').click();const download=await pending;
    const data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(data.format,'bticino-weekly-program-v1');assert.equal(data.days.monday[1].time,'07:30');
  });
  await test('import creates a new draft without writing',async p=>{
    const data=await p.evaluate(()=>({format:'bticino-weekly-program-v1',...demoPrograms[1]}));
    await p.locator('input[type=file]').setInputFiles({name:'program.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
    await p.waitForFunction(()=>demoCard._draft.number===3);
    assert.equal(await p.evaluate(()=>demoCalls.filter(c=>c.operation==='save').length),0);
    assert.equal(await p.locator('[data-field=time][data-index="1"]').inputValue(),'10:00');
  });
  await test('invalid import keeps the current program',async p=>{
    await p.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
    await p.locator('.error').waitFor();assert.equal(await p.evaluate(()=>demoCard._draft.number),2);
  });
  await test('visual card editor localizes labels and emits entity changes',async p=>{
    const result=await p.evaluate(()=>{const editor=document.createElement('bticino-programs-card-editor');editor.setConfig({entity:'climate.atrio'});editor.hass=demoHass;document.body.append(editor);let changed;editor.addEventListener('config-changed',e=>changed=e.detail.config);editor.querySelector('ha-entity-picker').dispatchEvent(new CustomEvent('value-changed',{detail:{value:'climate.other'}}));return{label:editor.querySelector('label span').textContent,entity:changed.entity}});
    assert.match(result.label,/Titolo/);assert.equal(result.entity,'climate.other');
  });
  await browser.close();server.close();
  fs.writeFileSync(path.join(out,'bticino-programs-ui-test-results.json'),JSON.stringify(tests,null,2));
  console.log(JSON.stringify(tests,null,2));if(tests.some(t=>!t.passed))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
