import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {Matcher,norm,firstText,role} from './matcher.mjs';
import {matchFile,inputTables,exportMatches} from './files.mjs';
const productionMatcher=new Matcher(JSON.parse(readFileSync('dist/reference.json','utf8')));
// Matching rules use explicit test records, independent of the shipped database.
const records=[
 {id:1,model:'Test Model',ic:'Goodix',orders:['C515-250300004'],parts:['98000320-107']},
 {id:2,model:'Conflict Model',ic:'Goodix',orders:['C533-260100003'],parts:['98000430-101']},
 {id:3,model:'Conflict Model',ic:'Synaptics',orders:['C533-260100003'],parts:['98000430-101']}
].map(r=>({family:'',dpns:[],source_file:'test.xlsx',sheet:'Test',row_number:2,raw_ic:r.ic,resolution:[],search_text:'',...r}));
const keys=records.flatMap(r=>[...r.orders.map(v=>['order',norm(v),r.id]),...r.parts.map(v=>['part',norm(v),r.id]),['ic',norm(r.ic),r.id],['model',norm(r.model),r.id]]);
const matcher=new Matcher({records,keys});
const python='.venv/bin/python';
function oracle(code){return JSON.parse(execFileSync(python,['-c',code],{encoding:'utf8',maxBuffer:30*1024*1024}));}
test('every indexed identifier returns exactly the SQLite candidates and evidence',()=>{
 const expected=oracle("import autoreport as a,json\ndb=a.connect()\nprint(json.dumps([[kind,value,a.lookup(db,[(kind,value)])] for kind,value in db.execute(\"SELECT DISTINCT kind,value FROM lookup_keys WHERE kind='part' ORDER BY kind,value\")],ensure_ascii=False))");
 if(!expected.length){assert.deepEqual(productionMatcher.data.records,[]);assert.deepEqual(productionMatcher.data.keys,[]);assert.equal(productionMatcher.lookup([['part','OLD123']])['狀態'],'查無資料');}
 for(const [kind,value,result] of expected)assert.deepEqual(productionMatcher.lookup([[kind,value]]),result,kind+':'+value);
 console.log(`Compared ${expected.length} identifiers, from the shipped database`);
});
test('sample XLSX matches the full Python result including all original cells',async()=>{
 const filename='上傳查詢範例.xlsx',bytes=readFileSync('downloads/AutoReport_query_template.xlsx');
 const expected=oracle("import autoreport as a,json\nfrom pathlib import Path\nprint(json.dumps(a.match_upload(a.connect(),Path('downloads/AutoReport_query_template.xlsx').read_bytes(),'上傳查詢範例.xlsx'),ensure_ascii=False))");
 const actual=await matchFile(productionMatcher,bytes,filename);assert.deepEqual(actual,expected);
 const exported=await exportMatches(actual),book=new ExcelJS.Workbook();await book.xlsx.load(exported);assert.equal(book.worksheets[0].rowCount,actual['筆數']+1);
});
test('only exact part criteria identify products',()=>{
 assert.equal(norm('產品料號'),norm('产品料号'));
 assert.equal(role('工單號碼'),null);
 assert.equal(role('95料號'),'part');
 assert.equal(firstText('\nSlate/Congo 14,15\nOther'),'Slate/Congo 14,15');
 assert.equal(matcher.lookup([['part','９８０００３２０－１０７']])['狀態'],'唯一匹配');
 assert.equal(matcher.lookup([['part','98000320']])['狀態'],'查無資料');
 assert.equal(matcher.lookup([['part','98000430-101']])['狀態'],'多組候選');
 assert.equal(matcher.lookup([['order','C515-250300004']])['狀態'],'缺少查找欄位');
 assert.equal(matcher.lookup([['any','C515-250300004']])['狀態'],'查無資料');
 assert.equal(matcher.lookup([['any','98000430-101'],['part','98000320-107']])['候選'][0]['機種'],'Test Model');
});

