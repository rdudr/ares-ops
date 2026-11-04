// Energy Ledger: reads electricity bills in the browser. Text PDFs are read directly; photographs and
// scanned PDFs go through OCR. The label matching below is Report Studio's, kept word for
// word so both read a bill the same way; only the loading differs: pdf.js and tesseract.js are served
// by the Console itself (public/vendor/ocr), so bills never leave the Console for a CDN and it works
// under the Console's security policy. OCR is an assistant: every figure is checked by a person.
const num = v => { const n = v === null || v === undefined || v === '' ? NaN : parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const loadImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That picture could not be opened.')); i.src = url; });
const fileToDataUrl = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('That file could not be read.')); r.readAsDataURL(file); });

var BILL_FIELDS = [
  /* The nine yellow cells of the workbook - what the report actually needs. */
  { k:'month',        t:'Billing month',     type:'text', yellow:true },
  { k:'kwh',          t:'Total units consumed', unit:'kWh', yellow:true },
  { k:'net',          t:'Total bill amount', unit:'₹', yellow:true },
  { k:'pf',           t:'Power factor',      unit:'', yellow:true },
  { k:'actualMD',     t:'Actual maximum demand', unit:'kVA', yellow:true },
  { k:'energyRate',   t:'Energy charge rate', unit:'₹/kWh', yellow:true, derived:'energy charge ÷ units' },
  { k:'fppaRate',     t:'FPPA rate',         unit:'₹/kWh', yellow:true, derived:'fuel surcharge ÷ units' },
  { k:'todNight',     t:'Night units',       unit:'kWh', yellow:true },
  { k:'todPeak',      t:'TOU units',         unit:'kWh', yellow:true },
  { k:'touDiscount',  t:'TOU / ToD discount', unit:'\u20b9', yellow:true },
  /* Also read, for the tariff header and for cross-checking the computed columns. */
  { k:'contract',     t:'Contract demand',   unit:'kVA' },
  { k:'billingDemand',t:'Billing demand (as billed)', unit:'kVA' },
  { k:'kvah',         t:'Apparent energy',   unit:'kVAh' },
  { k:'energyCharge', t:'Energy charge (as billed)', unit:'₹' },
  { k:'demandCharge', t:'Demand charge (as billed)', unit:'₹' },
  { k:'fuelSurcharge',t:'Fuel surcharge (as billed)', unit:'₹' },
  { k:'duty',         t:'Electricity duty (as billed)', unit:'₹' },
  { k:'rebate',       t:'Rebate / discount', unit:'₹' },
  { k:'other',        t:'Other charges',     unit:'₹' }
];

/* The two rates are rarely printed as such; a bill prints the charge. When
   the charge and the units were both found, the rate follows, and is marked
   as derived so the checker knows it was not read off the page. */
function addDerivedRateHits(hits){
  if (!hits) return hits;
  var kwh = hits.kwh && num(hits.kwh.value);
  if (kwh){
    if (!hits.energyRate && hits.energyCharge && num(hits.energyCharge.value) !== null)
      hits.energyRate = { value:+(num(hits.energyCharge.value) / kwh).toFixed(2), via:'derived', line:'energy charge ' + hits.energyCharge.value + ' ÷ ' + kwh + ' kWh', note:'Derived, not printed' };
    if (!hits.fppaRate && hits.fuelSurcharge && num(hits.fuelSurcharge.value) !== null)
      hits.fppaRate = { value:+(num(hits.fuelSurcharge.value) / kwh).toFixed(2), via:'derived', line:'fuel surcharge ' + hits.fuelSurcharge.value + ' ÷ ' + kwh + ' kWh', note:'Derived, not printed' };
  }
  return hits;
}

/* Label aliases, longest and most specific first: "billing demand" must be
   tried before "demand", or every bill reports its contract demand as its
   billing demand. Drawn from DGVCL, UGVCL, MGVCL, PGVCL, Torrent and Adani
   layouts, which is most of what a Gujarat plant will hand over. */
