import {MAX_BACKUP_BYTES} from './part-backup.mjs';
import {reportWorkbook} from './part-report-workbook.mjs';
import {reportEntryPeriod} from './report-period.mjs';

const libraryName = 'AutoReport-Part-file-library';
const cacheName = 'AutoReport-Part-analysis-cache';
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const magic = encoder.encode('ARPRPT01');
const headerBytes = magic.length + 8;
const manifestMax = 4096;
const dashboardRowMax = 100000;
const dashboardBytesMax = 20 * 1024 * 1024;
const snapshotKeys = ['date_count', 'input_rows', 'output_rows', 'removed_rows', 'product_count',
  'missing_product_rows', 'pending_product_count', 'skipped_rows', 'timings', 'stageChecks'];
const analysisKeys = ['total', 'good', 'fail', 'badRate', 'yield', 'products', 'defects', 'processes', 'productProcesses',
  'attribution', 'observations', 'orders', 'dailyProcessTotals', 'dailyProductTotals', 'identityConflicts', 'skippedRows',
  'sources', 'referenceSources', 'partCorrections', 'period', 'stageWeekContext'];
const reserved = new Set(['__proto__', 'constructor', 'prototype', '$arpt']);
const taipeiDate = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'});

function validId(id) {
  return typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
}
function validName(name) {
  return typeof name === 'string' && name.length > 5 && name.length <= 255 && name === name.trim() &&
    /\.xlsx$/i.test(name) && !/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name);
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
function dateRange(start, end) {
  return validDate(start) && validDate(end) && start <= end ? {start, end} : null;
}
function entryRange(entry) {
  const known = reportEntryPeriod(entry);
  const range = dateRange(known?.start, known?.end);
  if (range) return range;
  const createdAt = new Date(entry.createdAt);
  const day = Number.isFinite(+createdAt) ? taipeiDate.format(createdAt) : '';
  return dateRange(day, day);
}
function reportEntry(entry) {
  return entry?.kind === 'analysis' && !entry.matchHistory && validId(entry.id) && validName(entry.name) &&
    entry.blob instanceof Blob && entry.blob.size > 0;
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {reject(Error('此瀏覽器無法開啟本機報表資料庫。'));return;}
    const request = indexedDB.open(name, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (name === libraryName) request.result.createObjectStore('files', {keyPath: 'id'});
      else {
        const store = request.result.createObjectStore('results', {keyPath: 'key'});
        store.createIndex('reportId', 'reportId');
        store.createIndex('inputIds', 'inputIds', {multiEntry: true});
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(Error('本機報表資料庫正在更新，請關閉其他分頁後再試。'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {db.close();return;}
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
function transact(db, store, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || Error('本機報表交易未完成。'));
    const set = value => {result = value;};
    const perform = fn => {
      try {fn();} catch (error) {reject(error);tx.abort();}
    };
    perform(() => run(tx.objectStore(store), set, perform));
  });
}
function getRecord(db, storeName, key) {
  return transact(db, storeName, 'readonly', (store, set) => {
    const request = store.get(key);
    request.onsuccess = () => set(request.result);
  });
}

export async function listLocalReports() {
  const db = await openDatabase(libraryName);
  try {
    return await transact(db, 'files', 'readonly', (store, set, perform) => {
      const reports = [], request = store.openCursor();
      request.onsuccess = () => perform(() => {
        const cursor = request.result;
        if (!cursor) {
          set(reports.sort((a, b) => b.end.localeCompare(a.end) || a.name.localeCompare(b.name, 'zh-TW') || a.id.localeCompare(b.id)));
          return;
        }
        const entry = cursor.value;
        if (reportEntry(entry)) {
          const range = entryRange(entry);
          if (range) reports.push({id: entry.id, name: entry.name, ...range, size: entry.blob.size});
        }
        cursor.continue();
      });
    });
  } finally {db.close();}
}

async function requireWorkbook(blob) {
  const invalid = () => Error('報表不是有效的 XLSX 檔案。');
  if (!(blob instanceof Blob) || blob.size < 22 || blob.size > MAX_BACKUP_BYTES) throw invalid();
  const first = new DataView(await blob.slice(0, 4).arrayBuffer());
  if (first.getUint32(0, true) !== 0x04034b50) throw invalid();
  const tailStart = Math.max(0, blob.size - 65557);
  const tail = new DataView(await blob.slice(tailStart).arrayBuffer());
  let end = tail.byteLength - 22;
  for (; end >= 0; end--) {
    if (tail.getUint32(end, true) === 0x06054b50 && end + 22 + tail.getUint16(end + 20, true) === tail.byteLength) break;
  }
  if (end < 0 || tail.getUint32(end + 4, true) !== 0) throw invalid();
  const entries = tail.getUint16(end + 10, true), length = tail.getUint32(end + 12, true), start = tail.getUint32(end + 16, true);
  if (entries !== tail.getUint16(end + 8, true) || entries < 2 || length > 1024 * 1024 || start + length !== tailStart + end) throw invalid();
  const data = await blob.slice(start, start + length).arrayBuffer();
  const directory = new DataView(data);
  const workbookFiles = new Set(['[Content_Types].xml', 'xl/workbook.xml']);
  let offset = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > length || directory.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const nameLength = directory.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + directory.getUint16(offset + 30, true) + directory.getUint16(offset + 32, true);
    if (next > length || directory.getUint32(offset + 42, true) >= start) throw invalid();
    if (nameLength <= 19) {
      const name = String.fromCharCode(...new Uint8Array(data, offset + 46, nameLength));
      workbookFiles.delete(name);
    }
    offset = next;
  }
  if (offset !== length || workbookFiles.size) throw invalid();
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
function validDashboard(data, manifest) {
  if (!data || data.filename !== manifest.name || data.start_date !== manifest.start || data.end_date !== manifest.end ||
      typeof data.includes_detail !== 'boolean' || !Array.isArray(data.stageChecks)) return false;
  const a = data.analysis;
  if (!a || !Array.isArray(a.products) || !Array.isArray(a.observations) || !Array.isArray(a.attribution) ||
      a.observations.length > dashboardRowMax || a.attribution.length > dashboardRowMax) return false;
  if ((a.dailyProcessTotals != null && !(a.dailyProcessTotals instanceof Map)) ||
      (a.dailyProductTotals != null && !(a.dailyProductTotals instanceof Map))) return false;
  const validRow = row => row && typeof row.serial === 'string' && typeof row.product === 'string' &&
    typeof row.process === 'string' && validDate(row.date);
  return a.products.every(product => product && typeof product.id === 'string' && typeof product.ic === 'string' && typeof product.model === 'string') &&
    a.observations.every(validRow) && a.attribution.every(validRow);
}
function makeDashboard(source, manifest) {
  if (!source?.analysis) return null;
  const {name, start, end} = manifest;
  const dashboard = {...pick(source, snapshotKeys), filename: name, start_date: start, end_date: end,
    includes_detail: source.includes_detail === true,
    analysis: {...pick(source.analysis, analysisKeys), start_date: start, end_date: end}};
  dashboard.stageChecks ??= [];
  return dashboard;
}

function fitsDashboard(value) {
  let bytes = dashboardBytesMax, nodes = 1200000;
  function visit(item, depth = 0) {
    if (--nodes < 0 || depth > 40 || bytes < 0) return false;
    const visitChild = child => visit(child, depth + 1);
    if (typeof item === 'string') bytes -= item.length * 3 + 4;
    else if (item == null || ['number', 'boolean'].includes(typeof item)) bytes -= 26;
    else if (Array.isArray(item)) {
      bytes -= item.length + 2;
      return bytes >= 0 && item.length <= nodes && item.every(visitChild);
    } else if (item instanceof Date) {
      bytes -= 48;
      return bytes >= 0 && Number.isFinite(+item);
    } else if (item instanceof Map || item instanceof Set) {
      bytes -= item.size * 4 + 24;
      if (bytes < 0 || item.size > nodes) return false;
      for (const value of item) if (!visitChild(value)) return false;
    } else if (Object.getPrototypeOf(item) === Object.prototype) {
      bytes -= 2;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (reserved.has(key) || !visitChild(key) || !visitChild(item[key])) return false;
      }
    } else return false;
    return bytes >= 0;
  }
  return visit(value);
}
function encodeValue(key, value) {
  if (value instanceof Map) return {$arpt: 'map', value: [...value]};
  if (value instanceof Set) return {$arpt: 'set', value: [...value]};
  if (this[key] instanceof Date) return {$arpt: 'date', value};
  return value;
}
function decodeValue(key, item) {
  if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('看板包含無效的物件欄位。');
  if (item == null || typeof item !== 'object' || !Object.hasOwn(item, '$arpt')) return item;
  if (Object.keys(item).length === 2) {
    if (item.$arpt === 'map' && Array.isArray(item.value) && item.value.every(pair => Array.isArray(pair) && pair.length === 2)) return new Map(item.value);
    if (item.$arpt === 'set' && Array.isArray(item.value)) return new Set(item.value);
    if (item.$arpt === 'date' && typeof item.value === 'string' && Number.isFinite(Date.parse(item.value))) return new Date(item.value);
  }
  throw Error('看板包含不支援的資料格式。');
}
async function compressDashboard(data, manifest) {
  if (typeof CompressionStream !== 'function' || !validDashboard(data, manifest) || !fitsDashboard(data)) return null;
  const json = new Blob([JSON.stringify(data, encodeValue)]);
  if (json.size > dashboardBytesMax) return null;
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
async function decompressDashboard(blob, manifest) {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const segments = [];
  let bytes = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > dashboardBytesMax) throw Error('解壓縮後的看板超過容量上限。');
      segments.push(value);
    }
  } finally {await reader.cancel().catch(() => {});}
  const data = JSON.parse(decoder.decode(await new Blob(segments).arrayBuffer()), decodeValue);
  if (!validDashboard(data, manifest) || !fitsDashboard(data)) throw Error('報表看板資料格式不正確。');
  return data;
}

