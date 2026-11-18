"""First ar-status.json for Rishabh's KISEM update ledger, from AR's git history (2026-11-18).

Each code AR has settled gets ported / skipped / not-applicable, with the AR commit as ar_ref.
Codes not listed stay "pending" in the ledger. Rules, in order:
  1. not-applicable / skipped: KISEM-only things (site, inventory app, download page, KISEM servers,
     FOX logo, renames, the ledger itself) and what AR deliberately left out (inventory in BRIEF).
  2. explicit sync labels in AR commits ("KISEM A-CMP 42e9084", "KISEM fox-kisen c7e1d3b^..538eb2d").
  3. the shared app kit replayed into every AR app on 16 Nov ("KISEM MLA 3c4ed6f..oracle (kit files only)").
  4. everything in a KISEM app before its port-app.mjs run (3 Nov 20:43 IST; Grid Lens 28 Oct).
  5. PostMan: Report Studio was copied from PostMan-KISEM oracle on 16 Nov (report_studio_ares d044986).
  6. FOX Console: the ares-ops commits that name what they took (17c53f0, 3b0d257, b09c1fc, a4438b1).
"""
import json, re, sys
from datetime import datetime

rows = json.load(open(sys.argv[1]))
AT = "2026-11-18"

def when(code):
    m = re.match(r"KU-(\d{6})-(\d{4})-", code)
    return datetime.strptime(m.group(1) + m.group(2), "%y%m%d%H%M")

# KISEM app -> (AR app, AR repo, port-app.mjs commit, port time IST)
FIELD = {
    "A-CMP": ("Air Findings", "ares-air", "ccf6cf2", "2026-11-03 20:43"),
    "Thermo-X": ("Boiler & Fuel", "ares-boiler", "f35832a", "2026-11-03 20:43"),
    "GridMap": ("BRIEF", "ares-brief", "dd0bb0a", "2026-11-03 20:43"),
    "AC, AHU & Chiller": ("Cool Zone", "ares-cooling", "1673801", "2026-11-03 20:43"),
    "Dryers": ("Dryer Heat", "ares-dryer", "430e080", "2026-11-03 20:43"),
    "JET-Eff": ("Dye House", "ares-jet", "4ec2651", "2026-11-03 20:43"),
    "Lighting": ("Lux Survey", "ares-light", "33d32cf", "2026-11-03 20:43"),
    "MLA": ("Motor Pulse", "ares-mla", "e08b412", "2026-11-03 20:43"),
    "Pump EFF": ("Hydro Flow", "ares-pump", "949ce80", "2026-11-03 20:43"),
    "Xmer-Eff": ("Trafo Check", "ares-xmer", "e3f1b81", "2026-11-03 20:43"),
    "AI Power Quality Analyzer": ("Grid Lens", "ares-power", "284674d", "2026-10-28 12:14"),
}
# The 16 Nov kit replay commit in each AR app ("KISEM MLA 3c4ed6f..oracle (kit files only)").
KIT = {"ares-air": "ec3b30f", "ares-boiler": "c8fc4f9", "ares-brief": "dd957c8", "ares-cooling": "d288bd8",
       "ares-dryer": "c93673f", "ares-jet": "dd13f60", "ares-light": "f305ccd", "ares-mla": "cc9c114",
       "ares-pump": "ca40db1", "ares-xmer": "10f251e"}
KIT_THEMES = ("Quick-check data no longer joins", "Opened from FOX Console for a company the app is not on",
              "A different person signing in on this phone", "One company at a time on this device")
