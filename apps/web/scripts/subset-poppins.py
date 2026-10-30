"""Generate Latin subsets and verify preserved glyphs, metrics, and license metadata."""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
root=Path(__file__).resolve().parents[1] / 'src/ui/fonts'
ranges='U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD'
for src in sorted(root.glob('Poppins-*.woff2')):
    if '-Latin.' in src.name: continue
    dest=src.with_name(src.stem+'-Latin.woff2')
    subset.main([str(src),'--output-file='+str(dest),'--flavor=woff2','--unicodes='+ranges,'--layout-features=*','--name-IDs=*','--name-languages=*','--name-legacy','--notdef-outline','--glyph-names'])
    original=TTFont(src); reduced=TTFont(dest)
    fullmap=original.getBestCmap(); smallmap=reduced.getBestCmap()
    a=original.getGlyphSet(); b=reduced.getGlyphSet()
    assert set(smallmap) == set(fullmap).intersection(subset.parse_unicodes(ranges))
    for code, name in smallmap.items():
        oldname=fullmap[code]
        assert original['hmtx'][oldname] == reduced['hmtx'][name]
        pen_a=RecordingPen(); pen_b=RecordingPen()
        a[oldname].draw(pen_a); b[name].draw(pen_b)
        assert pen_a.value == pen_b.value, (src, code)
    for table in ['hhea','OS/2']:
        for metric in ['ascent','descent','lineGap','sTypoAscender','sTypoDescender','sTypoLineGap','usWinAscent','usWinDescent']:
            assert getattr(original[table],metric,None)==getattr(reduced[table],metric,None)
    for nid in [0,13,14]:
        assert [(r.platformID,r.platEncID,r.langID,r.toUnicode()) for r in original['name'].names if r.nameID==nid] == [(r.platformID,r.platEncID,r.langID,r.toUnicode()) for r in reduced['name'].names if r.nameID==nid]
    print(src.name,src.stat().st_size,dest.stat().st_size,len(smallmap),'glyph outlines, advances, vertical metrics, license metadata match')
