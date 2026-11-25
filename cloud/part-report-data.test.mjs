import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from '@playwright/test';
import ExcelJS from 'exceljs';
import XLSX from '../vendor/xlsx.full.min.js';

const modules = new Map(['part-report-data.mjs', 'part-backup.mjs', 'part-report-workbook.mjs', 'report-period.mjs']
  .map(name => ['/' + name, new URL(name, import.meta.url)]));
modules.set('/vendor/jszip.min.js', new URL('../node_modules/jszip/dist/jszip.min.js', import.meta.url));

test('portable report data in independent browser databases', {timeout: 60000}, async t => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Report data test</title>');
      return;
    }
    const module = modules.get(path);
    if (!module) {response.writeHead(404).end();return;}
    try {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(module));
    } catch {response.writeHead(500).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox']});
    const site = 'http://127.0.0.1:' + server.address().port;
    const generated = new ExcelJS.Workbook();
    generated.addWorksheet('產出摘要').addRow(['製程', '良率']);
    const bytes = Array.from(new Uint8Array(await generated.xlsx.writeBuffer()));

    await t.test('uses analysis dates, preserves XLSX and maps, and restores additively', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(site);
        const results = await page.evaluate(async bytes => {
          const {listLocalReports, packLocalReport, unpackReport, saveLocalReport} = await import('/part-report-data.mjs');
          await listLocalReports();
          const blob = new Blob([Uint8Array.from(bytes)]);
          const id = 'f044eeec-e378-4852-9531-ab323d9df903', rawId = 'e044eeec-e378-4852-9531-ab323d9df903';
          const name = '料號月度分析.xlsx';
          const library = await new Promise(resolve => {
            const request = indexedDB.open('AutoReport-Part-file-library', 1);request.onsuccess = () => resolve(request.result);
          });
          const cache = await new Promise(resolve => {
            const request = indexedDB.open('AutoReport-Part-analysis-cache', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('results', {keyPath: 'key'});
            request.onsuccess = () => resolve(request.result);
          });
          const operate = (db, store, method, argument) => new Promise((resolve, reject) => {
            const transaction = db.transaction(store, method === 'get' ? 'readonly' : 'readwrite');
            const request = transaction.objectStore(store)[method](argument);
            transaction.oncomplete = () => resolve(request.result);transaction.onabort = () => reject(transaction.error);
          });
          const start = '2026-11-01', end = '2026-11-03';
          const raw = new Blob(['source workbook']);
          const entry = {id, kind: 'analysis', name, blob, createdAt: '2026-11-21T17:00:00Z', analysisInputs: {files: [raw]}};
          await operate(library, 'files', 'put', entry);
          await operate(library, 'files', 'put', {id: rawId, kind: 'raw', name: 'file.xlsx', blob:raw});
          const metadata = await listLocalReports();
          const key = 'report:' + id;
          const observation = {serial: 'P1', product: 'p', process: 'DAF外觀', date: start, fail: false};
          const product = {id: 'p', ic: 'IC', model: 'Model', total: 1};
          const selected = {
            key, reportId: id, data: {start_date: start, end_date: end, filename: name, includes_detail: false, analysis: {
              products: [product], observations: [observation], attribution: [],
              dailyProcessTotals: new Map([['test key', 1]]), sources: [{name: 'sample.xlsx'}]
            }, sourceFile: raw}
          };
          await operate(cache, 'results', 'put', selected);
          const packed = await packLocalReport(id);
          const report = await unpackReport(packed.payload, id, {start, end});
          const workbookOnly = await unpackReport(packed.payload, id, {start, end}, {workbookOnly:true});
          const corruptedDashboard = new Uint8Array(await packed.payload.arrayBuffer());
          const manifestEnd = 16 + new DataView(corruptedDashboard.buffer).getUint32(8);
          corruptedDashboard[manifestEnd] = 0;
          let malformedDashboardRejected = false;
          try {await unpackReport(new Blob([corruptedDashboard]), id, {start, end});}
          catch {malformedDashboardRejected = true;}
          const directDownload = await unpackReport(new Blob([corruptedDashboard]), id, {start, end}, {workbookOnly:true});
          const actual = new Uint8Array(await report.blob.arrayBuffer());
          const workbookMatches = actual.length === bytes.length && actual.every((value, index) => value === bytes[index]);
          const originalProtected = !(await saveLocalReport(report));
          const original = await operate(library, 'files', 'get', id);
          await operate(library, 'files', 'delete', id);
          const restored = await saveLocalReport(report);
          const imported = await operate(library, 'files', 'get', id);
          const importedCache = await operate(cache, 'results', 'get', key);
          const put = IDBObjectStore.prototype.put;
          let quotaRejected = false;
          IDBObjectStore.prototype.put = function(value) {
            if (this.name === 'files' && value.id === id) throw new DOMException('test quota', 'QuotaExceededError');
            return put.call(this, value);
          };
          try {await saveLocalReport(workbookOnly);}
          catch (error) {quotaRejected = error.name === 'QuotaExceededError';}
          finally {IDBObjectStore.prototype.put = put;}
          const cacheAfterFailure = await operate(cache, 'results', 'get', key);
          const replaced = await saveLocalReport(workbookOnly);
          const final = await operate(library, 'files', 'get', id);
          const finalCache = await operate(cache, 'results', 'get', key);
          const unrelated = await operate(library, 'files', 'get', rawId);
          return {
            metadata: metadata.map(({name,start,end})=>[name,start,end]),
            packed: [packed.start, packed.end, packed.hasDashboard],
            workbookMatches, malformedDashboardRejected, directDownloadSize:directDownload.blob.size,
            mapValue: report.data.analysis.dailyProcessTotals.get('test key'),
            rawSourceOmitted: report.data.sourceFile === undefined,
            originalProtected,
            originalInputPreserved: original.analysisInputs.files.length === 1,
            restored, cloudEntry: [imported.cloudReport, imported.cloudWorkbookOnly, imported.analysisPeriod],
            cacheSchema: importedCache.reportSchema, quotaRejected,
            cacheCompensated: cacheAfterFailure.data.analysis.dailyProcessTotals.get('test key') === 1,
            replaced, cloudWorkbookOnly: final.cloudWorkbookOnly, cacheRemoved: !finalCache,
            unrelatedFilePreserved: unrelated.kind === 'raw'
          };
        }, bytes);
        assert.deepEqual(results, {
          metadata: [['料號月度分析.xlsx', '2026-11-22', '2026-11-22']],
          packed: ['2026-11-01', '2026-11-03', true],
          workbookMatches: true, malformedDashboardRejected: true, directDownloadSize: bytes.length,
          mapValue: 1, rawSourceOmitted: true, originalProtected: true,
          originalInputPreserved: true, restored: true,
          cloudEntry: [true, false, {start: '2026-11-01', end: '2026-11-03'}],
          cacheSchema: 1, quotaRejected: true, cacheCompensated: true,
          replaced: true, cloudWorkbookOnly: true, cacheRemoved: true, unrelatedFilePreserved: true
        });
      } finally {await page.close();}
    });

    await t.test('uses workbook-only mode for large calculations and rejects corrupt or mismatched payloads', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(site);
        const results = await page.evaluate(async bytes => {
          const {listLocalReports, packLocalReport, unpackReport} = await import('/part-report-data.mjs');
          await listLocalReports();
          const start = '2026-11-01', end = '2026-11-03';
          const id = 'f044eeec-e378-4852-9531-ab323d9df903', mismatchedId = '1044eeec-e378-4852-9531-ab323d9df903';
          const blob = new Blob([Uint8Array.from(bytes)]);
          const library = await new Promise(resolve => {
            const request = indexedDB.open('AutoReport-Part-file-library', 1);request.onsuccess = () => resolve(request.result);
          });
          async function put(entry) {
            await new Promise((resolve, reject) => {
              const tx = library.transaction('files', 'readwrite');tx.objectStore('files').put(entry);
              tx.oncomplete = resolve;tx.onabort = () => reject(tx.error);
            });
          }
          const base = {id, kind: 'analysis', name: '分析.xlsx', blob, createdAt: '2026-11-05T00:00:00Z', rows: 100001,
            analysisPeriod: {start, end}};
          await put(base);
          const packed = await packLocalReport(id);
          const unpacked = await unpackReport(packed.payload, id, {start, end});
          async function rejects(operation) {
            try {await operation();return false;} catch {return true;}
          }
          const invalidDate = await rejects(() => unpackReport(packed.payload, id, {start:'2026-11-31', end}));
          const mismatchedDate = await rejects(() => unpackReport(packed.payload, id, {start:'2026-11-02', end}));
          const wrongId = await rejects(() => unpackReport(packed.payload, mismatchedId, {start, end}));
          const malformed = await rejects(() => unpackReport(packed.payload.slice(1), id, {start, end}));
          const truncated = await rejects(() => unpackReport(packed.payload.slice(0, packed.payload.size - 3), id, {start, end}));
          const invalidBaseName = await (async () => {
            await put({...base, name: '../分析.xlsx'});
            return rejects(() => packLocalReport(id));
          })();
          await put({...base, blob: new Blob(['PK\u0003\u0004not a zip directory'])});
          const fakeExcel = await rejects(() => packLocalReport(id));
          return {hasDashboard: packed.hasDashboard, unpackedDashboard: Boolean(unpacked.data), size:unpacked.blob.size,
            invalidDate, mismatchedDate, wrongId, malformed, truncated, invalidBaseName, fakeExcel};
        }, bytes);
        assert.deepEqual(results, {hasDashboard: false, unpackedDashboard: false, size: bytes.length,
          invalidDate: true, mismatchedDate: true, wrongId: true, malformed: true, truncated: true, invalidBaseName: true, fakeExcel: true});
      } finally {await page.close();}
    });

    await t.test('portable workbooks omit hidden raw detail sheets', async () => {
      const rawWorkbook = XLSX.utils.book_new();
      for (const [name, cells] of [['產出摘要', ['製程', '良率']], ['Detail', ['raw-original-data']], ['待補產品資料', ['raw-unmapped-data']]]) {
        XLSX.utils.book_append_sheet(rawWorkbook, XLSX.utils.aoa_to_sheet([cells]), name);
      }
      rawWorkbook.Workbook = {Sheets: rawWorkbook.SheetNames.map(name => ({name, Hidden: name === 'Detail' ? 2 : 0}))};
      const original = Array.from(new Uint8Array(XLSX.write(rawWorkbook, {bookType:'xlsx', type:'array', compression:true})));
      const page = await browser.newPage();
      try {
        await page.goto(site);
        const restored = await page.evaluate(async original => {
          const {listLocalReports, packLocalReport, unpackReport} = await import('/part-report-data.mjs');
          await listLocalReports();
          const id = '9044eeec-e378-4852-9531-ab323d9df903';
          const start = '2026-11-01', end = '2026-11-03';
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('AutoReport-Part-file-library', 1);
            request.onsuccess = () => {
              const db = request.result, tx = db.transaction('files', 'readwrite');
              tx.objectStore('files').put({id, kind:'analysis', name:'報表.xlsx', blob:new Blob([Uint8Array.from(original)]), analysisPeriod:{start,end}});
              tx.oncomplete = () => {db.close();resolve();};tx.onabort = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          });
          const {payload} = await packLocalReport(id);
          const {blob} = await unpackReport(payload, id, {start, end});
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        }, original);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Uint8Array.from(restored));
        assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['產出摘要']);
        assert.equal(workbook.worksheets[0].getCell('B1').value, '良率');
      } finally {await page.close();}
    });
  } finally {await browser?.close();await new Promise(resolve => server.close(resolve));}
});
