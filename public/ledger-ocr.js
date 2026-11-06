// Energy Ledger: reads electricity bills in the browser. Text PDFs are read directly; photographs and
// scanned PDFs go through OCR. The label matching below is Report Studio's (src/p15_bills.js), kept word for
// word so both read a bill the same way (the Ledger adds kVARh and TOU discount units); only the loading differs: pdf.js and tesseract.js are served
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
  { k:'touDiscUnits', t:'TOU discount units', unit:'kWh' },
  { k:'kvarh',        t:'Reactive energy',   unit:'kVARh' },
  /* Also read, for the tariff header and for cross-checking the computed columns. */
  { k:'contract',     t:'Contract demand',   unit:'kVA' },
  { k:'totConsBilled',t:'Total consumption charge', unit:'₹' },
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
  ['kvarh',         ['total kvarh','reactive energy','kvarh']],
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
  ['net',           ['current month\'?s bill','net amount payable','amount payable','net payable','total amount payable',
                     'bill amount','net bill amount','grand total','total payable','net amount']],
  ['todNight',      ['tod night','night hours','off peak units','zone c','night units','tod-3','tod 3']],
  ['touDiscUnits',  ['tou disc unit','tod disc unit','solar hour units','solar units','discount units','concession units']],
  ['todPeak',       ['tod peak','peak hours','peak units','peak period','tou units','tod units','zone b','tod-2','tod 2']],
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
              var layer = text.replace(/\s/g,'').length > 60;
              return page.render({ canvasContext:cv.getContext('2d'), viewport:v2, intent:'print' }).promise
                .then(function(){
                  var item = { no:p, height:vp.height,
                               img:{ dataUrl:cv.toDataURL('image/jpeg', 0.72), w:cv.width, h:cv.height },
                               text:text, tokens:tokens, textLayer:layer };
                  got.push(item);
                  if (layer) return;
                  /* A scan: small print needs about 3,400 px down the page to read. */
                  var v3 = page.getViewport({ scale:3400 / Math.max(vp.width, vp.height) });
                  var big = document.createElement('canvas');
                  big.width = Math.round(v3.width); big.height = Math.round(v3.height);
                  return page.render({ canvasContext:big.getContext('2d'), viewport:v3, intent:'print' }).promise.then(function(){
                    item.sharp = big.toDataURL('image/jpeg', 0.92);
                    big.width = big.height = 0;
                  });
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
    pages: pages.map(function(p){ return { no:p.no, img:p.img, sharp:p.sharp }; }),
    mainPage: best.no
  };
}

/* A photographed bill has a shadow across it, so one black-and-white cut for the whole page loses
   half of it. Each pixel is compared with the average of its own neighbourhood instead (an integral
   image keeps that quick). */
