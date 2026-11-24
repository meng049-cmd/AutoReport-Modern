import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {test} from 'node:test';
import {chromium} from '@playwright/test';

test('a second browser can restore an encrypted part-number backup with the recovery code', {timeout:60000}, async () => {
  const root=resolve('dist');
  const server=createServer(async (request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    try{
      if(!file.startsWith(root+sep))throw Error('invalid path');
      const mime=file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/json';
      response.setHeader('Content-Type',mime);
      response.end(await readFile(file));
    }catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
    const first=await browser.newContext();
    const second=await browser.newContext();
    const workspaces=new Map();
    const callers=new Set();
    let anonymousCount=0;
    const uploadId='d0676e5a-4740-43d0-8cd3-ace4ad042eed';
    for(const context of [first,second]){
      await context.route('https://*.supabase.co/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path==='/rest/v1/rpc/autoreport_part_backup_ready'){
          assert.equal(route.request().headers().authorization,undefined);
          await route.fulfill({json:true});
          return;
        }
        if(path==='/auth/v1/signup'){
          const id=++anonymousCount;
          await route.fulfill({json:{access_token:'session-'+id,refresh_token:'refresh-'+id,expires_at:Math.floor(Date.now()/1000)+3600}});
          return;
        }
        callers.add(route.request().headers().authorization);
        const {p_token:token,p_index:index,p_data:data}=route.request().postDataJSON();
        const workspace=workspaces.get(token)||{revision:0,items:[]};
        workspaces.set(token,workspace);
        const head=()=>({revision:workspace.revision,chunks:workspace.items.length,updated_at:workspace.revision?'2026-11-24T00:00:00Z':null});
        const action=path.split('autoreport_part_backup_')[1];
        if(action==='head')await route.fulfill({json:head()});
        else if(action==='begin')await route.fulfill({json:uploadId});
        else if(action==='put'){
          workspace.items[index]=data;
          await route.fulfill({status:204});
        }else if(action==='commit'){
          workspace.revision++;
          await route.fulfill({json:head()});
        }else if(action==='get')await route.fulfill({json:workspace.items[index]});
        else await route.fulfill({status:404,json:{message:'unexpected endpoint'}});
      });
    }
    const site='http://127.0.0.1:'+server.address().port;
    const sender=await first.newPage();
    await sender.goto(site);
    await sender.locator('.cloud-sync summary').click();
    await sender.evaluate(async ()=>{
      const {restore}=await import('/cloud/cloud-sync.mjs');
      await restore({
        format:1,app:'autoreport-part',local:{},databases:{
          'AutoReport-Part-local-database':{state:{keys:['active'],values:[{version:1,reference:{marker:'cross-host-reference'}}]}},
          'AutoReport-Part-file-library':{files:{keys:[],values:[]}}
        }
      },'autoreport-part');
    });
    await sender.getByRole('button',{name:'建立復原金鑰'}).click();
    const code=await sender.locator('#partBackupCode').inputValue();
    sender.on('dialog',dialog=>dialog.accept());
    await sender.getByRole('button',{name:'上傳本機資料',exact:true}).click();
    await sender.getByText('雲端備份已上傳', {exact:false}).waitFor();
    assert.equal(workspaces.size,1);
    const [[token,snapshot]]=workspaces;
    assert.ok(!code.includes(token));
    assert.ok(!Buffer.concat(snapshot.items.map(chunk=>Buffer.from(chunk,'base64'))).includes('cross-host-reference'));

    const receiver=await second.newPage();
    await receiver.goto(site);
    await receiver.locator('.cloud-sync summary').click();
    await receiver.locator('#partBackupCode').fill(code);
    assert.equal(await receiver.locator('.cloud-login').count(),0);
    const downloaded=receiver.waitForEvent('download');
    await receiver.getByRole('button',{name:'下載雲端備份',exact:true}).click();
    assert.match(await readFile(await (await downloaded).path(),'utf8'),/cross-host-reference/);

    receiver.on('dialog',dialog=>dialog.accept());
    await Promise.all([
      receiver.waitForEvent('domcontentloaded'),
      receiver.getByRole('button',{name:'還原雲端備份至本機'}).click()
    ]);
    const restored=await receiver.evaluate(async ()=>{
      const {capture}=await import('/cloud/cloud-sync.mjs');
      const snapshot=await capture('autoreport-part');
      return snapshot.databases['AutoReport-Part-local-database'].state.values[0].reference.marker;
    });
    assert.equal(restored,'cross-host-reference');
    assert.deepEqual([...callers].sort(),['Bearer session-1','Bearer session-2']);
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
