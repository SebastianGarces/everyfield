"""Rebuild EF Figures from DM Sans (OFL, Reserved Font Name rules: the derived family has a new name).
DM Sans has no tnum feature, so every digit gets the widest digit advance and its outline is re-centred.
Run from packages/domain with: python3 scripts/make-ef-figures.py   (needs fontTools)."""
from pathlib import Path
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parent.parent / "src" / "documents" / "fonts"
for w in ("Regular", "Medium", "Bold"):
    f = TTFont(FONTS / f"DMSans-{w}.ttf")
    cm, hm, gl = f.getBestCmap(), f["hmtx"], f["glyf"]
    adv = max(hm[cm[ord(c)]][0] for c in "0123456789")
    for c in "0123456789":
        n = cm[ord(c)]
        a, lsb = hm[n]
        g = gl[n]
        dx = (adv - a) // 2
        if g.numberOfContours:
            g.coordinates.translate((dx, 0))
            g.recalcBounds(gl)
        hm[n] = (adv, lsb + dx)
    for rec in f["name"].names:
        if rec.nameID in (1, 4, 16):
            rec.string = str(rec.toUnicode()).replace("DM Sans", "EF Figures")
        if rec.nameID == 6:
            rec.string = f"EFFigures-{w}"
    f.save(FONTS / f"EFFigures-{w}.ttf")
