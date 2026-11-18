#!/usr/bin/env python3
"""Renders a DXF drawing (model space, else its fullest sheet) to SVG on a white page: dxf2svg.py IN.dxf OUT.svg

Used by the Explorer plugin for DWG/DXF preview (DWG is converted to DXF with
LibreDWG's dwg2dxf first). Needs the `ezdxf` package (Debian: python3-ezdxf).
"""
import io
import re
import sys

from ezdxf import bbox, recover
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
from ezdxf.sections import table as _table

# LibreDWG can emit table records (layers, styles…) without a name, which makes
# ezdxf reject the whole file. A nameless record can't be referenced anyway: skip it.
_append = _table.Table._append


def _append_named(self, entry):
    if isinstance(entry.dxf.get('name'), str):
        _append(self, entry)


_table.Table._append = _append_named

PAGE_LONG_SIDE_MM = 1000


GROUP_CODE = re.compile(rb'^\s*-?\d{1,4}\s*$')


def repaired(src: str) -> io.BytesIO:
    """LibreDWG writes some text values (MTEXT, embedded objects) with raw line
    breaks, which shifts every following code/value pair. A DXF code line is
    always a small integer, so a line that is not one where a code is due is the
    tail of the previous value: glue it back."""
    out = []
    with open(src, 'rb') as f:
        lines = f.read().splitlines()
    i = 0
    while i + 1 < len(lines):
        code, value = lines[i], lines[i + 1]
        if not GROUP_CODE.match(code) and out:
            out[-1] += b' ' + code
            i += 1
            continue
        out.append(code.strip())
        out.append(value)
        i += 2
    return io.BytesIO(b'\r\n'.join(out) + b'\r\n')


def main(src: str, dst: str) -> int:
    try:
        doc, _auditor = recover.readfile(src)
    except Exception:  # noqa: BLE001 - any parse failure gets one repair attempt
        doc, _auditor = recover.read(repaired(src))
    # Model space first; drawings kept only on sheets fall back to the fullest sheet.
    target, box = None, None
    candidates = [doc.modelspace()] + sorted(
        (lay for lay in doc.layouts if lay.is_any_paperspace), key=len, reverse=True)
    for lay in candidates:
        b = bbox.extents(lay, fast=True)
        if b.has_data and b.size.x > 0 and b.size.y > 0:
            target, box = lay, b
            break
    if target is None:
        print('empty drawing', file=sys.stderr)
        return 3
    w, h = max(box.size.x, 1e-6), max(box.size.y, 1e-6)
    k = PAGE_LONG_SIDE_MM / max(w, h)
    page = layout.Page(max(w * k, 10), max(h * k, 10), layout.Units.mm, margins=layout.Margins.all(4))
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        lineweight_scaling=0.5,
    )
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(target, finalize=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(backend.get_string(page, settings=layout.Settings(fit_page=True)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
