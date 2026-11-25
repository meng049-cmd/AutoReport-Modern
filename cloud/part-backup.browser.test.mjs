import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {test} from 'node:test';
import {chromium} from '@playwright/test';
import ExcelJS from 'exceljs';

test('encrypted analysis reports are selected by month and reopen on another browser', {timeout:90000}, async () => {
  const root=resolve('dist');
  const server=createServer(async (request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    try{
      if(!file.startsWith(root+sep))throw Error('invalid path');
      const mime=/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.wasm')?'application/wasm':'application/octet-stream';
      response.setHeader('Content-Type',mime);
      response.end(await readFile(file));
    }catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
    const first=await browser.newContext(),second=await browser.newContext();
    const reports=new Map(),callers=new Set();
    let anonymousCount=0;
    const uploadId='d0676e5a-4740-43d0-8cd3-ace4ad042eed';
    const uploadedAt='2026-11-25T00:00:00Z';
    for(const context of [first,second]){
      await context.route('https://*.supabase.co/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path.endsWith('autoreport_part_report_ready')){
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
        const {p_token:token,p_report:id,p_index:index,p_data:data,p_start:start,p_end:end}=route.request().postDataJSON();
        const action=path.split('autoreport_part_report_')[1];
        if(action==='list'){
          await route.fulfill({json:[...reports.values()].filter(report=>report.token===token&&report.revision).map(report=>({
            id:report.id,start:report.start,end:report.end,revision:report.revision,uploaded_at:uploadedAt,chunks:report.items.length
          }))});
          return;
        }
        const key=token+':'+id;
        const report=reports.get(key)||{token,id,revision:0,items:[]};
        reports.set(key,report);
        const head=()=>({revision:report.revision,chunks:report.revision?report.items.length:0,updated_at:report.revision?uploadedAt:null});
        if(action==='head')await route.fulfill({json:head()});
        else if(action==='begin'){
          report.start=start;
          report.end=end;
          await route.fulfill({json:uploadId});
        }else if(action==='put'){
          report.items[index]=data;
          await route.fulfill({status:204});
        }else if(action==='commit'){
          report.revision++;
          await route.fulfill({json:head()});
        }else if(action==='get')await route.fulfill({json:report.items[index]});
        else await route.fulfill({status:404,json:{message:'unexpected endpoint'}});
      });
    }
    const site='http://127.0.0.1:'+server.address().port;
    const sender=await first.newPage();
    for(const [date,serial] of [['2026-10-24','OCT-SAMPLE'],['2026-11-16','NOV-SAMPLE']]){
      await sender.goto(site+'/#yield');
      const book=new ExcelJS.Workbook();
      book.addWorksheet('Detail').addRows([
        ['製程','工單','料號','品名規格','小板序號','產出時間','操作人員','不良項目','狀態','IC','機種'],
        ['DAF外觀','WO-1','93000403-102','',serial,Date.parse(date)/86400000+25569,'','Scratch','FAIL','Synaptics','CY26-16']
      ]);
      await sender.getByText('直接分析其他已比對的 Detail 檔',{exact:true}).click();
      await sender.locator('#yieldFile').setInputFiles({name:date+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(await book.xlsx.writeBuffer())});
      await sender.locator('#yieldCalculateUpload').click();
      await sender.locator('#qualityReportDownload').waitFor({timeout:12000}).catch(async error=>{
        throw Error(await sender.locator('#yieldMessage').textContent(),{cause:error});
      });
      await sender.reload();
    }
    await sender.goto(site+'/#/reports');
    await sender.locator('.cloud-sync > summary').click();
    await sender.getByRole('button',{name:'建立復原金鑰'}).click();
    const code=await sender.locator('#partBackupCode').inputValue();
    await sender.locator('#partLocalReportMonth').selectOption('2026-11');
    await sender.locator('#partLocalReport').selectOption({index:1});
    await sender.getByRole('button',{name:'上傳所選分析報表'}).click();
    await sender.getByText('分析報表已上傳', {exact:false}).waitFor();
    assert.equal(reports.size,1);
    const [snapshot]=reports.values();
    assert.equal(snapshot.start,'2026-11-16');
    assert.ok(!code.includes(snapshot.token));
    assert.ok(!Buffer.concat(snapshot.items.map(chunk=>Buffer.from(chunk,'base64'))).includes('NOV-SAMPLE'));

    const receiver=await second.newPage();
    await receiver.goto(site);
    await receiver.locator('.cloud-sync > summary').click();
    await receiver.locator('#partBackupCode').fill(code);
    assert.equal(await receiver.locator('.cloud-login').count(),0);
    await receiver.getByRole('button',{name:'讀取雲端報表清單'}).click();
    await receiver.getByText('找到 1 份雲端報表。', {exact:false}).waitFor();
    await receiver.locator('#partCloudReportMonth').selectOption('2026-11');
    await receiver.locator('#partCloudReport').selectOption({index:1});
    const downloaded=receiver.waitForEvent('download');
    await receiver.getByRole('button',{name:'下載所選 Excel',exact:true}).click();
    const file=new ExcelJS.Workbook();
    await file.xlsx.readFile(await (await downloaded).path());
    assert.ok(file.getWorksheet('料號良率'));
    assert.equal(file.getWorksheet('Detail'),undefined);
    await Promise.all([
      receiver.waitForEvent('domcontentloaded'),
      receiver.getByRole('button',{name:'加入本機分析檔案庫'}).click()
    ]);
    await receiver.locator('#libraryAnalysisMonth').selectOption('2026-11');
    await receiver.getByRole('button',{name:'開啟看板',exact:true}).click();
    await receiver.locator('#qualityReportDownload').waitFor();
    await receiver.locator('#orderYieldTable').getByRole('button',{name:/1 個不良 PPID/}).click();
    assert.match(await receiver.locator('#defectDetailTable').textContent(),/NOV-SAMPLE/);
    assert.deepEqual([...callers].sort(),['Bearer session-1','Bearer session-2']);
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
