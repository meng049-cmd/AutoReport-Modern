import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {Matcher,norm,firstText,orderNumbers,role} from './matcher.mjs';
import {matchFile,inputTables,exportMatches} from './files.mjs';
const productionMatcher=new Matcher(JSON.parse(readFileSync('dist/reference.json','utf8')));
// Matching rules use explicit test records, independent of the shipped database.
const records=[
 {id:1,model:'Test Model',ic:'Goodix',orders:['C515-250300004'],parts:['98000320-107']},
 {id:2,model:'Conflict Model',ic:'Goodix',orders:['C533-260100003'],parts:[]},
 {id:3,model:'Conflict Model',ic:'Synaptics',orders:['C533-260100003'],parts:[]}
].map(r=>({family:'',dpns:[],source_file:'test.xlsx',sheet:'Test',row_number:2,raw_ic:r.ic,resolution:[],search_text:'',...r}));
const keys=records.flatMap(r=>[...r.orders.map(v=>['order',norm(v),r.id]),...r.parts.map(v=>['part',norm(v),r.id]),['ic',norm(r.ic),r.id],['model',norm(r.model),r.id]]);
const matcher=new Matcher({records,keys});
const python='.venv/bin/python';
function oracle(code){return JSON.parse(execFileSync(python,['-c',code],{encoding:'utf8',maxBuffer:30*1024*1024}));}
test('every indexed identifier returns exactly the SQLite candidates and evidence',()=>{
 const expected=oracle("import autoreport as a,json\ndb=a.connect()\nprint(json.dumps([[kind,value,a.lookup(db,[(kind,value)])] for kind,value in db.execute('SELECT DISTINCT kind,value FROM lookup_keys ORDER BY kind,value')],ensure_ascii=False))");
 if(!expected.length){assert.deepEqual(productionMatcher.data.records,[]);assert.deepEqual(productionMatcher.data.keys,[]);assert.equal(productionMatcher.lookup([['order','OLD123']])['狀態'],'查無資料');}
 for(const [kind,value,result] of expected)assert.deepEqual(productionMatcher.lookup([[kind,value]]),result,kind+':'+value);
 console.log(`Compared ${expected.length} identifiers, from the shipped database`);
});
test('sample XLSX matches the full Python result including all original cells',async()=>{
 const filename='上傳查詢範例.xlsx',bytes=readFileSync('downloads/AutoReport_query_template.xlsx');
 const expected=oracle("import autoreport as a,json\nfrom pathlib import Path\nprint(json.dumps(a.match_upload(a.connect(),Path('downloads/AutoReport_query_template.xlsx').read_bytes(),'上傳查詢範例.xlsx'),ensure_ascii=False))");
 const actual=await matchFile(productionMatcher,bytes,filename);assert.deepEqual(actual,expected);
 const exported=await exportMatches(actual),book=new ExcelJS.Workbook();await book.xlsx.load(exported);assert.equal(book.worksheets[0].rowCount,16);
});
test('Chinese aliases, width, prefixes and first entries retain names with slash/comma',()=>{
 assert.equal(norm('機種'),norm('机种'));assert.equal(role('機型'),'ic');assert.equal(role('工單號碼'),'order');
 assert.equal(firstText('\nSlate/Congo 14,15\nOther'),'Slate/Congo 14,15');
 assert.equal(matcher.lookup([['order','ＳＡＰ： Ｃ５１５－２５０３００００４\nC533-260100003']])['狀態'],'多組候選');
 assert.equal(matcher.lookup([['order','C515-251100004']])['狀態'],'查無資料');
 assert.equal(matcher.lookup([['order','C533-260100003']])['狀態'],'多組候選');
 assert.equal(matcher.lookup([['order','C515-250300004'],['ic','Synaptics']])['狀態'],'條件不一致');
});
test('all work orders in one cell are considered without filtering by part',async()=>{
 const cell='~~C520-260600014~~<br>\n C520-260700009\r\nSAP:Ｃ５２０－６２６０７００４６\nC520-626070046';
 const orders=['C520-260600014','C520-260700009','C520-626070046'];
 assert.deepEqual(orderNumbers(cell),orders);
 assert.deepEqual(orderNumbers('~~WO001~~<br />SAP: WO002'),['WO001','WO002']);

 const reference=new Matcher({records,keys:[
  ['order',norm(orders[1]),2],
  ['order',norm(orders[2]),1],
  ['part','98000320-107',1]
 ]});
 const result=reference.lookup([['order',cell]]);
 assert.equal(result['狀態'],'多組候選');
 assert.deepEqual(result['候選'].map(row=>row['機種']),['Conflict Model','Test Model']);
 assert.deepEqual(result['查找條件'],[{'欄位類別':'order','查找值':orders.join('\n'),'找到候選組數':2}]);
 const workbook=new ExcelJS.Workbook();
 workbook.addWorksheet('Detail').addRows([['製程','工單','料號'],['DAF外觀',cell,'98000320-107']]);
 const detail=await matchFile(reference,await workbook.xlsx.writeBuffer(),'multi-order.xlsx');
 assert.equal(detail['結果'][0]['狀態'],'多組候選');
 assert.equal(detail['結果'][0]['機種'],'');
 assert.equal(detail['結果'][0]['原始資料'][1],cell);
 const lastOrderOnly=new Matcher({records,keys:[['order',norm(orders[2]),1]]});
 assert.equal(lastOrderOnly.lookup([['any',cell]])['狀態'],'唯一匹配');
});
test('struck work orders and HTML-encoded identifiers can both match',async()=>{
 const cells=[
  '~~C520-251200018~~<br>~~&#32;   &#32;~~&#x43;520-260100004',
  '~~C520-251200017~~<br>~~&#32;   &#32;~~&#x43;520-260100002'
 ];
 assert.deepEqual(orderNumbers(cells[0]),['C520-251200018','C520-260100004']);
 assert.deepEqual(orderNumbers(cells[1]),['C520-251200017','C520-260100002']);
 assert.deepEqual(orderNumbers('~~C520-251200017~~'),['C520-251200017']);
 assert.deepEqual(orderNumbers('<del>WO1</del>&#10;&nbsp;<s>SAP: WO2</s>'),['WO1','WO2']);

 const reference=new Matcher({records,keys:[
  ['order','c520-260100004',records[0].id],
  ['order','c520-251200017',records[0].id]
 ]});
 const workbook=new ExcelJS.Workbook();
 const sheet=workbook.addWorksheet('查詢');
 sheet.addRows([['工單號碼'],...cells.map(cell=>[cell])]);
 sheet.addRow([{richText:[{text:'C520-251200017',font:{strike:true}},{text:'\nC520-260100002'}]}]);
 const result=await matchFile(reference,await workbook.xlsx.writeBuffer(),'decorated.xlsx');
 assert.ok(result['結果'].every(row=>row['狀態']==='唯一匹配'));
 assert.deepEqual(result['結果'].map(row=>row['原始資料'][0]['值']),[...cells,'C520-251200017\nC520-260100002']);
});
test('a mismatched input part cannot block a known work order',async()=>{
 const order='C520-260100006',part='98000429-101',otherPart='98000430-101';
 const taroko={...records[0],model:'Taroko 14',parts:[part]};
 const reference=new Matcher({records:[taroko,records[1]],keys:[
  ['order',norm(order),taroko.id],['part',part,taroko.id],['part',otherPart,records[1].id]
 ]});
 const csv=new TextEncoder().encode('工單號碼,料號\n'+order+','+otherPart+'\n');
 const [matched]=(await matchFile(reference,csv,'query.csv'))['結果'];
 assert.equal(matched['狀態'],'唯一匹配');
 assert.equal(matched['機種'],'Taroko 14');
 assert.equal(matched.IC,'Goodix');
 assert.deepEqual(matched['查找條件'].map(term=>term['欄位類別']),['order']);
 assert.equal(reference.lookup([['order','WO999'],['part',part]])['狀態'],'查無資料');
 assert.equal(reference.lookup([['part',otherPart]])['候選'][0]['機種'],'Conflict Model');
});
test('all query worksheets, merged orders and cached formula results, no formula execution',async()=>{
 const book=new ExcelJS.Workbook(),s=book.addWorksheet('自訂查詢分頁');s.addRows([['工單號碼','備註'],['C515-250300004','=HYPERLINK("https://example.com")'],['','x']]);s.mergeCells('A2:A3');
 const s2=book.addWorksheet('任意第二頁');s2.addRows([['产品料号','机型'],['98000320-107','Goodix']]);
 const tables=await inputTables(await book.xlsx.writeBuffer(),'test.xlsx');assert.equal(tables[0].raw[2][0],'');assert.equal(tables[0].expanded[2][0],'C515-250300004');
 const r=await matchFile(matcher,await book.xlsx.writeBuffer(),'test.xlsx');assert.equal(r['筆數'],3);assert.ok(r['結果'].every(i=>i['狀態']==='唯一匹配'));
 const output=new ExcelJS.Workbook();await output.xlsx.load(await exportMatches(r));assert.equal(output.worksheets[0].getCell('I2').type,ExcelJS.ValueType.String);
});
test('CSV quoted newline, UTF-8, Big5 and GB18030, unsupported and oversized files',async()=>{
 const bytes=new TextEncoder().encode('\uFEFF工單號碼,機型,備註\r\n"C515-250300004\nC533-260100003",Goodix,"a,b"\r\n');
 const result=await matchFile(matcher,bytes,'query.csv');assert.equal(result['筆數'],1);assert.equal(result['結果'][0]['狀態'],'多組候選');assert.equal(result['結果'][0]['原始資料'][2]['值'],'a,b');
 for(const encoding of ['cp950','gb18030']){const encoded=execFileSync(python,['-c',`import sys;sys.stdout.buffer.write('工單號碼,機型\\nC515-250300004,Goodix\\n'.encode('${encoding}'))`]);assert.equal((await matchFile(matcher,encoded,'query.csv'))['結果'][0]['狀態'],'唯一匹配');}
 await assert.rejects(inputTables(new Uint8Array(100*1024*1024+1),'x.xlsx'),/100 MB/);
 await assert.rejects(inputTables(new Uint8Array(),'x.xls'),/xlsx/);
});