function adaptiveThreshold(im){
  var w = im.width, h = im.height, d = im.data, sum = new Float64Array((w + 1) * (h + 1));
  var x, y, row, W = w + 1;
  for (y = 0; y < h; y++){
    row = 0;
    for (x = 0; x < w; x++){
      row += d[(y * w + x) * 4];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  var r = Math.max(12, Math.round(Math.max(w, h) / 40));
  for (y = 0; y < h; y++){
    var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (x = 0; x < w; x++){
      var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), i = (y * w + x) * 4;
      var mean = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      var v = d[i] < mean * 0.87 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
}
/* Printed grids defeat the reader: it takes a boxed figure for part of the box, so a table bill gives
   its headings and none of its numbers. Long straight dark runs are the grid; they are painted out. */
function removeLines(im){
  var W = im.width, H = im.height, d = im.data, dark = new Uint8Array(W * H), kill = new Uint8Array(W * H), i, r, k, run;
  for (i = 0; i < W * H; i++) dark[i] = d[i * 4] < 150 ? 1 : 0;
  var minH = Math.round(W / 28), minV = Math.round(H / 40), c;
  for (r = 0; r < H; r++){
    run = 0;
    for (c = 0; c <= W; c++){
      if (c < W && dark[r * W + c]) run++;
      else { if (run >= minH) for (k = c - run; k < c; k++) kill[r * W + k] = 1; run = 0; }
    }
  }
  for (c = 0; c < W; c++){
    run = 0;
    for (r = 0; r <= H; r++){
      if (r < H && dark[r * W + c]) run++;
      else { if (run >= minV) for (k = r - run; k < r; k++) kill[k * W + c] = 1; run = 0; }
    }
  }
  for (i = 0; i < W * H; i++) if (kill[i]) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
}
/* Turns the picture a quarter at a time; bills photographed sideways are common. */
function turned(img, quarter){
  var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, swap = quarter % 2 === 1;
  var cv = document.createElement('canvas');
  cv.width = swap ? h : w; cv.height = swap ? w : h;
  var cx = cv.getContext('2d');
  cx.translate(cv.width / 2, cv.height / 2);
  cx.rotate(quarter * Math.PI / 2);
  cx.drawImage(img, -w / 2, -h / 2);
  return cv;
}
function preprocess(dataUrl, minEdge, opts){
  opts = opts || {};
  return loadImg(dataUrl).then(function(img){
    var src = opts.quarter ? turned(img, opts.quarter) : img;
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    var scale = Math.max(1, Math.min(3, (minEdge || 1800) / Math.max(w, h)));
    var cv = document.createElement('canvas');
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    var cx = cv.getContext('2d', { willReadFrequently:true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, cv.width, cv.height);
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
    if (opts.threshold) adaptiveThreshold(im);
    if (opts.lines) removeLines(im);
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
async function ocrOnce(dataUrl, status, opts) {
  const p = await preprocess(dataUrl, opts.edge || 2000, opts);
  const w = await ocrWorker(status);
  status(opts.say || 'Reading…');
  await w.setParameters({ tessedit_pageseg_mode: opts.psm || '3', preserve_interword_spaces: '1' });
  const { data } = await w.recognize(p.dataUrl);
  const k = 1 / (p.scale || 1);
  const tokens = (data.words || []).filter(t => t.text && t.text.trim()).map(t => ({
    t: t.text.trim(), x: t.bbox.x0 * k, y: t.bbox.y0 * k, w: (t.bbox.x1 - t.bbox.x0) * k, h: (t.bbox.y1 - t.bbox.y0) * k, conf: t.confidence }));
  return { text: data.text || '', tokens, width: p.w * k };
}
/* How much of a bill was found. Figures count double: words alone can be a tariff notice or an advert. */
const FIGURES = ['kwh', 'net', 'pf', 'actualMD', 'energyCharge', 'demandCharge', 'contract', 'billingDemand', 'todPeak', 'fuelSurcharge', 'duty'];
/*
 * The GVCL HT bill is one printed form: a grid with each heading above its figure. Scanned headings
 * read badly (Tarrif, MOnth's, boxes cut through words) while the figures read well, so this goes by
 * row and column. Rows are found from words that survive; columns are shares of the page width.
 * Figures printed in several places are cross-checked, and what can be worked out is:
 *   units     the value seen most often (KWH row, Diff*MF, A.Total Units, Energy and Fuel lines)
 *   PF        kWh / kVAh, cut to three places, when the PF cell cannot be read
 *   net       total consumption charge + duty, the bill's own "Current Month's Bill"
 */
const COL = { a: 0.102, kwh: 0.220, c: 0.301, d: 0.367, md: 0.430, pf: 0.452, e: 0.422, bd: 0.528, f: 0.513, g: 0.586, h: 0.665, last: 0.803 };
const asNumber = raw => {
  const c = String(raw).replace(/^[^\dA-Za-z.-]+|[^\dA-Za-z.]+$/g, '').replace(/[oO]/g, '0').replace(/[lIi|]/g, '1').replace(/[sS]/g, '5').replace(/B/g, '8').replace(/,/g, '');
  return /\d/.test(raw) && /^-?\d*\.?\d+$/.test(c) ? c : null; // at least one real digit: a stray | is not a 1
};
function rowsOf(tokens) {
  const list = [...tokens].sort((a, b) => a.y - b.y), rows = [];
  for (const q of list) {
    const last = rows[rows.length - 1];
    if (last && q.y - last.y < Math.max(q.h, 14) * 0.7) last.items.push(q);
    else rows.push({ y: q.y, items: [q] });
  }
  return rows;
}
function formHits(tokens, width) {
  if (!tokens || tokens.length < 60 || !width) return {};
  const text = tokens.map(q => q.t).join(' ').toLowerCase();
  if (!/summary/.test(text) || !/(vij company|ht bill|calculation)/.test(text)) return {};
  const rows = rowsOf(tokens);
  const at = (row, share, tol = 0.04) => {
    let best = null;
    for (const q of row.items) {
      const n = asNumber(q.t), d = Math.abs(q.x / width - share);
      if (n !== null && n.replace(/\D/g, '').length >= 1 && d < tol && (!best || d < best.d)) best = { n, d };
    }
    return best ? best.n : null;
  };
  const numbersIn = row => row.items.filter(q => { const n = asNumber(q.t); return n && n.replace(/\D/g, '').length >= 3; }).length;
  const find = re => rows.findIndex(r => r.items.some(q => re.test(q.t)));
  const after = (i, ok, span = 7) => (i < 0 ? [] : rows.slice(i + 1, i + 1 + span).filter(ok));
  const amount = v => { if (v === null) return null; const n = parseFloat(v); return v.includes('.') ? n : n / 100; };
  const out = {};
  const put = (k, value, via = 'grid') => { if (value !== null && Number.isFinite(value)) out[k] = { value, line: k, via }; };

  // Summary of charges: the charges row, then the duty and bill row.
  const money = after(find(/summary/i), r => numbersIn(r) >= 3, 9);
  let totCons = null, duty = null;
  if (money[0]) {
    put('demandCharge', amount(at(money[0], COL.a)));
    put('energyCharge', amount(at(money[0], COL.kwh)));
    put('fuelSurcharge', amount(at(money[0], COL.c)));
    totCons = amount(at(money[0], COL.last));
  }
  if (money[1]) { duty = amount(at(money[1], COL.a)); put('duty', duty); }
  if (totCons !== null && duty !== null) put('net', totCons + duty, 'derived');
  else if (money[1]) put('net', amount(at(money[1], COL.h)));

  // Consumer row: contract, 85 %, actual demand, billing demand. It has many digits and no words.
  const head = find(/^.?consumer$/i);
  const top = after(head, r => at(r, COL.c) !== null && at(r, COL.bd) !== null, 5)[0];
  if (top) {
    const cd = parseFloat(at(top, COL.c)), md = parseFloat(at(top, COL.md, 0.03)), bd = parseFloat(at(top, COL.bd));
    // a contract of 10000 scans as 110000 beside its cell border
    if (Number.isFinite(cd)) put('contract', cd % 100000 === 10000 ? 10000 : cd);
    if (Number.isFinite(md)) put('actualMD', md);
    if (Number.isFinite(bd)) put('billingDemand', bd);
  }
  // Units: seen in several places; the commonest is right.
  const seen = new Map();
  const count = v => { if (v && v.length >= 5) seen.set(v, (seen.get(v) || 0) + 1); };
  const supp = after(find(/^supp/i), r => at(r, COL.kwh) !== null, 3)[0];
  let kvah = null, pf = null;
  if (supp) {
    count(at(supp, COL.kwh)); kvah = parseFloat(at(supp, COL.c));
    const raw = supp.items.map(q => q.t).find(q => /^[^\d]*\.?9\d\d?$/.test(q));
    if (raw) pf = parseFloat(`0.${raw.replace(/\D/g, '')}`);
  }
  for (const r of rows) for (const q of r.items) { const n = asNumber(q.t); if (n && /^\d{6,8}$/.test(n)) count(n); }
  const units = [...seen].sort((a, b) => b[1] - a[1])[0];
  if (units && units[1] >= 2) put('kwh', parseFloat(units[0]));
  if (Number.isFinite(kvah) && kvah > 0) put('kvah', kvah);
  if (pf === null && out.kwh && kvah > 0 && out.kwh.value <= kvah) pf = Math.floor((out.kwh.value / kvah) * 1000) / 1000;
  if (pf !== null && pf > 0 && pf <= 1) put('pf', pf, 'derived');
  // A.Total Units row: night units in the second column, ToU in the third (a line lower on some scans).
  const totals = find(/total$/i) >= 0 ? rows.findIndex(r => r.items.some(q => /c\.?tou/i.test(q.t))) : -1;
  const below = after(totals, r => numbersIn(r) >= 1, 3);
  for (const r of below) {
    if (!out.todNight && at(r, COL.kwh)) put('todNight', parseFloat(at(r, COL.kwh)));
    if (!out.todPeak && at(r, COL.c)) put('todPeak', parseFloat(at(r, COL.c)));
  }
  return out;
}
/*
 * The form's figures sit in fixed cells, so each is cut out and read alone as digits, which is far
 * more reliable than reading the page. Cells are [left, right, row] as shares of the page; rows are
 * fitted to each scan from two printed headings, because a scan sits a little higher or lower.
 */
const CELLS = {
  contract: [0.300, 0.368, 0.172], actualMD: [0.447, 0.528, 0.172], billingDemand: [0.527, 0.592, 0.172],
  kwh: [0.217, 0.303, 0.2025], kvah: [0.300, 0.368, 0.2025], pf: [0.447, 0.528, 0.2025],
  todNight: [0.217, 0.303, 0.402], todPeak: [0.300, 0.368, 0.402],
  demandCharge: [0.098, 0.220, 0.836], energyCharge: [0.217, 0.303, 0.836], fuelSurcharge: [0.300, 0.368, 0.836],
  totCons: [0.795, 0.885, 0.836], duty: [0.098, 0.220, 0.884], net: [0.660, 0.745, 0.884], consumerNo: [0.098, 0.217, 0.172],
  // the Electricity Duty box: up to three lines of kWh, charges, rate and amount
  ...Object.fromEntries([0.551, 0.5667, 0.5815].flatMap((row, i) => [
    [`edKwh${i + 1}`, [0.525, 0.588, row]], [`edCharge${i + 1}`, [0.584, 0.665, row]], [`edRate${i + 1}`, [0.661, 0.744, row]], [`edAmt${i + 1}`, [0.740, 0.800, row]],
  ])),
};
const ANCHOR = { consumption: 0.3537, summary: 0.7862 };
async function readCells(dataUrl, page, status) {
  const heading = re => page.tokens.find(q => re.test(q.t));
  const c = heading(/^consumption$/i), s = heading(/^summary$/i);
  if (!c || !s) return {};
  const raw = await loadImg(dataUrl), lined = await loadImg((await preprocess(dataUrl, 3400, { lines: true })).dataUrl);
  const W = lined.naturalWidth, H = lined.naturalHeight, k = W / raw.naturalWidth;
  // straight-line fit: expected share of the page -> pixels on this scan
  const y1 = c.y * k, y2 = s.y * k, slope = (y2 - y1) / (ANCHOR.summary - ANCHOR.consumption);
  const rowAt = share => y1 + (share - ANCHOR.consumption) * slope;
  const w = await ocrWorker(status);
  await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.' });
  const ways = [[raw, 1, 0.0075], [lined, 2, 0], [lined, 1, 0], [raw, 2, 0.0075]]; // picture, enlargement, inset
  const out = {};
  try {
    for (const [key, [x0, x1, row]] of Object.entries(CELLS)) {
      const seen = [];
      for (const [img, up, inset] of ways) {
        const f = img === raw ? 1 / k : 1, sw = (x1 - x0 - inset) * W, sh = 0.021 * H;
        const cv = document.createElement('canvas');
        cv.width = Math.round(sw * up); cv.height = Math.round(sh * up) + 40;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, (x0 + inset) * W * f, (rowAt(row) - sh / 2) * f, sw * f, sh * f, 0, 20, sw * up, sh * up);
        const { data } = await w.recognize(cv.toDataURL('image/png'));
        const v = (data.text || '').replace(/\s/g, '');
        if (/\d/.test(v)) seen.push(v);
      }
      out[key] = seen;
    }
  } finally {
    await w.setParameters({ tessedit_char_whitelist: '' });
  }
  return out;
}
/** An ED rate as printed: ".15" or ".1". The reader may lose the point. */
const rateOf = list => {
  const v = commonest((list || []).map(s => s.replace(/^0?\./, '')).filter(s => /^\d{1,2}$/.test(s)));
  return v ? parseFloat(`0.${v}`) : null;
};
/** The reading to believe: two that agree, else the fullest. Money prefers a proper two-decimal figure. */
const commonest = list => { const n = new Map(); for (const v of list) n.set(v, (n.get(v) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || ''; };
const pickWhole = (list, ok = () => true) => commonest((list || []).map(v => v.replace(/\.$/, '').replace(/\.00$/, '')).filter(v => /^\d+$/.test(v) && ok(+v)));
const pickMoney = list => {
  const good = (list || []).filter(v => /^\d{3,}\.\d\d$/.test(v));
  if (good.length) return commonest(good.sort((a, b) => b.length - a.length).filter((v, _, a) => v.length === a[0].length));
  return commonest((list || []).filter(v => /^\d{5,}$/.test(v)));
};
/** What the cells say, as hits. Money has two decimals even if the point was missed. */
function cellHits(cells, base, tokens = [], width = 0) {
  const out = { ...base };
  // A crop can lose a figure's first digit. If the page holds the same figure with one more digit in
  // front, that is the figure.
  const pageNumbers = tokens.map(q => asNumber(q.t)).filter(Boolean).map(v => v.replace(/\.$/, ''));
  const whole = v => {
    if (!v) return v;
    const bare = v.replace(/\./g, '');
    const full = pageNumbers.find(p => { const d = p.replace(/\./g, ''); return d.length === bare.length + 1 && d.endsWith(bare); });
    return full ?? v;
  };
  const put = (k, value, via = 'grid') => { if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) out[k] = { value, line: k, via }; };
  const number = v => (v && /\d/.test(v) ? parseFloat(whole(v)) : null);
  const money = v => { if (!v) return null; const w = whole(v), n = parseFloat(w); return Number.isFinite(n) ? (w.includes('.') ? n : n / 100) : null; };
  const contract = number(pickWhole(cells.contract, v => v >= 50)), bd = number(pickWhole(cells.billingDemand, v => v >= 50));
  put('contract', contract); put('billingDemand', bd);
  put('actualMD', number(pickWhole(cells.actualMD, v => v >= 50 && (!contract || v < contract * 2))));
  // kWh is printed in several places: a cell far from the page's figure lost a digit.
  const pageKwh = base.kwh?.value, near = v => !pageKwh || (v > pageKwh * 0.98 && v < pageKwh * 1.02);
  put('kwh', number(pickWhole(cells.kwh, near)) ?? pageKwh ?? null);
  // Energy charge over units is always a tariff rate: a wrong kWh shows at once, and a lost first digit can be put back.
  const energyNow = money(pickMoney(cells.energyCharge)) ?? base.energyCharge?.value;
  const clean = (a, b) => { const q = a / b; return Math.abs(q - Math.round(q * 100) / 100) < 2e-4; }; // a rate in whole paise
  const fits = v => !energyNow || (energyNow / v >= 2.5 && energyNow / v <= 7 && clean(energyNow, v));
  if (energyNow && !(out.kwh && fits(out.kwh.value))) {
    // Tariff rates run in steps of 5 paise and metered units are whole, so the charge names the units.
    // Only a figure that agrees with what was read: several rates can divide a charge cleanly, and a
    // wrong kWh is worse than an empty box.
    const seen = out.kwh?.value, tail = seen ? String(Math.round(seen)).slice(1) : '';
    const guess = seen ? Array.from({ length: 91 }, (_, i) => 2.5 + i * 0.05).map(r => energyNow / r)
      .filter(k => Math.abs(k - Math.round(k)) < 0.02 && Math.round(k) % 10 === 0)
      .find(k => (tail.length >= 4 && String(Math.round(k)).endsWith(tail)) || Math.abs(k - seen) < seen * 0.01) : null;
    if (guess) put('kwh', Math.round(guess), 'derived'); else delete out.kwh;
  }
  const kwh = out.kwh?.value;
  const kvah = number(pickWhole(cells.kvah, v => !kwh || (v >= kwh && v < kwh * 1.3)));
  put('kvah', kvah ?? base.kvah?.value ?? null);
  const pfRead = pickWhole((cells.pf || []).map(v => v.replace(/^0?\./, '')), v => v >= 500 && v <= 1000);
  if (pfRead) put('pf', parseFloat(`0.${pfRead.slice(-3)}`));
  else if (kwh && out.kvah) put('pf', Math.floor((kwh / out.kvah.value) * 1000) / 1000, 'derived');
  const part = v => !kwh || v < kwh;
  put('todNight', number(pickWhole(cells.todNight, part))); put('todPeak', number(pickWhole(cells.todPeak, part)));
  put('demandCharge', money(pickMoney(cells.demandCharge))); put('energyCharge', money(pickMoney(cells.energyCharge))); put('fuelSurcharge', money(pickMoney(cells.fuelSurcharge)));
  put('duty', money(pickMoney(cells.duty)));
  // A fuel rate is whole paise too, so a lost first digit of the surcharge shows.
  if (kwh && out.fuelSurcharge && !clean(out.fuelSurcharge.value, kwh)) {
    const mid = String(Math.round(out.fuelSurcharge.value)), fixed = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => +`${d}${mid}`).find(v => clean(v, kwh));
    if (fixed) put('fuelSurcharge', fixed);
  }
  // Sanity from the bill's own make-up: a figure out of all proportion is left for a person to type.
  const size = (out.energyCharge?.value || 0) + (out.fuelSurcharge?.value || 0);
  if (kwh && out.fuelSurcharge && (out.fuelSurcharge.value / kwh < 0.5 || out.fuelSurcharge.value / kwh > 4)) delete out.fuelSurcharge;
  if (out.duty && size && (out.duty.value < size * 0.04 || out.duty.value > size * 0.3)) delete out.duty;
  if (out.demandCharge && out.energyCharge && out.demandCharge.value > out.energyCharge.value) delete out.demandCharge;
  for (const k of ['todNight', 'todPeak']) if (out[k] && kwh && (out[k].value >= kwh || out[k].value < kwh * 0.08)) delete out[k];
  // Total consumption charge: its cell, else the same figure in the Calculation of Charges box.
  const totRead = money(pickMoney(cells.totCons));
  const totPage = tokens.filter(q => Math.abs(q.x / (width || 1) - 0.367) < 0.03).map(q => asNumber(q.t)).filter(v => v && /^\d{7,}\.\d\d$/.test(v)).map(Number)
    .filter(v => v > (out.energyCharge?.value || 0)).sort((a2, b2) => b2 - a2)[0];
  const tot = totRead && totPage && Math.abs(totRead - totPage) > 2 ? totPage : totRead ?? totPage ?? null;
  put('totConsBilled', tot);
  // Demand is what is left of the total after energy and fuel, give or take the smaller lines, so a
  // leading digit picked up from the cell border shows.
  if (tot && out.demandCharge && out.energyCharge && out.fuelSurcharge) {
    const room = tot - out.energyCharge.value - out.fuelSurcharge.value, d = out.demandCharge.value;
    if (d > room * 1.3) {
      const cut = parseFloat(String(d).slice(1));
      if (cut > 0 && cut < room * 1.3) put('demandCharge', cut); else delete out.demandCharge;
    }
  }
  const net = money(pickMoney(cells.net));
  // The bill's own sum settles the duty: current month's bill = consumption charge + duty.
  if (net && tot && net - tot > 1) put('duty', Math.round((net - tot) * 100) / 100, 'derived');
  else if (net && tot && Math.abs(net - tot) <= 1) out.duty = { value: 0, line: 'duty', via: 'derived' }; // exempted
  const duty = out.duty?.value;
  // The bill's own sum is the check: total consumption charge + duty = current month's bill.
  if (tot && duty && (!net || Math.abs(tot + duty - net) > 2)) put('net', Math.round((tot + duty) * 100) / 100, 'derived');
  else put('net', net);
  if (out.net && !(out.net.value > 0)) delete out.net; // a "0" from a blank box or the adjustment page
  // Duty lines. Everything read in the box is a candidate; only figures that add up to the month's
  // units are believed, so a misread line never reaches the bill.
  const colNums = share => tokens.filter(q => Math.abs(q.x / (width || 1) - share) < 0.032).map(q => ({ y: q.y, v: asNumber(q.t) })).filter(x => x.v);
  const inCells = key => [1, 2, 3].flatMap(i => (cells[`${key}${i}`] || []).map(v => ({ y: i * 1e6, v: v.replace(/\.$/, '') })));
  const list = key => [...colNums(key === 'edKwh' ? 0.53 : key === 'edCharge' ? 0.586 : 0.743), ...inCells(key)];
  const units = [...new Map(list('edKwh').filter(x => /^\d{5,8}$/.test(x.v)).map(x => [+x.v, x])).values()].sort((p, q) => p.y - q.y);
  let lines = [];
  if (kwh) {
    outer: for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      const a2 = +units[i].v, b2 = +units[j].v;
      if (Math.abs(a2 + b2 - kwh) <= 1) { lines = [a2, b2]; break outer; }
      for (let k3 = j + 1; k3 < units.length; k3++) if (Math.abs(a2 + b2 + +units[k3].v - kwh) <= 1) { lines = [a2, b2, +units[k3].v]; break outer; }
    }
  }
  if (lines.length) {
    const charges = [...new Set(list('edCharge').map(x => parseFloat(x.v)).filter(v => v > 100))];
    const amounts = [...new Set(list('edAmt').map(x => (x.v.includes('.') ? parseFloat(x.v) : parseFloat(x.v) / 100)).filter(v => v > 10))];
    const bySum = tot, usedAmt = [];
    out.edTypes = { value: lines.length, line: 'duty lines', via: 'grid' };
    lines.forEach((k3, idx) => {
      const i = idx + 1;
      put(`edKwh${i}`, k3);
      // the same rupees per unit on every line, as far as the total is known
      const expect = bySum ? (bySum * k3) / kwh : null;
      const charge = expect ? charges.find(v => Math.abs(v - expect) <= expect * 0.0005) : number(pickWhole(cells[`edCharge${i}`], v => v > 100));
      if (charge) {
        put(`edCharge${i}`, charge);
        // ED rates move in steps of 5%, so an amount must be such a share of this line's charge.
        const amt = amounts.find(v => { const q = v / charge; return !usedAmt.includes(v) && q > 0.02 && q < 0.5 && Math.abs(q - Math.round(q * 20) / 20) < 1e-4; });
        if (amt) { usedAmt.push(amt); put(`edAmt${i}`, amt); put(`edRate${i}`, Math.round((amt / charge) * 20) / 20); }
      }
      if (!out[`edRate${i}`]) put(`edRate${i}`, rateOf(cells[`edRate${i}`]));
    });
    const sumAmt = lines.reduce((a3, _, idx) => a3 + (out[`edAmt${idx + 1}`]?.value || 0), 0);
    if (!out.duty && lines.every((_, idx) => out[`edAmt${idx + 1}`])) put('duty', Math.round(sumAmt * 100) / 100, 'derived');
    // With the duty and one line's amount known, the other line's amount is what remains.
    if (lines.length === 2 && out.duty?.value) {
      const miss = [1, 2].find(i => !out[`edAmt${i}`]), have = 3 - miss;
      if (miss && out[`edAmt${have}`]) put(`edAmt${miss}`, Math.round((out.duty.value - out[`edAmt${have}`].value) * 100) / 100, 'derived');
    }
  }
  // No line's kWh read, but 1: Charges can be told by the total: two rates, and the Ledger works out the rest.
  if (!lines.length && tot) {
    const seen = [...new Set(list('edCharge').map(x => parseFloat(x.v)).filter(v => v > tot * 0.02 && v < tot * 0.98))].sort((p, q) => p - q);
    const pair = seen.find(v => seen.some(w => w !== v && Math.abs(v + w - tot) <= 5));
    const first = number(pickWhole(cells.edCharge1, v => v > tot * 0.02 && v < tot * 0.98)) ?? pair;
    if (first) { out.edTypes = { value: 2, line: 'duty lines', via: 'grid' }; put('edCharge1', first); put('edRate1', rateOf(cells.edRate1)); put('edRate2', rateOf(cells.edRate2)); }
  }
  const consumer = pickWhole(cells.consumerNo, v => v >= 100);
  if (consumer && !out.consumerNo) out.consumerNo = { value: consumer, line: 'consumer no', via: 'grid' };
  return out;
}
/** Everything found on a page: the printed label matcher, and the form reader where it found a figure. */
/*
 * The same HT form as a true text PDF: every word has its exact place, so each heading looks straight
 * down its own column, and each row label straight across. Nothing here is guessed. It also keeps what
 * the label matcher cannot tell apart: Current Month's Bill from Net Payable, and a duty of 0 under an
 * exemption from a duty not read.
 */
function textForm(tokens) {
  if (!tokens || tokens.length < 60) return {};
  const line = tokens.map(q => q.t).join(' ');
  if (!/HT BILL/i.test(line) || !/SUMMARY/i.test(line)) return {};
  const list = [...tokens].sort((a, b) => a.y - b.y || a.x - b.x);
  const first = (re, after = -1) => list.find(q => q.y > after && re.test(q.t));
  const sameRow = (ref, re, tol = 9) => list.find(q => Math.abs(q.y - ref.y) < tol && q !== ref && re.test(q.t));
  const clean = t => String(t).replace(/,/g, '').replace(/%$/, '');
  const isNum = t => /^-?\d*\.?\d+$/.test(clean(t));
  const under = (head, reach = 75) => list.find(q => q.y > head.y + 4 && q.y < head.y + reach && Math.abs(q.x - head.x) < 12 && isNum(q.t));
  const num = q => (q ? parseFloat(clean(q.t)) : null);
  const across = (row, col, tol = 12) => list.find(q => Math.abs(q.y - row.y) < tol && Math.abs(q.x - col.x) < 14 && isNum(q.t));
  const out = {};
  const put = (k, v) => { if (v !== null && v !== undefined && (typeof v !== 'number' || Number.isFinite(v))) out[k] = { value: v, line: k, via: 'pdf' }; };
  const headed = (k, re, after) => { const h = first(re, after); if (h) put(k, num(under(h))); return h; };

  const consumer = first(/^consumer$/i);
  if (consumer) put('consumerNo', under(consumer)?.t ?? null);
  headed('contract', /^contract$/i); headed('actualMD', /^actual$/i); headed('billingDemand', /^billing$/i);
  headed('kwh', /^kwh$/i); headed('kvah', /^kvah$/i); headed('kvarh', /^kvarh$/i); headed('pf', /^avg$/i);
  headed('supplyKv', /^supp$/i);

  const mf = first(/^diff\*mf$/i), peak = first(/^peak$/i);
  if (mf && peak) {
    const night = sameRow(peak, /^night$/i), disc = sameRow(peak, /^tou$/i);
    put('todPeak', num(across(mf, peak)));
    if (night) put('todNight', num(across(mf, night)));
    if (disc) put('touDiscUnits', num(across(mf, disc)));
  }
  // The Electricity Duty box of Calculation of Charges: one line for each rate.
  const calc = first(/^calculation$/i), box = calc && first(/^electricity$/i, calc.y), setOff = first(/^set$/i);
  if (box && setOff) {
    const hK = sameRow(box, /^kwh$/i, 12), hC = sameRow(box, /^consumption$/i, 12), hR = sameRow(box, /^ed$/i, 12), hA = sameRow(box, /^amount$/i, 12), hE = sameRow(box, /^exempted$/i, 12);
    if (hK && hC && hR && hA) {
      const rows = list.filter(q => q.y > box.y + 4 && q.y < setOff.y && Math.abs(q.x - hK.x) < 12 && isNum(q.t));
      let exempt = 0;
      rows.forEach((q, idx) => {
        const i = idx + 1, at = col => num(across(q, col, 7));
        put(`edKwh${i}`, num(q)); put(`edCharge${i}`, at(hC)); put(`edRate${i}`, at(hR)); put(`edAmt${i}`, at(hA));
        if (hE) exempt += at(hE) || 0;
      });
      if (rows.length > 1) put('edTypes', rows.length);
      if (exempt) put('edExempt', Math.round(exempt * 100) / 100);
    }
  }
  // Calculation of Charges, by row label. The Sep 2026 form calls the fuel row Base Fuel charge and adds
  // Variable FPPAS, a percentage on demand + energy + base fuel.
  const moneyCol = calc && first(/^amount$/i, calc.y), rateCol = calc && first(/^rate$/i, calc.y + 40);
  const variable = first(/^variable$/i);
  if (variable && moneyCol) {
    put('fppasVar', num(across(variable, moneyCol, 8)));
    const pct = rateCol && list.find(q => Math.abs(q.y - variable.y) < 8 && Math.abs(q.x - rateCol.x) < 14 && isNum(q.t));
    if (pct) put('fppasPct', num(pct));
  }
  const upto = first(/^J\.ED$/i);
  if (upto) { const d = list.find(q => q.y > upto.y && q.y < upto.y + 60 && /^\d{2}-\d{2}-\d{4}$/.test(q.t)); if (d) put('edExemptUpto', d.t); }

  const sum = first(/^summary$/i);
  if (sum) {
    headed('demandCharge', /^demand$/i, sum.y); headed('energyCharge', /^energy$/i, sum.y); headed('fuelSurcharge', /^fuel$/i, sum.y);
    headed('totConsBilled', /^tot$/i, sum.y); headed('duty', /^electricity$/i, sum.y); headed('net', /^current$/i, sum.y);
    const disc = first(/^disc$/i, sum.y), time = disc && list.filter(q => /^time$/i.test(q.t) && Math.abs(q.y - disc.y) < 5 && q.x < disc.x).sort((a, b) => b.x - a.x)[0];
    const td = time && under(time);
    if (td) put('touDiscount', Math.abs(num(td)));
  }
  return out;
}

/** The consumer number in printed words, as on a bill's second page or a text PDF. */
function consumerNoIn(text) {
  const m = /consumer\s*(?:no|number|num)?\.?\s*[:.\-]?\s*([0-9][0-9\-\/]{3,20})/i.exec(String(text || ''));
  return m ? m[1].replace(/\D+$/, '') : null;
}
function pageHits(r) {
  const hits = { ...extractBill(r.tokens.length ? r.tokens : r.text), ...formHits(r.tokens, r.width) };
  const found = r.cells ? cellHits(r.cells, hits, r.tokens, r.width) : hits;
  if (!found.consumerNo) { const no = consumerNoIn(r.text); if (no) found.consumerNo = { value: no, line: 'consumer no', via: 'text' }; }
  return found;
}
function billScore(r) {
  const hits = pageHits(r);
  const figures = FIGURES.reduce((n, k) => n + (hits[k] ? 1 : 0), 0);
  const words = (r.text.match(/\b(electricity|bill|consumer|units?|kwh|kvah?|demand|energy|charges?|tariff|vij|torrent|fppa|meter)\b/gi) || []).length;
  return figures * 8 + (hits.month ? 6 : 0) + Math.min(words, 12);
}
/**
 * One page or photograph. Tried plainly first; a poor result is tried again sharpened for shadows,
 * then turned, and the best reading wins. A clean page takes one pass.
 */
async function ocrImage(dataUrl, status) {
  const passes = [{}, { lines: true, edge: 3400, psm: '6', say: 'Clearing the table lines and reading again…' }, { threshold: true, edge: 2600, say: 'Sharpening the picture and reading again…' },
    { quarter: 1, threshold: true, say: 'Turning the picture…' }, { quarter: 3, threshold: true, say: 'Turning the picture…' }, { quarter: 2, threshold: true, say: 'Turning the picture…' }];
  let best = null, bestScore = -1;
  for (const p of passes) {
    const r = await ocrOnce(dataUrl, status, p);
    const score = billScore(r);
    if (score > bestScore) { best = r; bestScore = score; }
    if (bestScore >= 72) break; // eight or more figures in hand
    // Sideways pictures read as noise. A page read well enough to know what it is need not be turned.
    if (p.threshold && bestScore >= 30) break;
  }
  // The GVCL HT form: read its cells one by one.
  if (best && best.tokens.some(q => /^summary$/i.test(q.t)) && best.tokens.some(q => /^consumption$/i.test(q.t))) {
    status('Reading the figures one by one…');
    best.cells = await readCells(dataUrl, best, status).catch(() => null);
    bestScore = billScore(best);
  }
  return { ...best, score: bestScore }; // no text at all simply scores nothing: "not a bill"
}
const NOT_A_BILL = 14;
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

/**
 * Readings of pages that belong to one bill become one bill: the same month, or a page with no month
 * after a page that has one. The picture kept is the page with most of the figures.
 */
function joinScans(list) {
  const bills = [];
  for (const s of list) {
    const hits = pageHits(s.r);
    const month = hits.month ? String(hits.month.value).toLowerCase() : '';
    const last = bills[bills.length - 1];
    const twoBills = last && hits.kwh && hits.net && last.hits.kwh && last.hits.net; // both carry a bill's own figures
    if (last && !twoBills && (!month || !last.month || month === last.month)) {
      for (const [k, h] of Object.entries(hits)) if (!last.hits[k]) last.hits[k] = h;
      last.month ||= month;
      if (s.r.score > last.score) { last.score = s.r.score; last.img = s.img; last.name = s.name; }
    } else bills.push({ hits, month, score: s.r.score, img: s.img, name: s.name });
  }
  return bills.map(b => hitsToBill(b.hits, 'ocr', b.name, b.img));
}

const hitsToBill = (hits, how, name, img) => {
  addDerivedRateHits(hits);
  const fields = {}, sources = {};
  for (const [k, h] of Object.entries(hits)) { fields[k] = h.value; sources[k] = h.via === 'derived' ? 'derived' : how; }
  return { fields, sources, how, name, img };
};

/** Every bill in the files given: PDFs (one or many bills) and photographs. status(text) reports progress. */
export async function readBills(files, status = () => {}) {
  const out = [], scanned = [], skipped = [];
  try {
    for (const file of files) {
      status(`Opening ${file.name}…`);
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const bills = [];
        await ingestBillPdf(file, b => bills.push(b));
        for (const b of bills) {
          if (b.textLayer) {
            const hits = extractBill(b.tokens.length ? b.tokens : b.text), no = consumerNoIn(b.text);
            if (no) hits.consumerNo = { value: no, line: 'consumer no', via: 'text' };
            Object.assign(hits, textForm(b.tokens));
            out.push(hitsToBill(hits, 'pdf', b.src, b.img));
            continue;
          }
          // A scanned PDF: pictures of pages, often with notices and adverts between the bills.
          let n = 0;
          for (const page of b.pages) {
            status(`${file.name}: page ${page.no}…`);
            const r = await ocrImage(page.sharp || page.img.dataUrl, status);
            if (r.score < NOT_A_BILL) { skipped.push(`${file.name} page ${page.no}`); continue; }
            scanned.push({ r, name: `${file.name} p${page.no}`, img: page.img });
            n++;
          }
          if (!n) status(`${file.name}: no bill found`);
        }
        out.push(...joinScans(scanned.splice(0)));
      } else {
        const original = await fileToDataUrl(file);
        const img = await shrink(original);
        const r = await ocrImage(original, status);
        if (r.score < NOT_A_BILL) { skipped.push(file.name); continue; }
        scanned.push({ r, name: file.name, img });
      }
    }
    out.push(...joinScans(scanned)); // photographs: two sides of one bill come together
  } finally {
    if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  }
  out.skipped = skipped;
  return out;
}
export { BILL_FIELDS, extractBill, consumerNoIn, textForm };
