"""Thư viện tài liệu tham khảo cho VsScience: đọc BibTeX (.bib) và RIS (.ris — Zotero, EndNote, Mendeley
xuất ra), định dạng theo APA 7 hoặc Vancouver. Dùng chung cho cite.py và md2docx.py.

Một mục định dạng là danh sách đoạn (chữ, in_nghiêng) để ghi được cả ra Word lẫn ra chữ thường.
"""

import re
import unicodedata

STYLES = ("apa", "vancouver")

# ---------------------------------------------------------------- đọc file


def _strip_braces(s: str) -> str:
    s = re.sub(r"\\[a-zA-Z]+\s*", "", s)  # lệnh LaTeX đơn giản (\textit, \&…)
    return re.sub(r"\s+", " ", s.replace("{", "").replace("}", "")).strip()


def parse_bibtex(text: str) -> list[dict]:
    entries, i, n = [], 0, len(text)
    while True:
        m = re.compile(r"@(\w+)\s*\{").search(text, i)
        if not m:
            break
        typ = m.group(1).lower()
        j = m.end()
        if typ in ("comment", "preamble", "string"):
            i = j
            continue
        depth, k = 1, j
        while k < n and depth:
            depth += {"{": 1, "}": -1}.get(text[k], 0)
            k += 1
        body = text[j : k - 1]
        i = k
        key, _, rest = body.partition(",")
        e = {"type": typ, "key": key.strip()}
        p = 0
        while p < len(rest):
            fm = re.compile(r"\s*([\w-]+)\s*=\s*").match(rest, p)
            if not fm:
                break
            name, p = fm.group(1).lower(), fm.end()
            if p < len(rest) and rest[p] == "{":
                depth, q = 1, p + 1
                while q < len(rest) and depth:
                    depth += {"{": 1, "}": -1}.get(rest[q], 0)
                    q += 1
                val, p = rest[p + 1 : q - 1], q
            elif p < len(rest) and rest[p] == '"':
                q = rest.find('"', p + 1)
                q = len(rest) if q < 0 else q
                val, p = rest[p + 1 : q], q + 1
            else:
                vm = re.compile(r"[^,]*").match(rest, p)
                val, p = vm.group(0), vm.end()
            e[name] = _strip_braces(val)
            cm = re.compile(r"\s*,").match(rest, p)
            p = cm.end() if cm else p
        if e["key"]:
            entries.append(e)
    return entries


RIS_TYPES = {"JOUR": "article", "BOOK": "book", "CHAP": "incollection", "CONF": "inproceedings", "CPAPER": "inproceedings", "THES": "phdthesis", "RPRT": "techreport", "ELEC": "online", "WEB": "online"}


def parse_ris(text: str) -> list[dict]:
    entries, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^([A-Z][A-Z0-9])  - ?(.*)$", line)
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "TY":
            cur = {"type": RIS_TYPES.get(val, "misc"), "_authors": [], "_editors": []}
        elif cur is None:
            continue
        elif tag == "ER":
            if cur["_authors"]:
                cur["author"] = " and ".join(cur["_authors"])
            if cur["_editors"]:
                cur["editor"] = " and ".join(cur["_editors"])
            cur.pop("_authors"), cur.pop("_editors")
            first = (cur.get("author", "x").split(",")[0].split()[-1:] or ["x"])[0]
            cur.setdefault("key", re.sub(r"\W", "", fold(first)) + cur.get("year", ""))
            entries.append(cur)
            cur = None
        elif tag in ("AU", "A1"):
            cur["_authors"].append(val)
        elif tag in ("ED", "A2", "A3") and cur["type"] in ("incollection", "inproceedings"):
            cur["_editors"].append(val)
        elif tag in ("PY", "Y1", "DA"):
            y = re.search(r"\d{4}", val)
            if y:
                cur.setdefault("year", y.group(0))
        elif tag in ("TI", "T1"):
            cur["title"] = val
        elif tag in ("JO", "JF", "JA", "T2"):
            if cur["type"] in ("incollection", "inproceedings"):
                cur.setdefault("booktitle", val)
            else:
                cur.setdefault("journal", val)
        elif tag == "VL":
            cur["volume"] = val
        elif tag == "IS":
            cur["number"] = val
        elif tag == "SP":
            cur["_sp"] = val
            cur["pages"] = val
        elif tag == "EP":
            cur["pages"] = f"{cur.get('_sp', '')}--{val}" if cur.get("_sp") else val
        elif tag == "DO":
            cur["doi"] = val
        elif tag == "UR":
            cur.setdefault("url", val)
        elif tag == "PB":
            cur["publisher"] = val
        elif tag == "ID":
            cur["key"] = val
    for e in entries:
        e.pop("_sp", None)
    return entries


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as f:
        text = f.read()
    if path.lower().endswith(".ris") or re.search(r"^TY  - ", text, re.M):
        return parse_ris(text)
    return parse_bibtex(text)


