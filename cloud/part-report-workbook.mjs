const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const inputLimit = 120 * 1024 * 1024;
const outputLimit = 50 * 1024 * 1024;
const metadataLimit = 1024 * 1024;
const rawSheetName = /^(?:Detail|待補產品資料)(?:_\d+)?$/i;
const rawPropertyName = /\bname\s*=\s*["'](?:AutoReportFirstNG|AutoReportAnalysisNG|AutoReportSkippedRows)["']/;
const invalid = () => Error('無法確認 Excel 報表已排除原始 Detail，請從分析看板重新產生報表。');

function readEntry(zip, name, limit = metadataLimit) {
 const entry = zip.file(name);
 if (!entry) throw invalid();
 return collectBytes(entry.internalStream('uint8array'), limit);
}
function collectBytes(stream, limit) {
 return new Promise((resolve, reject) => {
  const parts = [];
  let size = 0;
  stream.on('data', chunk => {
   size += chunk.byteLength;
   if (size > limit) {
    stream.pause();
    reject(Error('Excel 報表超過可處理的容量上限。'));
   } else parts.push(chunk);
  }).on('error', reject).on('end', () => resolve(new Blob(parts))).resume();
 });
}
function tags(xml, name) {
 return [...xml.matchAll(new RegExp('<(?:[\\w.-]+:)?' + name + '\\b(?:[^"\'<>]|"[^"]*"|\'[^\']*\')*?\\/?>', 'g'))];
}
function attr(tag, name) {
 const match = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'));
 return match?.[1] ?? match?.[2] ?? '';
}
function sheetName(tag) {
 const value = attr(tag, 'name');
 return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
  const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
  return point <= 0x10FFFF ? String.fromCodePoint(point) : '';
 });
}
function withoutTags(xml, removed) {
 for (const [tag] of removed) xml = xml.replace(tag, '');
 return xml;
}

async function cleanWorkbook(blob, JSZip) {
 if (!(blob instanceof Blob) || blob.size < 22) throw invalid();
 if (blob.size > inputLimit) throw Error('Excel 原檔超過 120 MiB 整理上限。');
 const zip = await JSZip.loadAsync(await blob.arrayBuffer());
 const workbookPath = 'xl/workbook.xml', workbookRels = 'xl/_rels/workbook.xml.rels';
 const workbook = await (await readEntry(zip, workbookPath)).text();
 const rawSheet = tag => rawSheetName.test(sheetName(tag).trim());
 const sheets = tags(workbook, 'sheet');
 const removedSheets = sheets.filter(([tag]) => rawSheet(tag));
 if (!sheets.length || removedSheets.length === sheets.length) throw invalid();

 const custom = 'docProps/custom.xml';
 let discardCustom = removedSheets.length > 0;
 if (!discardCustom && zip.file(custom)) {
  // A sheet may have been deleted manually while private first-NG metadata remained.
  discardCustom = await readEntry(zip, custom).then(async contents => rawPropertyName.test(await contents.text()), () => true);
 }
 if (!removedSheets.length && !discardCustom) return null;

 const removedPaths = new Set();
 if (discardCustom) removedPaths.add(custom);
 if (removedSheets.length) {
  // Shared strings and worksheet parts can retain raw values which are not safely separable here.
  if (zip.file('xl/sharedStrings.xml') || tags(workbook, 'definedName').length) throw invalid();
  const removedIds = new Set(removedSheets.map(([tag]) => attr(tag, '[\\w.-]+:id')));
  const relationships = await (await readEntry(zip, workbookRels)).text();
  const rels = tags(relationships, 'Relationship');
  if (rels.some(([tag]) => attr(tag, 'Type').endsWith('/sharedStrings'))) throw invalid();
  const removedRels = rels.filter(([tag]) => removedIds.has(attr(tag, 'Id')));
  const filePath = tag => {
   const target = attr(tag, 'Target');
   if (/^\/?xl\/worksheets\/[\w.-]+\.xml$/.test(target)) return target.replace(/^\//, '');
   if (/^worksheets\/[\w.-]+\.xml$/.test(target)) return 'xl/' + target;
   return '';
  };
  if (removedIds.size !== removedSheets.length || removedIds.has('') || removedRels.length !== removedSheets.length ||
      sheets.some(([tag]) => !rawSheet(tag) && removedIds.has(attr(tag, '[\\w.-]+:id')))) throw invalid();
  for (const [tag] of removedRels) {
   if (!attr(tag, 'Type').endsWith('/worksheet')) throw invalid();
   const path = filePath(tag);
   if (!path || !zip.file(path) || rels.some(([other]) => other !== tag && filePath(other) === path)) throw invalid();
   const related = path.replace(/\/([^/]+)$/, '/_rels/$1.rels');
   if (zip.file(related)) throw invalid();
   removedPaths.add(path);
  }
  for (const relation of rels) {
   if (!attr(relation[0], 'Type').endsWith('/calcChain')) continue;
   removedRels.push(relation);
   removedPaths.add('xl/calcChain.xml');
  }
  const firstVisible = sheets.filter(([tag]) => !rawSheet(tag)).findIndex(([tag]) => !attr(tag, 'state') || attr(tag, 'state') === 'visible');
  if (firstVisible < 0) throw invalid();
  let result = withoutTags(workbook, removedSheets);
  for (const [tag] of tags(result, 'workbookView')) {
   result = result.replace(tag, tag.replace(/\s(activeTab|firstSheet)\s*=\s*(?:"\d+"|'\d+')/g,
    (original, name) => ` ${name}="${firstVisible}"`));
  }
  zip.file(workbookPath, result);
  zip.file(workbookRels, withoutTags(relationships, removedRels));
  // Extended properties enumerate the old sheet names and counts.
  removedPaths.add('docProps/app.xml');
 }
 const rootRels = '_rels/.rels', contentTypes = '[Content_Types].xml';
 const root = await (await readEntry(zip, rootRels)).text();
 zip.file(rootRels, withoutTags(root, tags(root, 'Relationship')
  .filter(([tag]) => removedPaths.has(attr(tag, 'Target').replace(/^\//, '')))));
 const types = await (await readEntry(zip, contentTypes)).text();
 zip.file(contentTypes, withoutTags(types, tags(types, 'Override')
  .filter(([tag]) => removedPaths.has(attr(tag, 'PartName').replace(/^\//, '')))));
 for (const path of removedPaths) zip.remove(path);
 const output = await collectBytes(zip.generateInternalStream({type:'uint8array', compression:'DEFLATE', streamFiles:true}), outputLimit);
 return output.slice(0, output.size, workbookType);
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
 globalThis.onmessage = async ({data}) => {
  try {
   const zipUrl = new URL('../vendor/jszip.min.js', import.meta.url);
   zipUrl.search = new URL(import.meta.url).search;
   await import(zipUrl.href);
   globalThis.postMessage({blob:await cleanWorkbook(data, globalThis.JSZip)});
  } catch (error) {
   globalThis.postMessage({error:error.message || invalid().message});
  }
 };
}

export function reportWorkbook(blob) {
 return new Promise((resolve, reject) => {
  const worker = new Worker(import.meta.url, {type:'module'});
  worker.onmessage = ({data}) => {
   worker.terminate();
   if (data.error) reject(Error(data.error));
   else resolve(data.blob || blob);
  };
  worker.onerror = () => {
   worker.terminate();
   reject(Error('Excel 報表無法安全整理，請重新開啟頁面後再試。'));
  };
  worker.postMessage(blob);
 });
}