export async function packLocalReport(id) {
  if (!validId(id)) throw Error('報表識別碼無效。');
  const library = await openDatabase(libraryName);
  let entry;
  try {entry = await getRecord(library, 'files', id);}
  finally {library.close();}
  if (!reportEntry(entry)) throw Error('找不到可上傳的本機分析報表。');
  const workbook = await reportWorkbook(entry.blob);
  if (workbook.size + headerBytes >= MAX_BACKUP_BYTES) throw Error('Excel 報表超過 50 MiB 容量上限。');
  await requireWorkbook(workbook);

  let data;
  if (!entry.cloudWorkbookOnly && !(entry.rows > dashboardRowMax)) {
    const cache = await openDatabase(cacheName);
    try {data = (await getRecord(cache, 'results', 'report:' + id))?.data;}
    finally {cache.close();}
  }
  const range = dateRange(data?.start_date, data?.end_date) ||
    dateRange(data?.analysis?.start_date, data?.analysis?.end_date) || entryRange(entry);
  if (!range) throw Error('報表日期無效。');
  const manifest = {id, name: entry.name, ...range};
  const meta = encoder.encode(JSON.stringify(manifest));
  if (meta.length > manifestMax || headerBytes + meta.length + workbook.size > MAX_BACKUP_BYTES) throw Error('報表超過 50 MiB 容量上限。');
  const dashboard = makeDashboard(data, manifest);
  let packedDashboard = await compressDashboard(dashboard, manifest);
  if (headerBytes + meta.length + (packedDashboard?.size || 0) + workbook.size > MAX_BACKUP_BYTES) packedDashboard = null;
  const header = new Uint8Array(headerBytes);
  header.set(magic);
  const view = new DataView(header.buffer);
  view.setUint32(magic.length, meta.length);
  view.setUint32(magic.length + 4, packedDashboard?.size || 0);
  const payload = new Blob([header, meta, ...(packedDashboard ? [packedDashboard] : []), workbook], {type: 'application/octet-stream'});
  return {payload, ...range, hasDashboard: !!packedDashboard};
}