# ---------------------------------------------------------------- tên tác giả


def fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").replace("đ", "d").replace("Đ", "D")


VI_MARKS = re.compile(r"[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]", re.I)


def split_authors(field: str) -> list[str]:
    return [a.strip() for a in re.split(r"\s+and\s+", field or "") if a.strip()]


def name_parts(name: str, vietnamese: bool) -> tuple[str, str, bool]:
    """(họ, tên đệm+tên, là tên Việt viết đủ). Tên Việt không có dấu phẩy giữ nguyên thứ tự."""
    if name.startswith("{") or name.endswith("}"):
        return name.strip("{}"), "", True  # tên tổ chức
    if "," in name:
        last, first = [x.strip() for x in name.split(",", 1)]
        return last, first, False
    if vietnamese or VI_MARKS.search(name):
        return name, "", True
    parts = name.split()
    return (parts[-1], " ".join(parts[:-1]), False) if len(parts) > 1 else (name, "", True)


def initials(first: str, sep: str = ". ", end: str = ".") -> str:
    bits = [p for p in re.split(r"[\s.]+", first) if p]
    out = []
    for b in bits:
        if "-" in b:
            out.append("-".join(x[0].upper() for x in b.split("-") if x))
        else:
            out.append(b[0].upper())
    return (sep.join(out) + end) if out else ""


def is_vi(e: dict) -> bool:
    return (e.get("language") or e.get("langid") or "").lower() in ("vietnamese", "vi", "tiếng việt")


def apa_name(name: str, vi: bool) -> str:
    last, first, full = name_parts(name, vi)
    return last if full or not first else f"{last}, {initials(first)}"


def vancouver_name(name: str, vi: bool) -> str:
    last, first, full = name_parts(name, vi)
    return last if full or not first else f"{last} {initials(first, '', '')}"


def short_name(name: str, vi: bool) -> str:
    last, _first, _full = name_parts(name, vi)
    return last


# ---------------------------------------------------------------- định dạng


def _pages(p: str) -> str:
    return (p or "").replace("--", "–").replace("-", "–")


def _doi(e: dict) -> str:
    d = (e.get("doi") or "").strip()
    if d:
        return d if d.startswith("http") else f"https://doi.org/{d.removeprefix('doi:')}"
    return (e.get("url") or "").strip()


def format_apa(e: dict) -> list[tuple[str, bool]]:
    vi = is_vi(e)
    names = [apa_name(a, vi) for a in split_authors(e.get("author", ""))]
    if not names:
        auth = ""
    elif len(names) == 1:
        auth = names[0]
    elif len(names) == 2 and "," not in names[0]:
        auth = f"{names[0]} & {names[1]}"  # tên Việt viết đủ: không cần dấu phẩy trước &
    elif len(names) <= 20:
        auth = ", ".join(names[:-1]) + ", & " + names[-1]
    else:
        auth = ", ".join(names[:19]) + ", … " + names[-1]
    year = e.get("year") or "n.d."
    title = (e.get("title") or "").rstrip(".")
    typ = e.get("type", "misc")
    seg: list[tuple[str, bool]] = []
    head = f"{auth} ({year}). " if auth else ""
    if typ == "article":
        seg += [(f"{head}{title}. ", False)]
        jour = e.get("journal", "")
        if jour:
            seg.append((jour, True))
            vol = e.get("volume", "")
            if vol:
                seg += [(", ", False), (vol, True)]
            if e.get("number"):
                seg.append((f"({e['number']})", False))
            if e.get("pages"):
                seg.append((f", {_pages(e['pages'])}", False))
            seg.append((". ", False))
    elif typ in ("book", "phdthesis", "mastersthesis", "techreport"):
        seg += [(head, False), (title, True)]
        if e.get("edition"):
            seg.append((f" ({e['edition']} ed.)", False))
        seg.append((". ", False))
        pub = e.get("publisher") or e.get("school") or e.get("institution")
        if pub:
            seg.append((f"{pub}. ", False))
    elif typ in ("incollection", "inproceedings", "inbook"):
        seg += [(f"{head}{title}. ", False)]
        eds = [apa_name(a, vi) for a in split_authors(e.get("editor", ""))]
        seg.append(("In ", False))
        if eds:
            seg.append((f"{' & '.join(eds)} (Ed{'s' if len(eds) > 1 else ''}.), ", False))
        seg.append((e.get("booktitle", ""), True))
        if e.get("pages"):
            seg.append((f" (pp. {_pages(e['pages'])})", False))
        seg.append((". ", False))
        if e.get("publisher"):
            seg.append((f"{e['publisher']}. ", False))
    else:
        seg += [(head, False), (title, True), (". ", False)]
        if e.get("howpublished"):
            seg.append((f"{e['howpublished']}. ", False))
    link = _doi(e)
    if link:
        seg.append((link, False))
    seg = [(t, i) for t, i in seg if t]
    if seg:
        seg[-1] = (seg[-1][0].rstrip(), seg[-1][1])
    return seg


