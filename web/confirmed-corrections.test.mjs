import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Matcher,norm} from './matcher.mjs';

const correction={order:'',part:norm('PART1'),ic:'Goodix',model:'CY26',confirmed_at:'2026-11-02'};
const reference={records:[],keys:[],manual_corrections:[correction]};
test('confirmed corrections survive reload and apply only to the exact normalized part',()=>{
 const matcher=new Matcher(JSON.parse(JSON.stringify(reference)));
 for(const order of ['WO1','WO2']){
  const result=matcher.lookup([['order',order],['part','ＰＡＲＴ１']]);
  assert.equal(result['狀態'],'唯一匹配');
  assert.equal(result['候選'][0].IC,'Goodix');
 }
 assert.equal(matcher.lookup([['part','PART2']])['狀態'],'查無資料');
 assert.equal(matcher.lookup([['order','WO1']])['狀態'],'缺少查找欄位');
});

test('confirmed part correction resolves an ambiguous reference without altering other parts',()=>{
 const records=[{id:1,ic:'old',model:'old',parts:[],source_file:'old.xlsx'},{id:2,ic:'old2',model:'old2',parts:[],source_file:'old.xlsx'}];
 const keys=[['part','part1',1],['part','part1',2],['part','part2',2]];
 assert.equal(new Matcher({records,keys}).lookup([['part','PART1']])['狀態'],'多組候選');
 const matcher=new Matcher({...reference,records,keys});
 assert.equal(matcher.lookup([['part','PART1']])['候選'][0]['機種'],'CY26');
 assert.equal(matcher.lookup([['part','PART2']])['候選'][0]['機種'],'old2');
});

test('legacy work-order corrections do not override part lookups',()=>{
 const matcher=new Matcher({...reference,manual_corrections:[{...correction,order:'wo1'}]});
 assert.equal(matcher.lookup([['order','WO1'],['part','PART1']])['狀態'],'查無資料');
});
