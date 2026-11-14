#!/usr/bin/env python3
"""Builds areas.json from the two original OMB Bulletin 23-01 delineation files beside this script.

Standard library only. Run from the repository root:

    python3 -I docs/reference/geography/omb-23-01/build.py          # writes areas.json
    python3 -I docs/reference/geography/omb-23-01/build.py --check  # fails when areas.json differs

list1_2023.xlsx gives each core-based statistical area (CBSA) with its code, title, metro or micro type and its
counties. list2_2023.xlsx gives each CBSA's principal cities. Nothing is added, guessed or geocoded: a CBSA is listed
with exactly the counties and principal cities the files name.
"""
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
# The two-letter USPS code of each state FIPS code the files use (50 states, DC and Puerto Rico).
STATE = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR",
}


def rows(path: Path):
    """Every row of the first sheet as a list of cell strings, in column order."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        for row in sheet.iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                index = 0
                for ch in col:
                    index = index * 26 + ord(ch) - 64
                v = c.find("m:v", NS)
                inline = c.find("m:is", NS)
                if c.get("t") == "s" and v is not None:
                    text = shared[int(v.text)]
                elif inline is not None:
                    text = "".join(t.text or "" for t in inline.iter(f"{{{NS['m']}}}t"))
                else:
                    text = v.text if v is not None else ""
                cells[index - 1] = (text or "").strip()
            yield [cells.get(i, "") for i in range(max(cells) + 1)] if cells else []


def table(path: Path, first: str):
    """The data rows under the header row whose first cell is `first`, as dicts by header name."""
    header = None
    for r in rows(path):
        if header is None:
            if r and r[0] == first:
                header = r
            continue
        if not r or not r[0] or not r[0].isdigit():
            continue
        yield dict(zip(header, r + [""] * (len(header) - len(r))))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    list1, list2 = HERE / "list1_2023.xlsx", HERE / "list2_2023.xlsx"
    areas = {}
    for r in table(list1, "CBSA Code"):
        code = r["CBSA Code"]
        kind = {"Metropolitan Statistical Area": "metro", "Micropolitan Statistical Area": "micro"}[
            r["Metropolitan/Micropolitan Statistical Area"]
        ]
        a = areas.setdefault(code, {"code": code, "title": r["CBSA Title"], "type": kind, "counties": [], "principalCities": []})
        assert a["title"] == r["CBSA Title"] and a["type"] == kind, code
        fips = r["FIPS State Code"] + r["FIPS County Code"]
        a["counties"].append({"fips": fips, "name": r["County/County Equivalent"], "state": STATE[r["FIPS State Code"]]})
    for r in table(list2, "CBSA Code"):
        a = areas[r["CBSA Code"]]
        assert a["title"] == r["CBSA Title"], r["CBSA Code"]
        a["principalCities"].append({"name": r["Principal City Name"], "state": STATE[r["FIPS State Code"]]})
    for a in areas.values():
        a["counties"].sort(key=lambda c: c["fips"])
        a["principalCities"].sort(key=lambda c: (c["state"], c["name"]))
        a["states"] = sorted({c["state"] for c in a["counties"]})
    return {
        "release": "OMB Bulletin 23-01 (July 21, 2023)",
        "releaseKey": "omb-23-01",
        "sources": [
            {"file": "list1_2023.xlsx", "sha256": sha256(list1)},
            {"file": "list2_2023.xlsx", "sha256": sha256(list2)},
        ],
        "areas": [areas[k] for k in sorted(areas)],
    }


if __name__ == "__main__":
    out = HERE / "areas.json"
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if out.read_text(encoding="utf-8") != text:
            sys.exit("areas.json does not match the OMB source files; run build.py")
        print("areas.json matches the OMB source files")
    else:
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out}")