var BILL_PATTERNS = [
  ['billingDemand', ['billing demand','billable demand','demand billed','chargeable demand','b\\.?d\\.?']],
  ['contract',      ['contract demand','contracted demand','sanctioned demand','sanctioned load','contract load','c\\.?d\\.?']],
  ['actualMD',      ['maximum demand recorded','recorded maximum demand','actual maximum demand',
                     'maximum demand','max\\.? demand','recorded demand','actual demand','m\\.?d\\.?']],
  ['kvah',          ['total kvah','kvah consumed','kvah consumption','apparent energy','kvah']],
  ['kwh',           ['total units consumed','units consumed','net units','total consumption',
                     'energy consumed','kwh consumed','consumption in kwh','total kwh','units','kwh']],
  ['pf',            ['average power factor','avg\\.? power factor','power factor','p\\.?f\\.?']],
  ['energyCharge',  ['energy charge','energy charges']],
  ['demandCharge',  ['demand charge','demand charges']],
  ['fuelSurcharge', ['fpppa','fppa','fuel price and power purchase','fuel surcharge',
                     'fuel cost adjustment','fuel price adjustment','f\\.?c\\.?a\\.?']],
  ['duty',          ['electricity duty','govt\\.? duty','government duty','duty']],
  /* Without this the charge lines never add up to the net, and the check
     cries wolf on every bill - which is worse than not checking at all,
     because a warning that is always on gets ignored when it is real. */
  ['other',         ['other charges','other charge','miscellaneous charges','misc\\.? charges','other amount']],
  ['rebate',        ['prompt payment rebate','rebate','discount']],
  ['net',           ['net amount payable','amount payable','net payable','total amount payable',
                     'bill amount','net bill amount','grand total','total payable','net amount']],
  ['todNight',      ['tod night','night hours','off peak units','zone c','night units','tod-3','tod 3']],
  ['todPeak',       ['tod peak','peak hours','peak units','zone b','tod-2','tod 2']],
  /* The money the ToD clock gives back. Printed as a rebate, a discount or
     a credit depending on the DISCOM, and always as a negative line in the
     charges - the sign is taken off it, the column is a discount. */
  ['touDiscount',   ['tod rebate','tod discount','tod credit','tou rebate','tou discount',
                     'time of day rebate','time of day discount','tod concession','night rebate']]
];

var MONTH_WORDS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/* Indian digit grouping, currency marks and stray spaces inside numbers all
   have to go before parseFloat sees anything. "1,23,456.78" is one number. */
function billNum(raw){
  if (raw === null || raw === undefined) return null;
  var s = String(raw).replace(/[₹$]/g,'').replace(/,/g,'').replace(/\s+/g,'');
  var m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  var v = parseFloat(m[0]);
  return isFinite(v) ? v : null;
}

/* OCR confuses a small, predictable set of shapes. Inside something that is
   otherwise a number, O is a zero and l is a one - never the other way round,
   which is why this only runs on tokens that are already mostly digits. */
function deOcr(t){
  var s = String(t);
  var digits = (s.match(/\d/g) || []).length;
  if (!digits || digits < s.replace(/[^0-9A-Za-z]/g,'').length * 0.5) return s;
  return s.replace(/[Oo]/g,'0').replace(/[lI|]/g,'1').replace(/[S]/g,'5')
          .replace(/[B]/g,'8').replace(/[Zz]/g,'2').replace(/[·•]/g,'.');
}
function isNumberish(t){
  return /^[₹Rs.\s]*[-+]?[\d,]*\d(?:\.\d+)?\s*(?:kva|kvah|kwh|kw|rs|inr)?\.?$/i.test(String(t).trim());
}

/* ===================================================================
   GEOMETRIC EXTRACTION

   The first version of this joined everything on a line into a string and
   searched the string. That works on a one-column bill and falls apart on
   the real ones, where "Billing Demand" sits in column two and its value in
   column five with three unrelated numbers in between, or where the label is
   a heading above its own column of figures.

   So extraction works on TOKENS WITH POSITIONS instead: find the words that
   spell the label, then take the nearest number to its RIGHT on the same
   line, and only if there is none, the nearest number directly BELOW it.
   Same rule a person uses when they read a bill.
   =================================================================== */

/* Tokens -> lines, by vertical overlap rather than exact y, because OCR
   baselines wobble and PDF text runs are positioned per-glyph-run. */
