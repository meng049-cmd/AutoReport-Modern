(function(root){
const norm=value=>String(value??'').trim().normalize('NFKC').replace(/[–—−]/g,'-').toLowerCase().replace(/\s+/g,'');
function orderCriterionKey(value){
 const raw=String(value??'').trim();
 const decoded=raw.replace(/&#(x[0-9a-f]+|[0-9]+);|&nbsp;/gi,(entity,numeric)=>{
  if(!numeric)return ' ';
  const codePoint=Number(numeric[0].toLowerCase()==='x'?'0'+numeric:numeric);
  if(codePoint>0x10ffff||(codePoint>=0xd800&&codePoint<=0xdfff))return entity;
  return String.fromCodePoint(codePoint);
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
 if(orders.size)return [...orders].map(norm).sort().join('|');
 return norm(raw.split(/[\r\n;；、]+/).find(segment=>segment.trim()));
}

// Resolve old Detail/index rows from explicitly confirmed order/part mappings.
// Keep complete identities and contradictory partial identities for manual review.
function applyConfirmedProductCorrections(merger,corrections=[],applied){
 const mappings=new Map(corrections.filter(row=>row.order&&row.ic&&row.model).map(row=>{
  const stored=norm(row.order);
  const order=stored.includes('|')?stored:orderCriterionKey(row.order);
  return [JSON.stringify([order,norm(row.part||'')]),row];
 }));
 if(!mappings.size)return 0;
 let updated=0;
 for(const value of merger.rows.values()){
  const row=value.row,ic=String(row[9]??'').trim(),model=String(row[10]??'').trim();
  const order=orderCriterionKey(row[1]);if(!order)continue;
  const general=mappings.get(JSON.stringify([order,'']));
  const saved=mappings.get(JSON.stringify([order,norm(row[2])]))||(general?.override?general:null);
  if(!saved)continue;
  if(!saved.override&&((ic&&model)||(ic&&norm(ic)!==norm(saved.ic))||(model&&norm(model)!==norm(saved.model))))continue;
  row[9]=saved.ic;row[10]=saved.model;if(saved.override)applied?.add(saved);updated++;
 }
 return updated;
}

async function resolveConfirmedProducts(merger,applied){
 if(!root.indexedDB)return 0;
 const state=await root.readBrowserDatabase();
 return applyConfirmedProductCorrections(merger,state?.reference?.manual_corrections||[],applied);
}

root.applyConfirmedProductCorrections=applyConfirmedProductCorrections;
root.resolveConfirmedProducts=resolveConfirmedProducts;
})(globalThis);
