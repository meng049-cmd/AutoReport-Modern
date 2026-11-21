import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Matcher,norm,orderCriterionKey} from './matcher.mjs';
const item={order:norm('MISS1'),part:norm('PART1'),ic:'Goodix',model:'CY26',confirmed_at:'2026-11-02'};
const reference={records:[],keys:[],manual_corrections:[item]};
test('confirmed corrections survive reload and isolate work order and part',()=>{
 const matcher=new Matcher(JSON.parse(JSON.stringify(reference)));
 assert.equal(matcher.lookup([['order','ＭＩＳＳ１'],['part','part1']])['候選'][0].IC,'Goodix');
 for(const criteria of [[['order','MISS1'],['part','PART2']],[['order','MISS2'],['part','PART1']],[['order','MISS1']]])assert.equal(matcher.lookup(criteria)['狀態'],'查無資料');
});
test('confirmed exact pair resolves ambiguous reference without altering other mappings',()=>{
 const records=[{id:1,ic:'old',model:'old',parts:[],dpns:[],source_file:'old.xlsx'},{id:2,ic:'old2',model:'old2',parts:[],dpns:[],source_file:'old.xlsx'}];
 const keys=records.flatMap(r=>[['order','miss1',r.id],['part','part1',r.id]]);
 assert.equal(new Matcher({records,keys}).lookup([['order','MISS1'],['part','PART1']])['狀態'],'多組候選');
 assert.equal(new Matcher({...reference,records,keys}).lookup([['order','MISS1'],['part','PART1']])['候選'][0]['機種'],'CY26');
});

test('a saved alias is considered alongside the other order candidates',()=>{
 const other={id:1,ic:'Other IC',model:'Other Model',parts:[],dpns:[],source_file:'test.xlsx'};
 const matcher=new Matcher({...reference,records:[other],keys:[['order','wo2',1]]});
 const result=matcher.lookup([['order','MISS1\nWO2']]);
 assert.equal(result['狀態'],'唯一匹配');
 assert.equal(result['候選'][0]['機種'],'Other Model');
 const withPart=matcher.lookup([['order','MISS1\nWO2'],['part','PART1']]);
 assert.equal(withPart['狀態'],'多組候選');
 assert.deepEqual(withPart['候選'].map(candidate=>candidate['機種']),['CY26','Other Model']);
});

test('a correction for an exact order group does not override individual orders',()=>{
 const multi={...item,order:orderCriterionKey('MISS1\nWO2')};
 const matcher=new Matcher({...reference,manual_corrections:[multi]});
 assert.equal(matcher.lookup([['order','WO2\nMISS1'],['part','PART1']])['狀態'],'唯一匹配');
 assert.equal(matcher.lookup([['order','WO2'],['part','PART1']])['狀態'],'查無資料');
});
