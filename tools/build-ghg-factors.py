# Makes public/ledger-factors.json (the Energy Ledger's GHG factor library) from the UK Government
# "GHG Conversion Factors for Company Reporting" full-set workbook.
#
#   python tools/build-ghg-factors.py <ghg-conversion-factors-YYYY-full-set.xlsx> public/ledger-factors.json
#
# Needs openpyxl. Run it once a year when the new set comes out (each sheet's header gives its next
# publication date), check the printed counts and the spot values in test/smoke.mjs, and commit the JSON.
# Only sheets laid out as Activity / name / unit / value columns are read. Vehicles, freight and rail are
# laid out as wide grids and are not used by the plants we audit often enough to carry here; a custom
# line in the Ledger takes any factor by hand, with its source.
import json
import re
import sys

import openpyxl

SHEETS = [
    # sheet, group shown in the Ledger, GHG scope, value column labels are read from the row above "Activity"
    ("Fuels", "Fuels", 1),
    ("Bioenergy", "Bioenergy", 1),
    ("Refrigerant & other", "Refrigerants and gases", 1),
    ("WTT- fuels", "Well-to-tank of fuels", 3),
    ("WTT- bioenergy", "Well-to-tank of bioenergy", 3),
    ("Water supply", "Water supply", 3),
    ("Water treatment", "Water treatment", 3),
    ("Material use", "Purchased materials", 3),
    ("Waste disposal", "Waste disposal", 3),
    ("Hotel stay", "Hotel stay", 3),
]
UNIT_ALIASES = {"tonnes": "tonnes", "litres": "litres", "cubic metres": "cubic metres"}


def clean(v):
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def read_sheet(ws, group, scope):
    out = []
    rows = list(ws.iter_rows(values_only=True))
    version = year = None
    for r in rows[:8]:
        cells = [clean(x) for x in r if x not in (None, "")]
        for i, c in enumerate(cells):
            if c == "Version:" and i + 1 < len(cells):
                version = cells[i + 1]
            if c == "Year:" and i + 1 < len(cells):
                year = cells[i + 1]
    head = None  # the value columns of the table we are in: [(column, variant label)]
    activity = name = ""
    for idx, r in enumerate(rows):
        first = clean(r[0]) if r else ""
        if first == "Activity":
            above = rows[idx - 1] if idx else ()
            head = []
            for c in range(3, len(r)):
                if clean(r[c]).lower().startswith("kg co2e") and "of " not in clean(r[c]).lower():
                    head.append((c, clean(above[c]) if c < len(above) else ""))
            # Refrigerants: the Kyoto and non-Kyoto parts are not added here; the last column is the total.
            if ws.title.startswith("Refrigerant"):
                head = head[-1:]
                head = [(head[0][0], "")]
            activity = name = ""
            continue
        if head is None:
            continue
        if first.startswith(("Note", "For information")) or first.startswith("●"):
            head = None
            continue
        unit = clean(r[2]) if len(r) > 2 else ""
        if first:
            activity = first
        if len(r) > 1 and clean(r[1]):
            name = clean(r[1])
        if not unit or not name:
            continue
        # Hotels: the only row of use here is India.
        if ws.title == "Hotel stay" and name != "India":
            continue
        for col, variant in head:
            v = r[col] if col < len(r) else None
            if is_num(v):
                out.append({"g": group, "s": scope, "a": activity, "n": name, "u": unit,
                            "o": variant, "v": round(float(v), 6)})
    return out, version, year


def fuel_properties(ws):
    """Gross calorific values, kcal per kg (1 GJ/t = 238.846 kcal/kg), for reference only."""
    props = {}
    for r in ws.iter_rows(values_only=True):
        cells = [x for x in r if x not in (None, "")]
        if len(cells) >= 4:
            year_at = next((i for i, c in enumerate(cells) if c == 2026 or (isinstance(c, int) and 2000 < c < 2100)), None)
            if year_at is None or year_at + 2 >= len(cells):
                continue
            name = clean(cells[year_at - 1])
            gross = cells[year_at + 2]
            if name and is_num(gross):
                props[name] = round(gross * 238.846, 0)
    return props


def main():
    src, dest = sys.argv[1], sys.argv[2]
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    items, version, year = [], None, None
    for sheet, group, scope in SHEETS:
        got, v, y = read_sheet(wb[sheet], group, scope)
        version, year = version or v, year or y
        print(f"{sheet}: {len(got)} factors")
        items.extend(got)
    props = fuel_properties(wb["Fuel properties"])
    doc = {
        "source": f"UK Government GHG Conversion Factors for Company Reporting {year}, full set, version {version}",
        "short": f"UK DEFRA/DESNZ GHG conversion factors {year}",
        "year": year, "version": version,
        "url": f"https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-{year}",
        "gcv_kcal_per_kg": props,
        "items": items,
    }
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(items)} factors, {len(props)} fuel properties, {year} v{version}")


if __name__ == "__main__":
    main()