function groupLines(tokens){
  var ts = tokens.slice().sort(function(p,q){ return (p.y - q.y) || (p.x - q.x); });
  var lines = [], cur = null;
  ts.forEach(function(t){
    if (cur && Math.abs(t.y - cur.y) <= Math.max(4, t.h * 0.6)){
      cur.tokens.push(t);
      cur.y = (cur.y * (cur.tokens.length - 1) + t.y) / cur.tokens.length;
    } else {
      cur = { y:t.y, tokens:[t] };
      lines.push(cur);
    }
  });
  lines.forEach(function(l){ l.tokens.sort(function(p,q){ return p.x - q.x; }); });
  return lines;
}

/* Does this run of tokens, joined, match the alias? Returns the run's extent
   so the value hunt knows where the label ends. */
function matchLabel(line, alias){
  var re = new RegExp('^' + alias + '$', 'i');
  var loose = new RegExp(alias, 'i');
  for (var i = 0; i < line.tokens.length; i++){
    var words = '';
    for (var j = i; j < Math.min(i + 7, line.tokens.length); j++){
      words += (j > i ? ' ' : '') + line.tokens[j].t;
      var clean = words.replace(/[:.–—-]+$/,'').trim();
      if (re.test(clean) || (words.length > 5 && loose.test(clean) && re.test(clean.replace(/\s+/g,' '))))
        return { from:i, to:j, x1:line.tokens[j].x + line.tokens[j].w };
    }
  }
  return null;
}

/* Every label, of every field, that appears on this line - so the hunt for a
   value can be bounded by where the NEXT label starts. Two labels on one row
   is common ("Billing Demand 680 kVA    Demand Charge Rs 2,61,800") and
   without this bound the first label swallows the second one's figure. */
function labelsOnLine(line){
  var found = [];
  BILL_PATTERNS.forEach(function(pat){
    for (var a = 0; a < pat[1].length; a++){
      var m = matchLabel(line, pat[1][a]);
      if (m){ found.push({ field:pat[0], alias:pat[1][a], from:m.from, to:m.to }); break; }
    }
  });
  found.sort(function(p, q){ return p.from - q.from; });
  return found;
}

function extractFromTokens(tokens){
  var hits = {};
  if (!tokens || !tokens.length) return hits;
  var lines = groupLines(tokens);
  var lineLabels = lines.map(labelsOnLine);

  BILL_PATTERNS.forEach(function(pat){
    var field = pat[0];
    for (var a = 0; a < pat[1].length && hits[field] === undefined; a++){
      var alias = pat[1][a];
      for (var li = 0; li < lines.length && hits[field] === undefined; li++){
        var hit = matchLabel(lines[li], alias);
        if (!hit) continue;

        /* The value sits between the end of this label and the start of the
           next one on the same row. */
        var stop = lines[li].tokens.length;
        lineLabels[li].forEach(function(L){ if (L.from > hit.to && L.from < stop) stop = L.from; });

        /* Take the LAST number in that span, not the first.

           A bill is a table. "Energy Charge | 5.15 | 18,91,172.70" puts the
           RATE first and the AMOUNT last, and "Maximum Demand | 1.0 | 612.40"
           puts the meter multiplier before the reading. Taking the first
           number after the label reads the rate as the charge and the
           multiplier as the demand - which is exactly what it did, silently,
           on six of sixteen fields. On a simple two-column bill the first and
           last number are the same token, so this rule is right for both. */
        var val = null, via = 'row';
        for (var k = stop - 1; k > hit.to; k--){
          var tk = lines[li].tokens[k];
          var cleaned = deOcr(tk.t);
          if (!isNumberish(cleaned)) continue;
          val = billNum(cleaned); break;
        }

        /* Nothing on the row: try the column directly beneath the label. */
        if (val === null){
          via = 'below';
          var lx = lines[li].tokens[hit.from].x;
          for (var m = li + 1; m < Math.min(li + 3, lines.length) && val === null; m++){
            for (var n = lines[m].tokens.length - 1; n >= 0; n--){
              var t2 = lines[m].tokens[n];
              if (Math.abs(t2.x - lx) > 90) continue;
              if (!isNumberish(deOcr(t2.t))) continue;
              val = billNum(deOcr(t2.t)); break;
            }
          }
        }
        if (val === null) continue;
        hits[field] = { value:val, via:via,
          line: lines[li].tokens.map(function(t){ return t.t; }).join(' ').slice(0,120) };
      }
    }
  });

  var all = tokens.map(function(t){ return t.t; }).join(' ');
  var mm = all.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-\/']*((?:19|20)?\d{2})\b/i);
  if (mm){
    var nm = mm[1][0].toUpperCase() + mm[1].slice(1,3).toLowerCase();
    hits.month = { value: nm + ' ' + (mm[2].length === 4 ? mm[2].slice(2) : mm[2]),
                   line: mm[0], via:'month name' };
  }
  if (hits.pf && hits.pf.value > 1.2){
    hits.pf.value = hits.pf.value > 10 ? hits.pf.value / 1000 : hits.pf.value / 100;
    hits.pf.note = 'read as a percentage and converted';
  }
  return hits;
}

