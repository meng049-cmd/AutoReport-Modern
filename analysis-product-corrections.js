(function(root){
const norm=value=>String(value??'').trim().normalize('NFKC').replace(/[–—−]/g,'-').toLowerCase().replace(/\s+/g,'');
// Resolve old Detail/index rows from confirmed part mappings. Preserve conflicting
// identities unless the mapping was explicitly edited.
function applyConfirmedProductCorrections(merger,corrections=[],applied){
 const mappings=new Map(corrections.filter(row=>!row.order&&row.part&&row.ic&&row.model).map(row=>[norm(row.part),row]));
 if(!mappings.size)return 0;
 let updated=0;
 for(const value of merger.rows.values()){
  const row=value.row,ic=String(row[9]??'').trim(),model=String(row[10]??'').trim();
  const part=String(row[2]??'').split(/[\r\n;；、]+/).find(value=>value.trim());
  const saved=mappings.get(norm(part));
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
