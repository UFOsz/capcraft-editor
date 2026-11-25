"""Convierte palabras con tiempos + una plantilla en un archivo .ASS animado por palabra.

El formato ASS (Advanced SubStation Alpha) lo dibuja libass, que viene dentro de FFmpeg,
VLC, mpv y la mayoría de editores. Cada línea de subtítulo es UN evento; las animaciones
por palabra se hacen con etiquetas \\t(t1,t2,...) en línea, cuyos tiempos son relativos
al inicio del evento. Así una línea de 3 palabras anima cada palabra en su momento exacto.

Animaciones disponibles (campo "animation" de la plantilla):
  pop       palabra activa crece y cambia de color
  karaoke   relleno de color que avanza sílaba a sílaba (\\kf)
  box       palabra activa con "caja" de color (borde grueso)
  bounce    cada palabra aparece al decirse con rebote
  reveal    máquina de escribir: aparecen al decirse
  blur_in   aparecen desde desenfoque, la activa se colorea
  rainbow   cada palabra con un color de paleta + pop en la activa
  one_word  una sola palabra gigante en pantalla, con pop
  dim       línea semitransparente, la palabra activa al 100 %
"""
from __future__ import annotations

import re
import string
from dataclasses import dataclass

PUNCT_STRIP = ",.;:¿?¡!…\"'«»“”"


# ---------- saneamiento (los proyectos y plantillas pueden venir de archivos de terceros) ----------
HEX_RE = re.compile(r"^#?[0-9a-fA-F]{6}$")
COLOR_KEYS = ("color", "highlight", "outline_color", "shadow_color", "base_color", "active_text")
NUM_KEYS = {"size": (8, 600), "outline": (0, 60), "shadow": (0, 60), "box_outline": (0, 120), "max_words": (1, 50),
            "max_chars": (1, 200), "margin_v": (0, 5000), "pop_scale": (50, 400), "pop_ms": (1, 5000), "spacing": (-50, 200),
            "hold": (0, 10), "max_gap": (0, 10), "scale": (0.05, 20), "rotation": (-360, 360), "pos_x": (-2, 3), "pos_y": (-2, 3)}


def safe_color(v, default="#FFFFFF") -> str:
    return v if isinstance(v, str) and HEX_RE.match(v) else default


def safe_font(v, default="Arial") -> str:
    s = re.sub(r"[{}\\,;\r\n]", "", str(v or ""))[:60].strip()
    return s or default


def sanitize_template(t: dict) -> dict:
    t = dict(t or {})
    t["font"] = safe_font(t.get("font"), "Anton")
    for k in COLOR_KEYS:
        if k in t:
            t[k] = safe_color(t[k], "#FFFFFF" if k != "outline_color" and k != "shadow_color" else "#000000")
    if "palette" in t:
        t["palette"] = [safe_color(c) for c in (t["palette"] or [])[:12] if isinstance(c, str)] or ["#FFFFFF"]
    for k, (lo, hi) in NUM_KEYS.items():
        if k in t and t[k] is not None:
            try:
                t[k] = min(hi, max(lo, float(t[k])))
            except (TypeError, ValueError):
                t.pop(k)
    for k in ("max_words", "max_chars"):
        if k in t:
            t[k] = int(t[k])
    if "dim_alpha" in t and not re.match(r"^[0-9A-Fa-f]{2}$", str(t["dim_alpha"])):
        t["dim_alpha"] = "90"
    t["animation"] = t.get("animation") if t.get("animation") in (
        "pop", "karaoke", "box", "bounce", "reveal", "blur_in", "rainbow", "one_word", "dim") else "pop"
    t["position"] = t.get("position") if t.get("position") in ("lower", "center", "upper") else "lower"
    return t


# ---------- utilidades de color y tiempo ----------
def ass_color(hex_rgb: str, alpha: str = "00") -> str:
    """#RRGGBB -> &HAABBGGRR (formato ASS)."""
    h = hex_rgb.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha}{b}{g}{r}".upper()


def inline_color(hex_rgb: str) -> str:
    h = hex_rgb.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


# ---------- agrupación de palabras en líneas ----------
@dataclass
class Line:
    words: list[dict]

    @property
    def start(self) -> float:
        return self.words[0]["start"]

    @property
    def end(self) -> float:
        return self.words[-1]["end"]