/* Plain text, when that is all there is: each line becomes one token row so
   the same geometric rules still apply, just with a single coarse column. */
function tokensFromText(text){
  var out = [];
  String(text || '').split(/\r?\n/).forEach(function(line, i){
    var x = 0;
    line.trim().split(/\s+/).forEach(function(w){
      if (!w) return;
      out.push({ t:w, x:x, y:i * 12, w:w.length * 5.2, h:10 });
      x += w.length * 5.2 + 5;
    });
  });
  return out;
}
function extractBill(textOrTokens){
  if (!textOrTokens) return {};
  if (typeof textOrTokens === 'string') return extractFromTokens(tokensFromText(textOrTokens));
  return extractFromTokens(textOrTokens);
}


/* ---- ingestion ---------------------------------------------------- */
/* Twelve months may arrive as one twelve-page PDF, as twelve separate PDFs,
   or as twelve photographs. A DISCOM bill is also often three pages itself -
   the summary, the detail, the terms - and that is the case this used to get
   wrong: every page became a bill of its own, so pages two and three of one
   bill landed on the same month and overwrote the page that carried the
   figures. Pages are therefore grouped into bills first (see groupBillPages)
   and each bill is handed over once, carrying all of its pages. */
function ingestBillPdf(file, onPage){
  return ensurePdfJs().then(function(pdfjs){
    return readFileBuffer(file).then(function(buf){
      return pdfjs.getDocument({ data:new Uint8Array(buf) }).promise;
    });
  }).then(function(doc){
    var chain = Promise.resolve(), got = [];
    for (var p = 1; p <= doc.numPages; p++){
      (function(p){
        chain = chain.then(function(){
          return doc.getPage(p).then(function(page){
            return page.getTextContent().then(function(tc){
              var vp = page.getViewport({ scale:1 });
              /* Keep every run's POSITION, not just its characters. pdf.js
                 hands back reading order with no line breaks; the extractor
                 needs x and y to tell which number belongs to which label on
                 a multi-column bill. PDF y grows upward, so it is flipped. */
              var tokens = [];
              tc.items.forEach(function(it){
                if (!it.str || !it.str.trim()) return;
                var x = it.transform[4], y = vp.height - it.transform[5];
                var h = Math.abs(it.height || it.transform[3]) || 10;
                var parts = it.str.trim().split(/\s+/);
                parts.forEach(function(w, i){
                  var wd = (it.width || w.length * h * 0.5) / parts.length;
                  tokens.push({ t:w, x:x + i * wd, y:y, w:wd, h:h });
                });
              });
              var text = groupLines(tokens).map(function(l){
                return l.tokens.map(function(t){ return t.t; }).join(' '); }).join('\n');
              /* 150 dpi equivalent is enough to read a bill on screen and
                 keeps a twelve-page set inside the storage quota. */
              var scale = Math.min(2.1, 1400 / Math.max(vp.width, vp.height));
              var v2 = page.getViewport({ scale:scale });
              var cv = document.createElement('canvas');
              cv.width = Math.round(v2.width); cv.height = Math.round(v2.height);
              return page.render({ canvasContext:cv.getContext('2d'), viewport:v2 }).promise
                .then(function(){
                  got.push({ no:p, height:vp.height,
                             img:{ dataUrl:cv.toDataURL('image/jpeg', 0.72), w:cv.width, h:cv.height },
                             text:text, tokens:tokens,
                             textLayer: text.replace(/\s/g,'').length > 60 });
                });
            });
          });
        });
      })(p);
    }
    return chain.then(function(){
      groupBillPages(got).forEach(function(bill){
        bill.src = file.name + (got.length > 1 ? ' p' + bill.pages.map(function(x){ return x.no; }).join(',') : '');
        onPage(bill);
      });
    });
  });
}