export async function unpackReport(payload, id, metadata, {workbookOnly = false} = {}) {
  if (!validId(id) || !dateRange(metadata?.start, metadata?.end)) throw Error('雲端報表識別碼或日期無效。');
  if (!(payload instanceof Blob) || payload.size < headerBytes || payload.size > MAX_BACKUP_BYTES) throw Error('雲端報表大小無效。');
  const header = new DataView(await payload.slice(0, headerBytes).arrayBuffer());
  if (!magic.every((byte, index) => header.getUint8(index) === byte)) throw Error('雲端報表版本不支援。');
  const metaLength = header.getUint32(magic.length), packedLength = header.getUint32(magic.length + 4);
  const packedStart = headerBytes + metaLength, workbookStart = packedStart + packedLength;
  if (metaLength < 1 || metaLength > manifestMax || workbookStart >= payload.size || packedLength > dashboardBytesMax) {
    throw Error('雲端報表結構錯誤。');
  }
  const manifest = JSON.parse(decoder.decode(await payload.slice(headerBytes, packedStart).arrayBuffer()));
  if (!manifest || manifest.id !== id || !validName(manifest.name) || manifest.start !== metadata.start || manifest.end !== metadata.end) {
    throw Error('雲端報表內容與索引資料不符。');
  }
  const {name, start, end} = manifest;
  const blob = payload.slice(workbookStart, payload.size, workbookType);
  await requireWorkbook(blob);
  const data = packedLength && !workbookOnly ? await decompressDashboard(payload.slice(packedStart, workbookStart), manifest) : undefined;
  return {id, name, start, end, blob, data};
}