test('Detail matches column C regardless of column B and leaves unresolved J/K blank',async()=>{
 const workbook=new ExcelJS.Workbook();
 workbook.addWorksheet('Detail').addRows([
  ['製程','工單','料號'],
  ['DAF外觀','UNRELATED','98000320-107'],
  ['DAF外觀','C515-250300004','98000430-101'],
  ['DAF外觀','C515-250300004','']
 ]);
 const detail=await matchFile(matcher,await workbook.xlsx.writeBuffer(),'detail.xlsx');
 assert.deepEqual(detail['結果'].map(row=>row['狀態']),['唯一匹配','多組候選','缺少查找欄位']);
 assert.deepEqual(detail['結果'].map(row=>row['機種']),['Test Model','','']);
 assert.deepEqual(detail['結果'].map(row=>row['原始資料'][1]),['UNRELATED','C515-250300004','C515-250300004']);
});

test('all query worksheets, merged parts and cached formula results, no formula execution',async()=>{
 const book=new ExcelJS.Workbook(),s=book.addWorksheet('自訂查詢分頁');s.addRows([['料號','備註'],['98000320-107','=HYPERLINK("https://example.com")'],['','x']]);s.mergeCells('A2:A3');
 const s2=book.addWorksheet('任意第二頁');s2.addRows([['产品料号','机型'],['98000320-107','Goodix']]);
 const tables=await inputTables(await book.xlsx.writeBuffer(),'test.xlsx');assert.equal(tables[0].raw[2][0],'');assert.equal(tables[0].expanded[2][0],'98000320-107');
 const r=await matchFile(matcher,await book.xlsx.writeBuffer(),'test.xlsx');assert.equal(r['筆數'],3);assert.ok(r['結果'].every(i=>i['狀態']==='唯一匹配'));
 const output=new ExcelJS.Workbook();await output.xlsx.load(await exportMatches(r));assert.equal(output.worksheets[0].getCell('I2').type,ExcelJS.ValueType.String);
});
test('CSV quoted newline, UTF-8, Big5 and GB18030, unsupported and oversized files',async()=>{
 const bytes=new TextEncoder().encode('\uFEFF料號,工單號碼,備註\r\n98000430-101,"C515-250300004\nC533-260100003","a,b"\r\n');
 const result=await matchFile(matcher,bytes,'query.csv');assert.equal(result['筆數'],1);assert.equal(result['結果'][0]['狀態'],'多組候選');assert.equal(result['結果'][0]['原始資料'][2]['值'],'a,b');
 for(const encoding of ['cp950','gb18030']){const encoded=execFileSync(python,['-c',`import sys;sys.stdout.buffer.write('料號,機型\\n98000320-107,Goodix\\n'.encode('${encoding}'))`]);assert.equal((await matchFile(matcher,encoded,'query.csv'))['結果'][0]['狀態'],'唯一匹配');}
 await assert.rejects(inputTables(new Uint8Array(100*1024*1024+1),'x.xlsx'),/100 MB/);
 await assert.rejects(inputTables(new Uint8Array(),'x.xls'),/xlsx/);
});

test('wide and sparse worksheets retain populated cells beyond 512 columns without rectangular expansion',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('查詢');sheet.getCell('A1').value='料號';sheet.getCell('A2').value='ORDER1';sheet.getCell('XFD2').value='最右欄';sheet.getCell('A100005').value='ORDER2';
 const tables=await inputTables(await book.xlsx.writeBuffer(),'wide.xlsx');assert.equal(tables[0].raw[1][16383],'最右欄');assert.equal(tables[0].raw[100004][0],'ORDER2');assert.equal(Object.keys(tables[0].raw[1]).length,2);assert.equal(Object.keys(tables[0].raw).length,3);
 const result=await matchFile({lookup(){return {'狀態':'查無資料','候選':[]};}},await book.xlsx.writeBuffer(),'wide.xlsx');assert.equal(result['筆數'],2);assert.equal(result['結果'][1]['列號'],100005);
});

test('CSV matching supports more than 100000 rows and 512 columns',async()=>{
 const rows='料號'+','.repeat(599)+'備註\n'+'ORDER1'+','.repeat(599)+'尾欄\n'+('ORDER1\n').repeat(100004);let calls=0;const result=await matchFile({lookup(){calls++;return {'狀態':'查無資料','候選':[]};}},new TextEncoder().encode(rows),'large.csv');assert.equal(result['筆數'],100005);assert.equal(calls,1);assert.equal(result['結果'].at(-1)['列號'],100006);
});