def format_vancouver(e: dict) -> list[tuple[str, bool]]:
    vi = is_vi(e)
    names = [vancouver_name(a, vi) for a in split_authors(e.get("author", ""))]
    auth = ", ".join(names[:6]) + (", et al" if len(names) > 6 else "")
    title = (e.get("title") or "").rstrip(".")
    year = e.get("year", "")
    typ = e.get("type", "misc")
    out = f"{auth}. " if auth else ""
    if typ == "article":
        out += f"{title}. {e.get('journal', '')}. {year}"
        if e.get("volume"):
            out += f";{e['volume']}"
        if e.get("number"):
            out += f"({e['number']})"
        if e.get("pages"):
            out += f":{_pages(e['pages']).replace('–', '-')}"
        out += "."
    elif typ in ("book", "phdthesis", "techreport"):
        pub = e.get("publisher") or e.get("school") or e.get("institution") or ""
        out += f"{title}. {e.get('address', '') + ': ' if e.get('address') else ''}{pub}{'; ' if pub else ''}{year}."
    elif typ in ("incollection", "inproceedings", "inbook"):
        eds = [vancouver_name(a, vi) for a in split_authors(e.get("editor", ""))]
        out += f"{title}. In: {', '.join(eds) + (', editors. ' if len(eds) > 1 else ', editor. ') if eds else ''}{e.get('booktitle', '')}. {e.get('publisher', '')}{'; ' if e.get('publisher') else ''}{year}."
        if e.get("pages"):
            out += f" p. {_pages(e['pages']).replace('–', '-')}."
    else:
        out += f"{title}. {year}."
    if e.get("doi"):
        out += f" doi:{e['doi'].removeprefix('https://doi.org/')}"
    elif e.get("url"):
        out += f" Available from: {e['url']}"
    return [(out, False)]


def format_entry(e: dict, style: str) -> list[tuple[str, bool]]:
    return format_vancouver(e) if style == "vancouver" else format_apa(e)


def plain(segments: list[tuple[str, bool]]) -> str:
    return "".join(t for t, _ in segments)


def intext_apa(entries: list[dict], locators: list[str]) -> str:
    """(Nguyễn Văn An, 2020; Smith & Lee, 2019, tr. 12)"""
    parts = []
    for e, loc in zip(entries, locators):
        vi = is_vi(e)
        names = [short_name(a, vi) for a in split_authors(e.get("author", ""))] or [e.get("title", e["key"])[:30]]
        who = names[0] if len(names) == 1 else f"{names[0]} & {names[1]}" if len(names) == 2 else f"{names[0]} et al."
        parts.append(f"{who}, {e.get('year') or 'n.d.'}{', ' + loc if loc else ''}")
    return "(" + "; ".join(parts) + ")"


def sort_apa(entries: list[dict]) -> list[dict]:
    def k(e):
        a = split_authors(e.get("author", ""))
        first = name_parts(a[0], is_vi(e))[0] if a else e.get("title", "")
        return (fold(first).lower(), e.get("year", ""))

    return sorted(entries, key=k)


def problems(e: dict) -> list[str]:
    need = {"article": ["author", "title", "journal", "year"], "book": ["author", "title", "publisher", "year"], "incollection": ["author", "title", "booktitle", "year"], "inproceedings": ["author", "title", "booktitle", "year"]}.get(e.get("type", ""), ["title", "year"])
    miss = [f for f in need if not e.get(f)]
    if e.get("type") == "article" and not (e.get("doi") or e.get("url")):
        miss.append("doi")
    return miss