# Explicit labels: KISEM commit -> AR repo and commit.
LABELS = {
    "42e9084": "ares-air 35d0624", "e65e174": "ares-air 55e13ef", "6678326": "ares-air e6ab4ef",
    "1073e7f": "ares-air f32403b", "c1da6e3": "ares-air d30a4d2", "534f867": "ares-boiler f617f3f",
    "c7e1d3b": "ares-brief d4b853a (PDF report tab; KISEM's new name and icon not taken)",
    "afe89d7": "ares-cooling 5e28630", "4af415d": "ares-mla 92c027e", "76f4ab6": "ares-mla a43d700",
    "f21b69a": "ares-pump 29f9406", "3627e41": "ares-xmer cdcbf6e",
}
# FOX Console -> ares-ops, from the commits that say what they took.
CON = {
    "2179b02": "ares-ops 17c53f0", "728a4ea": "ares-ops 17c53f0", "a9bb9a4": "ares-ops 17c53f0",
    "cdd4942": "ares-ops 17c53f0", "13139df": "ares-ops 17c53f0", "fae17dc": "ares-ops 17c53f0",
    "6f6888c": "ares-ops 17c53f0", "3966ac9": "ares-ops 17c53f0", "dd3b564": "ares-ops 17c53f0",
    "1a7da8b": "ares-ops 17c53f0 (AI bill reader off)",
    "196afc3": "ares-ops 3b0d257", "ef00f0e": "ares-ops 3b0d257 (sync part only)", "8c5d1b8": "ares-ops 3b0d257 (image rule)",
    "0daf235": "ares-ops b09c1fc, a4438b1", "e4dd5cd": "ares-ops b09c1fc, a4438b1", "83efe9e": "ares-ops b09c1fc, a4438b1",
    "1cdff7c": "ares-ops b09c1fc, a4438b1 (ED rates and tariffs)", "2ae46c8": "ares-ops a4438b1", "451ecce": "ares-ops a4438b1",
}
NA_CON = {  # FOX Console changes that are about KISEM's own servers, people, site or apps AR does not have
    "516a973": "KISEM server", "68834ef": "KISEM service name", "635fcc2": "KISEM look", "b3aa53c": "KISEM server",
    "71db4ff": "KISEM server", "9aa2525": "KISEM server", "e9af327": "KISEM backups", "bac4b53": "KISEM backups (AR has its own)",
    "f7a6939": "IITGN NAS", "cc9fd94": "IITGN NAS", "bdd2a19": "eassiitgn.page", "c9693cc": "KISEM audit website",
    "3a72d8a": "KISEM server deploys", "f6e4f92": "FOX Console's start as a copy of ARES", "7729677": "KISEM deploy script",
    "8bdd685": "KISEM deploy script", "0e74231": "KISEM download page", "ffd123e": "KISEM deploy script",
    "89b26e4": "KISEM build server", "8ea99a3": "KISEM build server", "038cdc7": "KISEM download page",
    "083baca": "KISEM build server", "2d8b7d6": "KISEM PostMan address", "540160f": "KISEM's old PostMan and EASS",
    "7fc823d": "AR registers its own apps (lib/apps.js)", "2f0f79c": "AR registers its own apps (lib/apps.js)",
    "3567d55": "KISEM faculty cards (AR keeps its own Team page, 25329ab)", "8af3ce6": "KISEM sign-in page and marks",
    "c6a7ee5": "IITGN e-mail", "b757921": "KISEM audit website", "9ebbe4e": "KISEM audit website",
    "ce5906d": "Inventory WTEA (no AR app)", "01efe60": "Inventory WTEA (no AR app)", "1122784": "Inventory WTEA (no AR app)",
    "83d374e": "Inventory WTEA (no AR app)", "914817d": "Inventory WTEA (no AR app)", "f1d7875": "Inventory WTEA (no AR app)",
    "825047d": "Inventory WTEA (no AR app)", "8412b2c": "KISEM domains and deploy scripts", "193be2c": "KISEM hosting move",
    "ea8add6": "KISEM download page", "f40208f": "KISEM server folders", "e6037a0": "KISEM reference company",
    "363e185": "KISEM app rename", "3caf103": "KISEM app rename", "210a280": "the KISEM ledger itself",
    "8b94e72": "the KISEM ledger itself", "2e46f94": "FOX logo", "888a9bc": "KISEM menu item (Chat, coming soon)",
}

