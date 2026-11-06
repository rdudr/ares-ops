// Energy Ledger: reads an Excel file away from the page, so a big file can never freeze the screen.
// Only the top of each sheet is read: Excel often saves formatting a long way down or across a sheet,
// and a bills sheet is a few dozen rows.
importScripts('/vendor/xlsx.full.min.js');

const MAX_ROWS = 400, MAX_COLS = 60;

self.onmessage = e => {
  try {
    const wb = XLSX.read(e.data, { type: 'array', sheetRows: MAX_ROWS });
    const sheets = wb.SheetNames.map(name => {
      const ws = wb.Sheets[name];
      if (ws['!ref']) {
        const r = XLSX.utils.decode_range(ws['!ref']);
        r.e.c = Math.min(r.e.c, MAX_COLS - 1);
        ws['!ref'] = XLSX.utils.encode_range(r);
      }
      return { name, rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) };
    });
    self.postMessage({ sheets });
  } catch (ex) {
    self.postMessage({ error: String(ex.message || ex) });
  }
};