/* Which pages belong to the same bill.

   Two things say "this page opens a new bill": a billing month different
   from the one the bill in hand carries, or - when no month could be read
   anywhere - a page that repeats the pair of figures that identify a bill
   (units consumed AND amount payable) when the bill in hand already has
   them. Everything else is a continuation sheet, and continuation sheets
   are where the tariff detail usually lives, so they are kept.

   A twelve-page PDF of twelve bills still splits into twelve: each page
   names its own month. A three-page bill stays one bill: its pages two and
   three name the same month, or no month at all. */
function groupBillPages(pages){
  var bills = [], cur = null;
  pages.forEach(function(pg){
    var hits = extractBill(pg.tokens && pg.tokens.length ? pg.tokens : pg.text);
    pg.month = hits.month ? String(hits.month.value) : '';
    pg.strong = !!(hits.kwh && hits.net);
    /* How much of a bill this page carries, so the picture shown for the
       bill is the page an engineer would check the figures against. */
    pg.score = ['kwh','net','pf','actualMD','energyCharge','demandCharge','todNight','todPeak']
                 .reduce(function(n, k){ return n + (hits[k] ? 1 : 0); }, 0);
    var fresh = !cur
      || (pg.month && cur.month && pg.month.toLowerCase() !== cur.month.toLowerCase())
      || (!pg.month && !cur.month && pg.strong && cur.strong);
    if (fresh){ cur = { pages:[], month:pg.month, strong:pg.strong }; bills.push(cur); }
    else if (pg.month && !cur.month) cur.month = pg.month;
    cur.strong = cur.strong || pg.strong;
    cur.pages.push(pg);
  });
  return bills.map(mergeBillPages);
}
/* One bill out of its pages: the text of all of them, the tokens of all of
   them with each page pushed down below the last so a line on page two can
   never be read as the continuation of a line on page one, and the picture
   of whichever page carries most of the figures. */
function mergeBillPages(bill){
  var pages = bill.pages, tokens = [], offset = 0, best = pages[0];
  pages.forEach(function(pg){
    (pg.tokens || []).forEach(function(t){
      tokens.push({ t:t.t, x:t.x, y:t.y + offset, w:t.w, h:t.h });
    });
    offset += (pg.height || 1000) + 40;
    if (pg.score > best.score) best = pg;
  });
  return {
    img: best.img, text: pages.map(function(p){ return p.text; }).join('\n'),
    tokens: tokens, textLayer: pages.some(function(p){ return p.textLayer; }),
    pages: pages.map(function(p){ return { no:p.no, img:p.img }; }),
    mainPage: best.no
  };
}

function preprocess(dataUrl, minEdge){
  return loadImg(dataUrl).then(function(img){
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.max(1, Math.min(3, (minEdge || 1800) / Math.max(w, h)));
    var cv = document.createElement('canvas');
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    var cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    var im = cx.getImageData(0, 0, cv.width, cv.height), d = im.data;
    /* Grey, then stretch what is actually there onto the full range. A scan
       that lives between 90 and 200 becomes one that lives between 0 and 255
       - the difference between a readable 8 and a readable B. */
    var lo = 255, hi = 0, g, i;
    for (i = 0; i < d.length; i += 4){
      g = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114) | 0;
      d[i] = d[i+1] = d[i+2] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    var span = Math.max(1, hi - lo);
    for (i = 0; i < d.length; i += 4){
      g = ((d[i] - lo) * 255 / span) | 0;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      /* gentle S-curve: darken ink, lift paper, leave midtones alone */
      g = g < 110 ? Math.max(0, g - 28) : g > 165 ? Math.min(255, g + 28) : g;
      d[i] = d[i+1] = d[i+2] = g;
    }
    cx.putImageData(im, 0, 0);
    return { dataUrl: cv.toDataURL('image/png'), w:cv.width, h:cv.height, scale:scale };
  });
}