out, why = {}, {}
def put(code, status, ref, note=""):
    out[code] = {"status": status, "ar_ref": ref, "at": AT, "note": note}

for r in rows:
    code, app, h, name = r["code"], r["app"], r["commit"], r["name"]
    t = when(code)
    # 1. KISEM-only and deliberate skips
    if app in ("KISEM audit website",):
        put(code, "not-applicable", "", "KISEM's website; AR has its own (AR-Enterprise-website-design)"); continue
    if app == "Inventory WTEA":
        put(code, "not-applicable", "", "no Inventory WTEA app in AR"); continue
    if app == "App download page":
        put(code, "not-applicable", "", "KISEM's download page; AR has its own (AR-Enterprise-APPS-Repo-)"); continue
    if code.startswith("KU-261118-1243-"):
        put(code, "not-applicable", "", "FOX logo / mark"); continue
    if app == "FOX Console" and h in NA_CON:
        put(code, "not-applicable", "", NA_CON[h]); continue
    if re.search(r"Builds run on the KISEM Oracle server|KISEM Oracle system: Console sign-in|The app names the Console it was built for"
                 r"|^logo\.png for the sign-in|^Rename (Zero Degree|Pump-Up)|Pump-Up is now Pump EFF", name):
        put(code, "not-applicable", "", "KISEM build, address or naming; AR apps build and sign in their own way"); continue
    if app == "AI Power Quality Analyzer" and re.search(r"KISEM team's FOX Console login|names the Console the screen was built for", name):
        put(code, "not-applicable", "", "KISEM sign-in"); continue
    if app == "PostMan" and re.search(r"retired eassiitgn|finds FOX Console and the analyser from its own address", name):
        put(code, "not-applicable", "", "KISEM addresses"); continue
    if re.search(r"from the Inventory WTEA list", name):
        put(code, "not-applicable", "", "needs Inventory WTEA (no AR app)"); continue
    if h == "87e2fd5":
        put(code, "pr-open", "ares-jet branch fix-pipe-area d9475b7", "fixed on a branch 18 Nov, waiting for merge and an APK / web rebuild"); continue
    if app == "GridMap" and h in ("ec672d8", "538eb2d"):
        put(code, "skipped", "ares-brief d4b853a", "inventory tab not taken: AR has no Inventory WTEA"); continue
    # 2. explicit labels
    if h in LABELS:
        put(code, "ported", LABELS[h]); continue
    if app == "FOX Console":
        if h in CON: put(code, "ported", CON[h])
        continue
    if app == "PostMan":
        if t <= datetime(2026, 11, 16, 18, 54):
            put(code, "ported", "report_studio_ares d044986", "Report Studio copied from PostMan-KISEM oracle, 16 Nov")
        continue
    if app in FIELD:
        arname, repo, pc, ptime = FIELD[app]
        # 3. the 16 Nov kit replay
        if repo in KIT and any(name.startswith(k) for k in KIT_THEMES):
            put(code, "ported", f"{repo} {KIT[repo]}", "kit replay KISEM MLA 3c4ed6f..oracle (kit files only)"); continue
        # 4. before the port
        if t <= datetime.strptime(ptime, "%Y-%m-%d %H:%M"):
            put(code, "ported", f"{repo} {pc}", f"in the KISEM code {arname} was ported from (port-app.mjs)"); continue

json.dump(dict(sorted(out.items(), key=lambda kv: kv[0], reverse=True)), open(sys.argv[2], "w"), indent=1, ensure_ascii=False)
from collections import Counter
print("settled:", len(out), "of", len(rows), Counter(v["status"] for v in out.values()))
pend = Counter(r["app"] for r in rows if r["code"] not in out)
print("still pending:", sum(pend.values()), dict(pend))
