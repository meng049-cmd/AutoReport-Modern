import * as OpenCC from 'opencc-js';
const convert = OpenCC.Converter({from:'t', to:'cn'});
export const text = v => v == null ? '' : String(v).trim();
export const norm = v => convert(text(v).normalize('NFKC').replace(/[–—−]/g,'-')).toLowerCase().replace(/\s+/g,'');
export const firstText = v => text(v).split(/[\r\n;；、]+/).find(s=>s.trim())?.trim() || '';
const available = v => !['','-','n/a','na','none','无','未知'].includes(norm(v));
function orderNumbers(value){
  const decoded=text(value).replace(/&#(x[0-9a-f]+|[0-9]+);|&nbsp;/gi,(entity,number)=>{
    if(!number)return ' ';
    const point=Number(number.replace(/^x/i,'0x'));
    if(point>0x10ffff||(point>=0xd800&&point<=0xdfff))return entity;
    return String.fromCodePoint(point);
  }).replace(/<\/?(?:s|del|strike)\b[^>]*>|~~/gi,'');
  const normalized=decoded.normalize('NFKC').replace(/[–—−]/g,'-').toUpperCase();
  const orders=new Set();
  for(const segment of normalized.split(/<br\s*\/?\s*>|[\r\n;,、\\]+/i)){
    const numbers=segment.match(/(?<![A-Z0-9])(?:[A-Z]\d{3}-\d{6,12}|\d{9})(?![A-Z0-9])/g);
    if(numbers)for(const number of numbers)orders.add(number);
    else{
      const order=segment.trim().replace(/^SAP\s*:\s*/,'').trim();
      if(/^[A-Z]{2,}[-_]?[0-9]+$/.test(order))orders.add(order);
    }
  }
  return [...orders];
}
function correctionCandidate(saved){
  return {'機種':saved.model,IC:saved.ic,'產品系列':saved.family?[saved.family]:[],'來源':[{'檔案':'已確認補填對照','分頁':'料號 IC／機種補填','列號':1,'整理依據':['確認時間：'+saved.confirmed_at]}]};
}
export function role(v){
  const h=norm(v);
  if(['dpn','客户品号','客户料号','客户pn','customerp/n'].includes(h))return null;
  if(h.includes('料号')||['产品料号','产品品号','品号','p/n','pn','miyabiexternalp/n','miyabiinternalp/n','partnumber'].includes(h))return 'part';
  if(['查询值','查找值','关键字','关键词','key','query'].includes(h))return 'any';
  return null;
}
export class Matcher {
  constructor(data){
    this.data=data;this.records=new Map(data.records.map(r=>[r.id,r]));this.keys=new Map();this.orderKeys=new Map();
    for(const [kind,value,id] of data.keys){
      if(kind!=='part'&&kind!=='order')continue;
      const index=kind==='part'?this.keys:this.orderKeys;
      if(!index.has(value))index.set(value,new Set());
      index.get(value).add(id);
    }
  }
  ids(value){return this.keys.get(norm(value))||new Set();}
  source(r){return {'檔案':r.source_file,'分頁':r.sheet,'列號':r.row_number,'原始IC／機型':r.raw_ic,'整理依據':r.resolution};}
  lookup(criteria){
    const expectedKind=criteria.some(([kind,value])=>kind==='part'&&norm(firstText(value)))?'part':'any';
    const values=criteria.flatMap(([kind,value])=>{
      const part=firstText(value);
      return kind===expectedKind&&norm(part)?[part]:[];
    });
    const describe=(value,count)=>({'欄位類別':'part','查找值':value,'找到候選組數':count});
    const sets=[],all=new Map(),evidence=new Map(),resolved=[];
    const addCandidate=(key,model,ic,family,source)=>{
      const pair=JSON.stringify([norm(model),norm(ic)]);
      if(!all.has(pair))all.set(pair,{'機種':model,IC:ic,'產品系列':new Set(),'來源':new Map()});
      const candidate=all.get(pair);
      if(family)candidate['產品系列'].add(family);
      candidate['來源'].set(key,source);
      return pair;
    };
    for(const value of values){
      const part=norm(value);
      const saved=(this.data.manual_corrections||[]).find(item=>!item.order&&item.part===part);
      if(saved){
        const [source]=correctionCandidate(saved)['來源'];
        const pair=addCandidate(part,saved.model,saved.ic,saved.family,source);
        sets.push(new Set([pair]));
        resolved.push(describe(value,1));
        evidence.set(part,source);
        continue;
      }
      const ids=this.ids(value);
      const linked=new Set(ids);
      for(const id of ids){
        const record=this.records.get(id);
        if(record.model)continue;
        const primary=record.parts.filter(part=>part.startsWith('98'));
        const secondary=record.parts.filter(part=>part.startsWith('95'));
        const anchors=primary.length?primary:secondary.length?secondary:record.parts;
        for(const identifier of anchors){
          for(const other of this.ids(identifier)){
            if(!record.ic||norm(this.records.get(other).ic)===norm(record.ic))linked.add(other);
          }
        }
      }
      const pairs=new Set();
      for(const id of [...linked].sort((a,b)=>a-b)){
        const record=this.records.get(id);
        pairs.add(addCandidate(id,record.model,record.ic,record.family,this.source(record)));
      }
      const hasIC=[...pairs].some(pair=>JSON.parse(pair)[1]);
      const matches=new Set([...pairs].filter(pair=>!hasIC||JSON.parse(pair)[1]));
      for(const id of [...ids].sort((a,b)=>a-b)){
        const record=this.records.get(id);
        evidence.set(id,{'檔案':record.source_file,'分頁':record.sheet,'列號':record.row_number});
      }
      sets.push(matches);
      resolved.push(describe(value,matches.size));
    }
    const intersection=sets.length?[...sets[0]].filter(pair=>sets.every(set=>set.has(pair))):[];
    intersection.sort((a,b)=>{const x=JSON.parse(a),y=JSON.parse(b);return x[0]<y[0]?-1:x[0]>y[0]?1:x[1]<y[1]?-1:x[1]>y[1]?1:0;});
    const candidates=intersection.map(p=>{const c=all.get(p);return {'機種':c['機種'],IC:c.IC,'產品系列':[...c['產品系列']].sort(),'來源':[...c['來源'].values()]};});
    const status=!sets.length?'缺少查找欄位':!intersection.length?(sets.length>1&&sets.some(s=>s.size)?'條件不一致':'查無資料'):candidates.length>1?'多組候選':!available(candidates[0].IC)||!available(candidates[0]['機種'])?'來源未提供完整對應':'唯一匹配';
    return {'狀態':status,'候選':candidates,'查找條件':resolved,'查找依據':[...evidence.values()]};
  }
  resolveDetailOrder(part,order,result){
    const orders=orderNumbers(order);
    const orderIds=new Set(orders.flatMap(value=>[...(this.orderKeys.get(norm(value))||[])]));
    const partIds=this.ids(firstText(part));
    // An indexed part can only be disambiguated by records containing both identifiers.
    const ids=partIds.size?[...orderIds].filter(id=>partIds.has(id)):[...orderIds];
    const records=ids.sort((a,b)=>a-b).map(id=>this.records.get(id));
    if(!records.length)return result;
    const first=records[0];
    if(records.some(record=>!available(record.ic)||!available(record.model)
      ||norm(record.ic)!==norm(first.ic)||norm(record.model)!==norm(first.model)))return result;
    const candidate={'機種':first.model,IC:first.ic,
      '產品系列':[...new Set(records.map(record=>record.family).filter(Boolean))].sort(),
      '來源':records.map(record=>this.source(record))};
    const orderCondition={'欄位類別':'order','查找值':orders.join('\n'),'找到候選組數':1};
    return {'狀態':'唯一匹配','候選':[candidate],
      '查找條件':[...result['查找條件'],orderCondition],
      '查找依據':records.map(record=>({'檔案':record.source_file,'分頁':record.sheet,'列號':record.row_number}))};
  }
}
export function matchTables(matcher,tables,filename){
  const results=[],notices=[],lookups=new Map();
  for(const {name,raw,expanded} of tables){
    let header=null;
    for(let i=0;i<Math.min(raw.length,50);i++){const roles=(raw[i]||[]).map(role),score=roles.filter(Boolean).length;if(score&&(!header||score>header.score))header={score,offset:i,headers:raw[i]||[],roles};}
    if(!header){notices.push(`「${name}」沒有可辨識的查找欄位；請使用料號或查詢值。`);continue;}
    for(let i=header.offset+1;i<raw.length;i++){
      if(!(raw[i]||[]).some(Boolean))continue;
      const criteria=header.roles.flatMap((r,c)=>r&&expanded[i][c]?[[r,expanded[i][c]]]:[]),key=JSON.stringify(criteria);if(!lookups.has(key))lookups.set(key,matcher.lookup(criteria));const result=lookups.get(key);
      const unique=result['狀態']==='唯一匹配'?result['候選'][0]:{};
      const row={'分頁':name,'列號':i+1,'原始資料':[...new Set([...Object.keys(header.headers),...Object.keys(raw[i])])].map(Number).sort((a,b)=>a-b).map(c=>({'欄位':header.headers[c]||'','值':raw[i][c]||''})),'機種':unique['機種']||'',IC:unique.IC||'',...result};
      results.push(row);
    }
  }
  return {'檔名':filename,'筆數':results.length,'提示':notices,'結果':results};
}