function replaceCache(db, key, record) {
  return transact(db, 'results', 'readwrite', (store, set, perform) => {
    const request = store.get(key);
    request.onsuccess = () => perform(() => {set(request.result);store.put(record);});
  });
}
function recoverCache(db, key, marker, previous) {
  return transact(db, 'results', 'readwrite', (store, set, perform) => {
    const request = store.get(key);
    request.onsuccess = () => perform(() => {
      if (request.result?.cloudWriteId !== marker) return;
      if (previous) store.put(previous);
      else store.delete(key);
    });
  });
}
function putCloudEntry(db, entry) {
  return transact(db, 'files', 'readwrite', (store, set, perform) => {
    const request = store.get(entry.id);
    request.onsuccess = () => perform(() => {
      if (!canRestore(request.result)) {set(false);return;}
      store.put({...entry, createdAt: request.result?.createdAt || entry.createdAt});
      set(true);
    });
  });
}

function canRestore(entry) {
  return !entry || entry.kind === 'analysis' && !entry.matchHistory && entry.cloudReport === true;
}

export async function saveLocalReport(report) {
  if (!report || !validId(report.id) || !validName(report.name) || !dateRange(report.start, report.end) ||
      (report.data != null && (!validDashboard(report.data, report) || !fitsDashboard(report.data)))) {
    throw Error('還原的報表資料無效。');
  }
  await requireWorkbook(report.blob);
  const {id, name, start, end, blob, data} = report;
  const work = async () => {
    const library = await openDatabase(libraryName);
    let cache;
    try {
      const existing = await getRecord(library, 'files', id);
      if (!canRestore(existing)) return false;
      cache = await openDatabase(cacheName);
      const key = 'report:' + id, cloudWriteId = crypto.randomUUID();
      const record = {key, reportId: id, cloudWriteId};
      if (data) Object.assign(record, {data, downloadBlob: blob, reportSchema: 1, periodSchema: data.includes_detail ? undefined : 1});
      const previous = await replaceCache(cache, key, record);
      const now = new Date();
      let saved;
      try {
        saved = await putCloudEntry(library, {id, name, blob, size: blob.size, lastModified: +now, createdAt: now.toISOString(),
          kind: 'analysis', collection: 'analysis', cloudReport: true, cloudWorkbookOnly: !data,
          analysisPeriod: {start, end}, detail: false, rows: data?.output_rows ?? null,
          sources: data?.analysis?.sources || [], persistent: true});
      } catch (error) {
        await recoverCache(cache, key, cloudWriteId, previous);
        throw error;
      }
      if (!saved) await recoverCache(cache, key, cloudWriteId, previous);
      // A leftover workbook-only marker is ignored by the analysis cache.
      else if (!data) await recoverCache(cache, key, cloudWriteId).catch(() => {});
      return saved;
    } finally {cache?.close();library.close();}
  };
  return globalThis.navigator?.locks ? navigator.locks.request('AutoReport-Part-cloud-report:' + id, work) : work();
}
