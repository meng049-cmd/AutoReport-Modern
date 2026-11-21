import * as OpenCC from 'opencc-js';
const convert = OpenCC.Converter({from:'t', to:'cn'});
export const text = v => v == null ? '' : String(v).trim();
export const norm = v => convert(text(v).normalize('NFKC').replace(/[–—−]/g,'-')).toLowerCase().replace(/\s+/g,'');
export const firstText = v => text(v).split(/[\r\n;；、]+/).find(s=>s.trim())?.trim() || '';
const available = v => !['','-','n/a','na','none','无','未知'].includes(norm(v));
export function orderNumbers(value){
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
export const correctionPart=Symbol('correctionPart');
export const correctionOrder=value=>orderNumbers(value)[0]||firstText(value);
export const orderCriterionKey=value=>{
  const orders=orderNumbers(value);
  return orders.length>1?orders.map(norm).sort().join('|'):norm(orders[0]||firstText(value));
};
function correctionCandidate(saved){
  return {'機種':saved.model,IC:saved.ic,'產品系列':saved.family?[saved.family]:[],'來源':[{'檔案':'已確認補填對照','分頁':'工單 IC／機種補填','列號':1,'整理依據':['確認時間：'+saved.confirmed_at]}]};
}
export function role(v){
  const h=norm(v);
  if(['ic','机型','ic型号','ic厂商','ic品牌'].includes(h))return 'ic';
  if(['机种','platform','产品名称','产品名','model','机种名称'].includes(h))return 'model';
  if(['dpn','客户品号','客户料号','客户pn','customerp/n'].includes(h))return 'dpn';
  if(h.includes('工单')||['客户订单号','工令号','workorder','workorderno'].includes(h))return 'order';
  if(h.includes('料号')||['产品料号','产品品号','品号','p/n','pn','miyabiexternalp/n','miyabiinternalp/n','partnumber'].includes(h))return 'part';
  if(['查询值','查找值','关键字','关键词','key','query'].includes(h))return 'any';
  return null;
}
export class Matcher {
  constructor(data){
    this.data=data;this.records=new Map(data.records.map(r=>[r.id,r]));this.keys=new Map();
    for(const [kind,value,id] of data.keys){for(const k of [kind+'\0'+value,'any\0'+value]){if(!this.keys.has(k))this.keys.set(k,new Set());this.keys.get(k).add(id);}}
  }
  ids(kind,value){return this.keys.get(kind+'\0'+norm(value))||new Set();}
  source(r){return {'檔案':r.source_file,'分頁':r.sheet,'列號':r.row_number,'原始IC／機型':r.raw_ic,'整理依據':r.resolution};}
  lookup(criteria){
    const terms=criteria.flatMap(([kind,value])=>{
      const orders=kind==='order'||kind==='any'?orderNumbers(value):[];
      const values=orders.length?orders:[firstText(value)];
      return norm(values[0])?[{kind,values}]:[];
    });
    const explicitOrder=terms.find(term=>term.kind==='order');
    const orderTerm=explicitOrder||(terms.length===1&&terms[0].kind==='any'?terms[0]:null);
    const part=norm(terms.find(term=>term.kind==='part')?.values[0]);
    // The part scopes saved corrections but does not constrain an order lookup.
    const matchTerms=explicitOrder?terms.filter(term=>term.kind!=='part'):terms;
    const savedFor=order=>{
      const corrections=(this.data.manual_corrections||[]).filter(item=>item.order===order);
      return corrections.find(item=>item.part===part)||corrections.find(item=>item.override&&item.part==='');
    };
    const describe=({kind,values},count)=>({'欄位類別':kind,'查找值':values.join('\n'),'找到候選組數':count});
    const saved=orderTerm&&savedFor(orderCriterionKey(orderTerm.values.join('\n')));
    if(saved){
      const candidate=correctionCandidate(saved);
      return {'狀態':'唯一匹配','候選':[candidate],'查找條件':matchTerms.map(term=>describe(term,1)),'查找依據':candidate['來源']};
    }
    const sets=[],all=new Map(),evidence=new Map(),resolved=[],confirmed=new Set();
    const addCandidate=(key,model,ic,family,source)=>{
      const pair=JSON.stringify([norm(model),norm(ic)]);
      if(!all.has(pair))all.set(pair,{'機種':model,IC:ic,'產品系列':new Set(),'來源':new Map()});
      const candidate=all.get(pair);
      if(family)candidate['產品系列'].add(family);
      candidate['來源'].set(key,source);
      return pair;
    };
    for(const term of matchTerms){
      const {kind,values}=term,alternatives=new Set(),ids=new Set();
      for(const value of values){
        const correction=term===orderTerm&&values.length>1&&savedFor(norm(value));
        if(correction){
          const [source]=correctionCandidate(correction)['來源'];
          const pair=addCandidate(correction,correction.model,correction.ic,correction.family,source);
          alternatives.add(pair);
          // Confirmed overrides already match the explicit order/part scope.
          confirmed.add(pair);
          evidence.set(correction,source);
        }else{
          for(const id of this.ids(kind,value))ids.add(id);
        }
      }
      const linked=new Set(ids);
      for(const id of ids){
        const record=this.records.get(id);
        if(record.model)continue;
        const primary=record.parts.filter(part=>part.startsWith('98'));
        const secondary=record.parts.filter(part=>part.startsWith('95'));
        const anchors=primary.length?primary:secondary.length?secondary:record.parts;
        for(const [key,identifier] of [...anchors.map(part=>['part',part]),...record.dpns.map(dpn=>['dpn',dpn])]){
          for(const other of this.ids(key,identifier)){
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
      for(const pair of pairs)if(!hasIC||JSON.parse(pair)[1])alternatives.add(pair);
      for(const id of [...ids].sort((a,b)=>a-b)){
        const record=this.records.get(id);
        evidence.set(id,{'檔案':record.source_file,'分頁':record.sheet,'列號':record.row_number});
      }
      sets.push(alternatives);
      resolved.push(describe(term,alternatives.size));
    }
    const intersection=sets.length?[...sets[0]].filter(pair=>sets.every(set=>set.has(pair))):[];
    for(const pair of confirmed)if(!intersection.includes(pair))intersection.push(pair);
    intersection.sort((a,b)=>{const x=JSON.parse(a),y=JSON.parse(b);return x[0]<y[0]?-1:x[0]>y[0]?1:x[1]<y[1]?-1:x[1]>y[1]?1:0;});
    const candidates=intersection.map(p=>{const c=all.get(p);return {'機種':c['機種'],IC:c.IC,'產品系列':[...c['產品系列']].sort(),'來源':[...c['來源'].values()]};});
    const status=!sets.length?'缺少查找欄位':!intersection.length?(sets.length>1&&sets.some(s=>s.size)?'條件不一致':'查無資料'):candidates.length>1?'多組候選':!available(candidates[0].IC)||!available(candidates[0]['機種'])?'來源未提供完整對應':'唯一匹配';
    return {'狀態':status,'候選':candidates,'查找條件':resolved,'查找依據':[...evidence.values()]};
  }
  search(q){return this.data.records.filter(r=>r.search_text.includes(norm(q))).slice(0,100);}
}
export function matchTables(matcher,tables,filename){
  const results=[],notices=[],lookups=new Map();
  for(const {name,raw,expanded} of tables){
    let header=null;
    for(let i=0;i<Math.min(raw.length,50);i++){const roles=(raw[i]||[]).map(role),score=roles.filter(Boolean).length;if(score&&(!header||score>header.score))header={score,offset:i,headers:raw[i]||[],roles};}
    if(!header){notices.push(`「${name}」沒有可辨識的查找欄位；請使用工單號、料號、DPN、機種、IC／機型或查詢值。`);continue;}
    for(let i=header.offset+1;i<raw.length;i++){
      if(!(raw[i]||[]).some(Boolean))continue;
      const criteria=header.roles.flatMap((r,c)=>r&&expanded[i][c]?[[r,expanded[i][c]]]:[]),key=JSON.stringify(criteria);if(!lookups.has(key))lookups.set(key,matcher.lookup(criteria));const result=lookups.get(key);
      const unique=result['狀態']==='唯一匹配'?result['候選'][0]:{};
      const row={'分頁':name,'列號':i+1,'原始資料':[...new Set([...Object.keys(header.headers),...Object.keys(raw[i])])].map(Number).sort((a,b)=>a-b).map(c=>({'欄位':header.headers[c]||'','值':raw[i][c]||''})),'機種':unique['機種']||'',IC:unique.IC||'',...result};
      const part=criteria.find(([kind])=>kind==='part')?.[1];
      if(part)Object.defineProperty(row,correctionPart,{value:part});
      results.push(row);
    }
  }
  return {'檔名':filename,'筆數':results.length,'提示':notices,'結果':results};
}