def group_words(words: list[dict], max_words: int = 3, max_chars: int = 20,
                max_gap: float = 0.6) -> list[Line]:
    """Agrupa palabras en líneas. Respeta cortes manuales del editor:
    w["br"] = True  -> siempre cortar línea después de esta palabra
    w["join"] = True -> nunca cortar después de esta palabra (unir con la siguiente)"""
    lines: list[Line] = []
    cur: list[dict] = []
    for w in words:
        if cur:
            last = cur[-1]
            if last.get("br"):
                brk = True
            elif last.get("join"):
                brk = False
            else:
                chars = sum(len(x["text"]) + 1 for x in cur) + len(w["text"])
                gap = w["start"] - last["end"]
                ends_sentence = last["text"].rstrip()[-1:] in ".?!…"
                brk = len(cur) >= max_words or chars > max_chars or gap > max_gap or ends_sentence
            if brk:
                lines.append(Line(cur))
                cur = []
        cur.append(w)
    if cur:
        lines.append(Line(cur))
    return lines


# ---------- renderizador ----------
class AssRenderer:
    def __init__(self, tpl: dict, width: int = 1080, height: int = 1920,
                 keywords: list[str] | None = None):
        self.t = sanitize_template(tpl)
        self.w, self.h = int(min(8192, max(16, width))), int(min(8192, max(16, height)))
        # Las plantillas están diseñadas para 1080x1920; se escalan al video real.
        self.k = min(width, height) / 1080
        self.kv = height / 1920
        self.keywords = {self._norm(k) for k in (keywords or [])}

    @staticmethod
    def _norm(s: str) -> str:
        return s.lower().strip(PUNCT_STRIP + string.whitespace)

    def _txt(self, word: str) -> str:
        if self.t.get("strip_punctuation", True):
            word = word.strip(PUNCT_STRIP) or word
        if self.t.get("uppercase"):
            word = word.upper()
        return esc(word)

    def header(self) -> str:
        t = self.t
        align = {"lower": 2, "center": 5, "upper": 8}[t.get("position", "lower")]
        size = round(t["size"] * self.k)
        outline = round(t.get("outline", 4) * self.k, 1)
        shadow = round(t.get("shadow", 0) * self.k, 1)
        margin_v = round(t.get("margin_v", 400) * self.kv)
        if t["animation"] == "karaoke":
            primary, secondary = ass_color(t["color"]), ass_color(t.get("base_color", "#FFFFFF"))
        else:
            primary, secondary = ass_color(t["color"]), ass_color(t.get("highlight", t["color"]))
        back = ass_color(t.get("shadow_color", "#000000"), "60")
        return (
            "[Script Info]\nScriptType: v4.00+\n"
            f"PlayResX: {self.w}\nPlayResY: {self.h}\n"
            "WrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
            "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Cap,{t['font']},{size},{primary},{secondary},{ass_color(t.get('outline_color', '#000000'))},"
            f"{back},0,0,0,0,100,100,{t.get('spacing', 0)},0,1,{outline},{shadow},{align},"
            f"{round(60 * self.k)},{round(60 * self.k)},{margin_v},1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        )

    # Cada método devuelve el texto (con etiquetas) de una línea.
    def _ms(self, w: dict, line: Line) -> tuple[int, int]:
        return int((w["start"] - line.start) * 1000), int((w["end"] - line.start) * 1000)

    def _is_kw(self, w: dict) -> bool:
        return self._norm(w["text"]) in self.keywords

    def anim_pop(self, line: Line) -> str:
        t, out = self.t, []
        base, hl = inline_color(t["color"]), inline_color(t.get("highlight", "#FFE600"))
        sc, d = t.get("pop_scale", 120), t.get("pop_ms", 70)
        for w in line.words:
            a, b = self._ms(w, line)
            rest = hl if self._is_kw(w) else base
            out.append(
                f"{{\\c{rest}\\fscx100\\fscy100"
                f"\\t({a},{a + d},\\c{hl}\\fscx{sc}\\fscy{sc})"
                f"\\t({b},{b + d},\\c{rest}\\fscx100\\fscy100)}}{self._txt(w['text'])}"
            )
        return " ".join(out)

    def anim_karaoke(self, line: Line) -> str:
        out = []
        for i, w in enumerate(line.words):
            nxt = line.words[i + 1]["start"] if i + 1 < len(line.words) else w["end"]
            dur_cs = max(1, int(round((nxt - w["start"]) * 100)))
            out.append(f"{{\\kf{dur_cs}}}{self._txt(w['text'])}")
        return " ".join(out)

    def anim_box(self, line: Line) -> str:
        t, out = self.t, []
        base, box = inline_color(t["color"]), inline_color(t.get("highlight", "#FF2E88"))
        txt_on = inline_color(t.get("active_text", "#FFFFFF"))
        ol = inline_color(t.get("outline_color", "#000000"))
        ls = getattr(self, "_ls", 1.0)
        b0, b1 = round(t.get("outline", 4) * self.k * ls), round(t.get("box_outline", 16) * self.k * ls)
        for w in line.words:
            a, b = self._ms(w, line)
            out.append(
                f"{{\\c{base}\\3c{ol}\\bord{b0}"
                f"\\t({a},{a + 1},\\c{txt_on}\\3c{box}\\bord{b1})"
                f"\\t({b},{b + 1},\\c{base}\\3c{ol}\\bord{b0})}}{self._txt(w['text'])}"
            )
        return " \\h".join(out)  # espacio extra (\\h) para que las cajas no se peguen

    def anim_bounce(self, line: Line) -> str:
        t, out = self.t, []
        base, hl = inline_color(t["color"]), inline_color(t.get("highlight", t["color"]))
        d = t.get("pop_ms", 90)
        for w in line.words:
            a, b = self._ms(w, line)
            col = hl if self._is_kw(w) else base
            out.append(
                f"{{\\alpha&HFF&\\c{col}\\fscx40\\fscy40"
                f"\\t({a},{a + d},\\alpha&H00&\\fscx118\\fscy118)"
                f"\\t({a + d},{a + 2 * d},\\fscx100\\fscy100)}}{self._txt(w['text'])}"
            )
        return " ".join(out)

    def anim_reveal(self, line: Line) -> str:
        out = []
        for w in line.words:
            a, _ = self._ms(w, line)
            out.append(f"{{\\alpha&HFF&\\t({a},{a + 1},\\alpha&H00&)}}{self._txt(w['text'])}")
        return " ".join(out)

    def anim_blur_in(self, line: Line) -> str:
        t, out = self.t, []
        base, hl = inline_color(t["color"]), inline_color(t.get("highlight", t["color"]))
        d = t.get("pop_ms", 160)
        for w in line.words:
            a, b = self._ms(w, line)
            out.append(
                f"{{\\alpha&HFF&\\blur12\\c{hl}"
                f"\\t({a},{a + d},\\alpha&H00&\\blur0)"
                f"\\t({b},{b + d},\\c{base})}}{self._txt(w['text'])}"
            )
        return " ".join(out)

    def anim_rainbow(self, line: Line, offset: int = 0) -> str:
        t, out = self.t, []
        pal = t.get("palette", ["#FFFFFF"])
        sc, d = t.get("pop_scale", 118), t.get("pop_ms", 70)
        for i, w in enumerate(line.words):
            a, b = self._ms(w, line)
            c = inline_color(pal[(offset + i) % len(pal)])
            out.append(
                f"{{\\c{c}\\fscx100\\fscy100\\t({a},{a + d},\\fscx{sc}\\fscy{sc})"
                f"\\t({b},{b + d},\\fscx100\\fscy100)}}{self._txt(w['text'])}"
            )
        return " ".join(out)

    def anim_dim(self, line: Line) -> str:
        t, out = self.t, []
        dim = t.get("dim_alpha", "90")
        for w in line.words:
            a, b = self._ms(w, line)
            out.append(
                f"{{\\alpha&H{dim}&\\t({a},{a + 60},\\alpha&H00&)"
                f"\\t({b},{b + 60},\\alpha&H{dim}&)}}{self._txt(w['text'])}"
            )
        return " ".join(out)

    BOX_KEYS = ("pos_x", "pos_y", "scale", "rotation", "flip_x", "flip_y")

    def box_for(self, first_word: dict) -> dict:
        """Transformación efectiva de una línea: la de la plantilla + el ajuste propio de la línea
        (guardado en la primera palabra como w["box"])."""
        b = {k: self.t.get(k) for k in self.BOX_KEYS}
        b.update({k: v for k, v in (first_word.get("box") or {}).items() if k in self.BOX_KEYS})
        return b

    def transform_tags(self, b: dict) -> str:
        t, tags = self.t, ""
        sc = float(b.get("scale") or 1.0)
        rot = float(b.get("rotation") or 0)
        turned = abs(rot) > 0.05 or b.get("flip_x") or b.get("flip_y")
        if b.get("pos_x") is not None and b.get("pos_y") is not None:
            tags += f"\\an5\\pos({round(float(b['pos_x']) * self.w, 1)},{round(float(b['pos_y']) * self.h, 1)})"
        elif turned:
            # sin posición libre: girar alrededor del centro aproximado del texto (igual que la app)
            hgt = t["size"] * self.k * sc * 1.05
            mv = t.get("margin_v", 400) * self.kv
            y = {"lower": self.h - mv - hgt / 2, "center": self.h / 2,
                 "upper": mv + hgt / 2}[t.get("position", "lower")]
            tags += f"\\an5\\pos({round(self.w / 2, 1)},{round(y, 1)})"
        if abs(sc - 1.0) > 1e-3:
            tags += (f"\\fs{round(t['size'] * self.k * sc, 1)}\\bord{round(t.get('outline', 4) * self.k * sc, 1)}"
                     f"\\shad{round(t.get('shadow', 0) * self.k * sc, 1)}")
        if abs(rot) > 0.05:
            tags += f"\\frz{round(-rot, 2)}"  # en la app el giro positivo es horario; en ASS es antihorario
        if b.get("flip_x"):
            tags += "\\fry180"
        if b.get("flip_y"):
            tags += "\\frx180"
        return "{" + tags + "}" if tags else ""

    def render(self, words: list[dict]) -> str:
        return self.render_full(words)[0]

    def render_full(self, words: list[dict]) -> tuple[str, list[list[int]]]:
        """Devuelve (texto ASS, líneas como listas de índices de palabras)."""
        words = [dict(w, _i=i) for i, w in enumerate(words) if w.get("text", "").strip()]
        line_idx: list[list[int]] = []
        t = self.t
        anim = t["animation"]
        events = []
        if anim == "one_word":
            pal = t.get("palette", [t["color"]])
            d = t.get("pop_ms", 90)
            for i, w in enumerate(words):
                end = words[i + 1]["start"] if i + 1 < len(words) else w["end"] + 0.3
                end = min(end, w["end"] + 0.5)
                c = inline_color(pal[i % len(pal)])
                c = inline_color(t.get("highlight", "#FFE600")) if self._is_kw(w) else c
                b = self.box_for(w)
                txt = (self.transform_tags(b) + f"{{\\c{c}\\fscx70\\fscy70\\t(0,{d},\\fscx112\\fscy112)"
                       f"\\t({d},{2 * d},\\fscx100\\fscy100)}}{self._txt(w['text'])}")
                events.append((w["start"], end, txt))
                line_idx.append([w["_i"]])
        else:
            lines = group_words(words, t.get("max_words", 3), t.get("max_chars", 20),
                                t.get("max_gap", 0.6))
            fn = getattr(self, f"anim_{anim}")
            offset = 0
            for i, ln in enumerate(lines):
                nxt = lines[i + 1].start if i + 1 < len(lines) else ln.end + 0.6
                end = min(nxt, ln.end + t.get("hold", 0.35))
                b = self.box_for(ln.words[0])
                self._ls = float(b.get("scale") or 1.0)
                txt = self.transform_tags(b) + (fn(ln, offset) if anim == "rainbow" else fn(ln))
                offset += len(ln.words)
                events.append((ln.start, end, txt))
                line_idx.append([w["_i"] for w in ln.words])
        body = "".join(
            f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Cap,,0,0,0,,{txt}\n" for s, e, txt in events
        )
        return self.header() + body, line_idx


def render_ass(words: list[dict], template: dict, width: int, height: int,
               keywords: list[str] | None = None) -> str:
    return AssRenderer(template, width, height, keywords).render(words)


def words_to_srt(words: list[dict], max_words: int = 6, max_chars: int = 32) -> str:
    """SRT simple (sin animación) para plataformas que lo piden."""
    def ts(t):
        ms = int(round(t * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    out = []
    for i, ln in enumerate(group_words(words, max_words, max_chars), 1):
        text = re.sub(r"\s+", " ", " ".join(w["text"] for w in ln.words)).strip()
        out.append(f"{i}\n{ts(ln.start)} --> {ts(ln.end)}\n{text}\n")
    return "\n".join(out)
