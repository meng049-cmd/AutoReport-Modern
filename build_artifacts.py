"""Build a consolidated part-number mapping, audit sheets, and portable tool bundle."""
import json
from collections import Counter, defaultdict
from time import perf_counter
from zipfile import ZIP_DEFLATED, ZipFile
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
import autoreport as a

SUMMARY_FILE = '指定五分頁_料號IC機種整理.xlsx'
SAMPLE_PARTS = ('98000320-107', '98000429-101', '95000510-101', '找不到的料號')


def style(sheet):
    sheet.freeze_panes = 'A2'
    sheet.auto_filter.ref = sheet.dimensions
    for cell in sheet[1]:
        cell.fill = PatternFill('solid', fgColor='157E76')
        cell.font = Font(color='FFFFFF', bold=True)
    for row in sheet:
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = 's'
    for column in sheet.columns:
        sheet.column_dimensions[column[0].column_letter].width = min(
            60, max(14, max(len(str(c.value or '')) for c in column[:100]) + 2))


def main():
    out = a.ROOT / 'exports'
    out.mkdir(exist_ok=True)
    with a.connect() as db:
        summary = a.stats(db)
        rows = list(db.execute(a.RECORD_SQL + ' ORDER BY r.id'))
        records = {r['id']: r for r in rows}
        parts = defaultdict(list)
        for row in db.execute("SELECT value,record_id FROM lookup_keys WHERE kind='part' ORDER BY value,record_id"):
            parts[row['value']].append(records[row['record_id']])
        labels = {
            key: next((part for part in json.loads(source[0]['parts_json']) if a.norm(part) == key), key)
            for key, source in parts.items()
        }
        started = perf_counter()
        checked = {key: a.lookup(db, [('part', label)]) for key, label in labels.items()}
        seconds = perf_counter() - started
        outcomes = Counter(r['狀態'] for r in checked.values())
        book = Workbook()
        sheet = book.active
        sheet.title = '料號IC機種對照'
        sheet.append(['料號', 'IC', '機種', '比對狀態', '來源工單', 'DPN', '來源分頁與列號',
                      '原始IC／機型', '整理依據', '候選機種與IC'])
        for key, found in checked.items():
            source_records = parts[key]
            unique = found['候選'][0] if found['狀態'] == '唯一匹配' else {}
            orders = sorted({order for r in source_records for order in json.loads(r['orders_json'])})
            dpns = sorted({p for r in source_records for p in json.loads(r['dpns_json'])})
            provenance = [f"{r['sheet']} 第 {r['row_number']} 列" for r in source_records]
            originals = sorted({r['raw_ic'] for r in source_records if r['raw_ic']})
            notes = [json.loads(r['resolution_json']) for r in source_records if r['resolution_json'] != '[]']
            sheet.append([labels[key], unique.get('IC', ''), unique.get('機種', ''), found['狀態'],
                          '、'.join(orders), '、'.join(dpns), '；'.join(provenance), '、'.join(originals),
                          json.dumps(notes, ensure_ascii=False),
                          '；'.join((c['機種'] or '機種未填') + ' / ' + (c['IC'] or 'IC 未填') for c in found['候選'])])
        style(sheet)
        sheet = book.create_sheet('分頁摘要')
        sheet.append(['選取順序', '指定來源分頁', '表頭列', '非空來源列', '索引資料列', '不重複料號數'])
        for s in summary['分頁']:
            count = db.execute("SELECT COUNT(DISTINCT k.value) FROM lookup_keys k "
                               "JOIN records r ON r.id=k.record_id WHERE k.kind='part' AND r.sheet_id=?",
                               (s['id'],)).fetchone()[0]
            sheet.append([s['position'], s['name'], s['header_row'], s['raw_rows'], s['indexed_rows'], count])
        style(sheet)
        sheet = book.create_sheet('原始資料索引')
        sheet.append(['來源分頁', '來源列號', 'IC', '機種', '原始IC／機型', '代別', '料號', 'DPN', '工單號', '整理依據'])
        for r in rows:
            sheet.append([r['sheet'], r['row_number'], r['ic'], r['model'], r['raw_ic'], r['family'],
                          '、'.join(json.loads(r['parts_json'])), '、'.join(json.loads(r['dpns_json'])),
                          '、'.join(json.loads(r['orders_json'])), r['resolution_json']])
        style(sheet)
        sheet = book.create_sheet('待確認料號')
        sheet.append(['料號', '狀態', '候選機種與IC', '來源'])
        for key, found in checked.items():
            if found['狀態'] != '唯一匹配':
                sheet.append([labels[key], found['狀態'],
                              json.dumps(found['候選'], ensure_ascii=False),
                              json.dumps(found['查找依據'], ensure_ascii=False)])
        style(sheet)
        for s in summary['分頁']:
            sheet = book.create_sheet(s['name'][:31])
            for row in db.execute('SELECT row_number,cells_json FROM raw_rows WHERE sheet_id=? ORDER BY row_number', (s['id'],)):
                for col, value in enumerate(json.loads(row['cells_json']), 1):
                    if value:
                        cell = sheet.cell(row['row_number'], col, value)
                        cell.data_type = 's'
            sheet.freeze_panes = f"A{(s['header_row'] or 1) + 1}"
        book.save(out / SUMMARY_FILE)
        template = Workbook()
        sheet = template.active
        sheet.title = '待查詢資料'
        sheet.append(['料號'])
        for part in SAMPLE_PARTS:
            sheet.append([part])
        style(sheet)
        template.save(out / '上傳查詢範例.xlsx')
        result = a.match_upload(db, (out / '上傳查詢範例.xlsx').read_bytes(), '上傳查詢範例.xlsx')
        (out / '範例_比對結果.xlsx').write_bytes(a.export_matches(result))
        corrections = sum('IC依據資料列ID' in r['resolution_json'] for r in rows)
        complete = sum(a.available(r['model']) and a.available(r['ic']) for r in rows)
        report = '# 指定五分頁料號資料庫\n\n'
        report += '來源依分頁名稱選取。\n\n'
        report += '| 選取順序 | 來源分頁 | 非空來源列 | 索引資料列 |\n|---|---|---:|---:|\n'
        report += ''.join(f"| {s['position']} | {s['name']} | {s['raw_rows']} | {s['indexed_rows']} |\n" for s in summary['分頁'])
        report += f'''
目前共有 {len(rows)} 列來源索引（{complete} 列有完整機種與 IC）與 {len(parts)} 個不重複料號。
全部料號查核結果為 {dict(outcomes)}。{corrections} 列重工／缺漏 IC 由相同主料號的一致參考確認補正。
索引比對耗時 {seconds:.3f} 秒。

## 整理規則

- 依完整料號比對，保留版本尾碼。每個料號儲存格採用第一筆非空內容。
- 依來源保留機種名稱與原始儲存格。工單列於來源資料供核對。
- 重工頁 DPN 欄若有完整產品料號，納入料號索引。
- 參考主料號時優先採用 98 成品料號，其次 95 料號。
- 只有唯一且完整的 IC／機種組合會自動填入。多組候選和缺漏列入「待確認料號」。

## 使用與限制

查詢檔使用 XLSX 或 CSV 格式，並提供料號欄位。整理 Excel 首頁逐一列出各料號的對照結果，後面保留來源資料供核對。
啟動方式見 README。
'''
        (out / '分析說明.md').write_text(report, encoding='utf-8')
        print(json.dumps({'rows': len(rows), 'parts': len(parts), 'all_part_outcomes': dict(outcomes),
                          'sample_outcomes': dict(Counter(r['狀態'] for r in result['結果'])),
                          'IC_corrections': corrections, 'lookup_seconds': round(seconds, 3)}, ensure_ascii=False, indent=2))
    # Explicit inclusion prevents obsolete workbooks from entering the corrected bundle.
    with ZipFile(out / 'AutoReport_資料庫與查詢工具.zip', 'w', ZIP_DEFLATED) as bundle:
        for name in ['autoreport.py', 'server.py', 'index.html', 'requirements.txt', 'README.md',
                     'test_autoreport.py', 'build_artifacts.py']:
            bundle.write(a.ROOT / name, 'AutoReport/' + name)
        bundle.write(a.DEFAULT_DB, 'AutoReport/data/autoreport.sqlite3')
        for name in [SUMMARY_FILE, '上傳查詢範例.xlsx', '範例_比對結果.xlsx', '分析說明.md']:
            bundle.write(out / name, 'AutoReport/exports/' + name)


if __name__ == '__main__':
    main()