test('wide and sparse worksheets retain populated cells beyond 512 columns without rectangular expansion',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('查詢');sheet.getCell('A1').value='工單號碼';sheet.getCell('A2').value='ORDER1';sheet.getCell('XFD2').value='最右欄';sheet.getCell('A100005').value='ORDER2';
 const tables=await inputTables(await book.xlsx.writeBuffer(),'wide.xlsx');assert.equal(tables[0].raw[1][16383],'最右欄');assert.equal(tables[0].raw[100004][0],'ORDER2');assert.equal(Object.keys(tables[0].raw[1]).length,2);assert.equal(Object.keys(tables[0].raw).length,3);
 const result=await matchFile({lookup(){return {'狀態':'查無資料','候選':[]};}},await book.xlsx.writeBuffer(),'wide.xlsx');assert.equal(result['筆數'],2);assert.equal(result['結果'][1]['列號'],100005);
});

test('CSV matching supports more than 100000 rows and 512 columns',async()=>{
 const rows='工單號碼'+','.repeat(599)+'備註\n'+'ORDER1'+','.repeat(599)+'尾欄\n'+('ORDER1\n').repeat(100004);let calls=0;const result=await matchFile({lookup(){calls++;return {'狀態':'查無資料','候選':[]};}},new TextEncoder().encode(rows),'large.csv');assert.equal(result['筆數'],100005);assert.equal(calls,1);assert.equal(result['結果'].at(-1)['列號'],100006);
});