// ---------- loading the readers, from the Console ----------
const BASE = '/vendor/ocr/';
const loaded = {};
const script = name => (loaded[name] ||= new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = BASE + name; s.onload = res;
  s.onerror = () => { delete loaded[name]; rej(new Error('The bill reader could not be loaded.')); };
  document.head.append(s);
}));
function readFileBuffer(file) { return file.arrayBuffer(); }
async function ensurePdfJs() {
  await script('pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
  return { getDocument: o => window.pdfjsLib.getDocument({ ...o, isEvalSupported: false, disableFontFace: true }) };
}

let worker = null;
async function ocrWorker(status) {
  if (worker) return worker;
  await script('tesseract.min.js');
  status('Starting the reader…');
  // Not a blob worker: the Console's security policy allows workers only from its own address.
  worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: BASE + 'worker.min.js', corePath: BASE, langPath: BASE, gzip: true, workerBlobURL: false,
    logger: m => { if (m.status === 'recognizing text') status(`Reading… ${Math.round(m.progress * 100)} %`); },
  });
  return worker;
}
async function ocrImage(dataUrl, status) {
  const p = await preprocess(dataUrl, 2000);
  const w = await ocrWorker(status);
  status('Reading…');
  const { data } = await w.recognize(p.dataUrl);
  if (!data.text && !(data.words && data.words.length)) throw new Error('The reader started but found no text.');
  const k = 1 / (p.scale || 1);
  const tokens = (data.words || []).filter(t => t.text && t.text.trim()).map(t => ({
    t: t.text.trim(), x: t.bbox.x0 * k, y: t.bbox.y0 * k, w: (t.bbox.x1 - t.bbox.x0) * k, h: (t.bbox.y1 - t.bbox.y0) * k, conf: t.confidence }));
  return { text: data.text || '', tokens };
}
/** A picture small enough to keep: the longest side at most 1800 px, as a JPEG. */
async function shrink(dataUrl) {
  const i = await loadImg(dataUrl);
  const s = Math.min(1, 1800 / Math.max(i.naturalWidth, i.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(i.naturalWidth * s); cv.height = Math.round(i.naturalHeight * s);
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
  cx.drawImage(i, 0, 0, cv.width, cv.height);
  return { dataUrl: cv.toDataURL('image/jpeg', 0.82), w: cv.width, h: cv.height };
}

const hitsToBill = (hits, how, name, img) => {
  addDerivedRateHits(hits);
  const fields = {}, sources = {};
  for (const [k, h] of Object.entries(hits)) { fields[k] = h.value; sources[k] = h.via === 'derived' ? 'derived' : how; }
  return { fields, sources, how, name, img };
};

/** Every bill in the files given: PDFs (one or many bills) and photographs. status(text) reports progress. */
export async function readBills(files, status = () => {}) {
  const out = [];
  try {
    for (const file of files) {
      status(`Opening ${file.name}…`);
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const bills = [];
        await ingestBillPdf(file, b => bills.push(b));
        for (const b of bills) {
          if (b.textLayer) { out.push(hitsToBill(extractBill(b.tokens.length ? b.tokens : b.text), 'pdf', b.src, b.img)); continue; }
          const r = await ocrImage(b.img.dataUrl, status); // a scanned PDF: pictures of pages
          out.push(hitsToBill(extractBill(r.tokens.length ? r.tokens : r.text), 'ocr', b.src, b.img));
        }
      } else {
        const img = await shrink(await fileToDataUrl(file));
        const r = await ocrImage(img.dataUrl, status);
        out.push(hitsToBill(extractBill(r.tokens.length ? r.tokens : r.text), 'ocr', file.name, img));
      }
    }
  } finally {
    if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  }
  return out;
}
export { BILL_FIELDS, extractBill };
