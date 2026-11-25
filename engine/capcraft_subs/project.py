"""Motor multipista de Capcraft Editor v0.3.

Modelo de proyecto (JSON):
  canvas: {width, height, fps, background}
  media:  {id: {path, type: video|image|audio, duration, width, height, has_audio}}
  tracks: [{id, kind: video|audio|text, main, hidden, muted, clips: [...]}]   (orden visual: arriba -> abajo)
  subtitles: {words: [...tiempo de la línea de tiempo...], template, keywords, enabled}

Clip de video/imagen: start, dur, mediaId, in, speed, volume, muted, fit, x, y, scale, rotation, opacity,
                      flipH, flipV, color{brightness,contrast,saturation,hue,temperature}, filter,
                      animIn{type,dur}, animOut{type,dur}, fadeIn, fadeOut
Clip de audio:        start, dur, mediaId, in, speed, volume, fadeIn, fadeOut
Clip de texto:        start, dur, text, style{font,size,color,outline,outline_color,shadow,box,box_color,spacing},
                      x, y, scale, rotation, animIn, animOut
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
from pathlib import Path

from .ass_render import AssRenderer, ass_color, ass_time, esc, inline_color, safe_color, safe_font

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ------------------------------------------------------------------ filtros de color (FFmpeg)
FILTERS = {
    "none": "",
    "bn": "hue=s=0",
    "sepia": "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
    "calido": "colorbalance=rs=.12:gs=.04:bs=-.12,eq=saturation=1.15",
    "frio": "colorbalance=rs=-.10:gs=.02:bs=.14",
    "vivido": "eq=saturation=1.5:contrast=1.1",
    "vintage": "curves=preset=vintage",
    "cine": "eq=contrast=1.15:saturation=0.85,colorbalance=rs=-.04:bs=.08",
    "desvanecido": "eq=contrast=0.85:brightness=0.05:saturation=0.8",
    "dramatico": "eq=contrast=1.35:saturation=1.1:brightness=-0.03",
}


def _e(expr: str) -> str:
    """Escapa comas dentro de expresiones de FFmpeg."""
    return expr.replace(",", "\\,")


def ease_in_expr(p: str) -> str:   # p entre 0 y 1
    return f"pow({p},3)"


def ease_out_expr(p: str) -> str:
    return f"(1-pow(1-({p}),3))"


def clamp01(x: str) -> str:
    return f"min(max({x},0),1)"


def atempo_chain(speed: float) -> list[str]:
    out, s = [], float(speed)
    while s > 2.0:
        out.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        out.append("atempo=0.5"); s /= 0.5
    if abs(s - 1.0) > 1e-3:
        out.append(f"atempo={s:.4f}")
    return out


def project_duration(p: dict) -> float:
    end = 0.0
    for tr in p.get("tracks", []):
        for c in tr.get("clips", []):
            end = max(end, float(c["start"]) + float(c["dur"]))
    return round(max(end, 0.1), 3)


def fit_size(media: dict, clip: dict, W: int, H: int) -> tuple[float, float]:
    mw, mh = media.get("width") or W, media.get("height") or H
    f = max(W / mw, H / mh) if clip.get("fit") == "cover" else min(W / mw, H / mh)
    s = f * float(clip.get("scale", 1) or 1)
    return mw * s, mh * s


def color_chain(clip: dict) -> list[str]:
    c = clip.get("color") or {}
    out = []
    b, ct, sat = float(c.get("brightness", 0)), float(c.get("contrast", 1)), float(c.get("saturation", 1))
    if abs(b) > 1e-3 or abs(ct - 1) > 1e-3 or abs(sat - 1) > 1e-3:
        out.append(f"eq=brightness={b:.3f}:contrast={ct:.3f}:saturation={sat:.3f}")
    h = float(c.get("hue", 0))
    if abs(h) > 0.5:
        out.append(f"hue=h={h:.1f}")
    tmp = float(c.get("temperature", 0))
    if abs(tmp) > 1e-3:
        out.append(f"colorbalance=rs={tmp * .15:.3f}:bs={-tmp * .15:.3f}")
    f = FILTERS.get(clip.get("filter") or "none", "")
    if f:
        out.append(f)
    return out


# ------------------------------------------------------------------ ASS: subtítulos + textos
TXT_STYLE = ("Style: Txt,Arial,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n")


def text_event(c: dict, W: int, H: int, layer: int) -> str:
    st = c.get("style") or {}
    sc = float(c.get("scale", 1) or 1)
    size = float(st.get("size", 90)) * sc
    x, y = float(c.get("x", 0.5)) * W, float(c.get("y", 0.5)) * H
    dur_ms = int(float(c["dur"]) * 1000)
    tags = [f"\\fn{safe_font(st.get('font'), 'Anton')}", f"\\fs{size:.1f}", f"\\c{inline_color(safe_color(st.get('color'), '#FFFFFF'))}"]
    if st.get("box"):
        tags += [f"\\3c{inline_color(safe_color(st.get('box_color'), '#000000'))}", f"\\bord{size * 0.28:.1f}", "\\shad0"]
    else:
        tags += [f"\\3c{inline_color(safe_color(st.get('outline_color'), '#000000'))}", f"\\bord{float(st.get('outline', 0)) * sc:.1f}",
                 f"\\shad{float(st.get('shadow', 0)) * sc:.1f}", f"\\4c{inline_color(safe_color(st.get('shadow_color'), '#000000'))}"]
    if st.get("spacing"):
        tags.append(f"\\fsp{float(st['spacing']):.1f}")
    rot = float(c.get("rotation", 0) or 0)
    if abs(rot) > 0.05:
        tags.append(f"\\frz{-rot:.2f}")
    if c.get("flipH"):
        tags.append("\\fry180")

    ai, ao = c.get("animIn") or {}, c.get("animOut") or {}
    ti, to = ai.get("type", "none"), ao.get("type", "none")
    di, do = int(float(ai.get("dur", 0.4)) * 1000), int(float(ao.get("dur", 0.4)) * 1000)
    pos = f"\\an5\\pos({x:.1f},{y:.1f})"
    fad_in = di if ti == "fade" else 0
    fad_out = do if to == "fade" else 0
    if fad_in or fad_out:
        tags.append(f"\\fad({fad_in},{fad_out})")
    slide = {"slide_up": (0, 1), "slide_down": (0, -1), "slide_left": (1, 0), "slide_right": (-1, 0)}
    if ti in slide:
        dx, dy = slide[ti]
        pos = f"\\an5\\move({x + dx * W * 0.35:.1f},{y + dy * H * 0.12:.1f},{x:.1f},{y:.1f},0,{di})"
        tags.append(f"\\alpha&HFF&\\t(0,{max(1, di // 2)},\\alpha&H00&)")
    elif to in slide:
        dx, dy = slide[to]
        pos = f"\\an5\\move({x:.1f},{y:.1f},{x - dx * W * 0.35:.1f},{y - dy * H * 0.12:.1f},{dur_ms - do},{dur_ms})"
    if ti == "pop":
        tags.append(f"\\fscx20\\fscy20\\t(0,{int(di * .6)},\\fscx112\\fscy112)\\t({int(di * .6)},{di},\\fscx100\\fscy100)")
    if ti == "zoom_out":
        tags.append(f"\\fscx170\\fscy170\\alpha&HFF&\\t(0,{di},\\fscx100\\fscy100\\alpha&H00&)")
    if to == "pop":
        tags.append(f"\\t({dur_ms - do},{dur_ms},\\fscx0\\fscy0)")
    if to == "zoom_out":
        tags.append(f"\\t({dur_ms - do},{dur_ms},\\fscx170\\fscy170\\alpha&HFF&)")

    raw = str(c.get("text", "")).replace("\r", "")
    if ti == "typewriter":
        chars = [ch for ch in raw]
        visible = [i for i, ch in enumerate(chars) if not ch.isspace()]
        n = max(1, len(visible))
        out, k = [], 0
        for ch in chars:
            if ch == "\n":
                out.append("\\N"); continue
            if ch.isspace():
                out.append(ch); continue
            t0 = int(di * k / n); k += 1
            out.append(f"{{\\alpha&HFF&\\t({t0},{t0 + 1},\\alpha&H00&)}}{esc(ch)}")
        body = "".join(out)
    else:
        body = esc(raw).replace("\n", "\\N")
    return (f"Dialogue: {layer},{ass_time(float(c['start']))},{ass_time(float(c['start']) + float(c['dur']))},"
            f"Txt,,0,0,0,,{{{pos}{''.join(tags)}}}{body}\n")


def build_ass(p: dict, builtin_templates: dict) -> tuple[str, list]:
    W, H = canvas_dims(p)
    sub = p.get("subtitles") or {}
    tpl = sub.get("template") or builtin_templates.get("hormozi_pop") or next(iter(builtin_templates.values()))
    r = AssRenderer(tpl, W, H, sub.get("keywords") or [])
    words = sub.get("words") or []
    if words and sub.get("enabled", True):
        full, lines = r.render_full(words)
    else:
        full, lines = r.header(), []
    # estilo de textos y eventos (los subtítulos quedan encima: capa 10)
    full = full.replace("\n\n[Events]", "\n" + TXT_STYLE.rstrip("\n") + "\n\n[Events]", 1)
    full = full.replace("Dialogue: 0,", "Dialogue: 10,")
    events = []
    tracks = [t for t in p.get("tracks", []) if t.get("kind") == "text" and not t.get("hidden")]
    for layer, tr in enumerate(reversed(tracks)):  # la pista de abajo se dibuja primero
        for c in tr.get("clips", []):
            if str(c.get("text", "")).strip():
                events.append(text_event(c, W, H, layer))
    return full + "".join(events), lines


# ------------------------------------------------------------------ FFmpeg: video completo
def anim_terms(clip: dict, start: float, dur: float, W: int, H: int):
    """Devuelve (expr_x_extra, expr_y_extra, zoom_expr|None, zoom_max, fades) para las animaciones."""
    ai, ao = clip.get("animIn") or {}, clip.get("animOut") or {}
    ti, to = ai.get("type", "none"), ao.get("type", "none")
    di, do = max(0.05, float(ai.get("dur", 0.5))), max(0.05, float(ao.get("dur", 0.5)))
    di, do = min(di, dur), min(do, dur)
    xs, ys, zoom, zmax, fades = [], [], [], 1.0, []
    p_in = clamp01(f"(t-{start:.3f})/{di:.3f}")
    p_out = clamp01(f"(t-{start + dur - do:.3f})/{do:.3f}")
    slide = {"slide_left": (W, 0), "slide_right": (-W, 0), "slide_up": (0, H), "slide_down": (0, -H)}
    if ti in slide:
        dx, dy = slide[ti]
        if dx: xs.append(f"{dx}*(1-{ease_out_expr(p_in)})")
        if dy: ys.append(f"{dy}*(1-{ease_out_expr(p_in)})")
    if to in slide:
        dx, dy = slide[to]
        if dx: xs.append(f"{-dx}*{ease_in_expr(p_out)}")
        if dy: ys.append(f"{-dy}*{ease_in_expr(p_out)}")
    # zoom: t es local al clip dentro de la cadena del clip
    lp_in, lp_out = clamp01(f"t/{di:.3f}"), clamp01(f"(t-{dur - do:.3f})/{do:.3f}")
    if ti == "zoom_in":
        zoom.append(f"(0.6+0.4*{ease_out_expr(lp_in)})")
    if ti == "zoom_out":
        zoom.append(f"(1.4-0.4*{ease_out_expr(lp_in)})"); zmax = 1.4
    if to == "zoom_in":
        zoom.append(f"(1+0.4*{ease_in_expr(lp_out)})"); zmax = 1.4
    if to == "zoom_out":
        zoom.append(f"(1-0.4*{ease_in_expr(lp_out)})")
    if ti in ("fade", "zoom_in", "zoom_out"):
        fades.append(f"fade=t=in:st=0:d={di:.3f}:alpha=1")
    if to in ("fade", "zoom_in", "zoom_out"):
        fades.append(f"fade=t=out:st={dur - do:.3f}:d={do:.3f}:alpha=1")
    return "+".join(xs), "+".join(ys), ("*".join(zoom) if zoom else None), zmax, fades


def canvas_dims(p: dict) -> tuple[int, int]:
    c = p.get("canvas") or {}
    return int(min(8192, max(16, float(c.get("width", 1080))))), int(min(8192, max(16, float(c.get("height", 1920)))))


def local_file(path) -> str:
    """Solo archivos locales existentes (nada de URLs ni protocolos especiales de FFmpeg)."""
    s = str(path or "")
    if not s or "://" in s or "\x00" in s or s.startswith(("\\\\", "//")) or not Path(s).is_file():
        raise ValueError(f"Archivo no disponible: {Path(s).name}")
    return s


def build_export(p: dict, ass_file: str | None, out: str, quality: str = "alta", res_scale: float = 1.0,
                 audio_only: bool = False, include_audio_tracks: bool = True, video_audio: bool = True):
    W, H = canvas_dims(p)
    fps = min(120.0, max(1.0, float(p["canvas"].get("fps", 30))))
    res_scale = min(1.0, max(0.1, float(res_scale)))
    total = project_duration(p)
    media = p.get("media", {})
    inputs: list[str] = []
    fc: list[str] = []
    audio_labels: list[str] = []
    n_in = 0

    def add_input(args: list[str]) -> int:
        nonlocal n_in
        i = args.index("-i")
        args[i + 1] = local_file(args[i + 1])
        args = args[:i] + ["-protocol_whitelist", "file"] + args[i:]
        inputs.extend(args)
        n_in += 1
        return n_in - 1

    bg = safe_color(p["canvas"].get("background"), "#000000").lstrip("#")
    if not audio_only:
        fc.append(f"color=c=0x{bg}:s={W}x{H}:r={fps:g}:d={total:.3f},format=rgba[base0]")
    cur = "base0"
    vid_tracks = [t for t in p.get("tracks", []) if t.get("kind") == "video"]
    # orden de dibujo: de la pista de abajo (principal) a la de arriba
    for tr in reversed(vid_tracks):
        for c in sorted(tr.get("clips", []), key=lambda c: c["start"]):
            m = media.get(c.get("mediaId"))
            if not m:
                continue
            start, dur = float(c["start"]), float(c["dur"])
            speed = float(c.get("speed", 1) or 1) if m["type"] == "video" else 1.0
            if m["type"] == "image":
                k = add_input(["-loop", "1", "-framerate", f"{fps:g}", "-t", f"{dur + 0.1:.3f}", "-i", m["path"]])
            else:
                k = add_input(["-ss", f"{float(c.get('in', 0)):.3f}", "-t", f"{dur * speed + 0.1:.3f}", "-i", m["path"]])
            # ---- audio del clip de video
            if (m["type"] == "video" and m.get("has_audio") and video_audio and not c.get("muted")
                    and not tr.get("muted") and float(c.get("volume", 1)) > 0):
                audio_labels.append(audio_chain(fc, k, c, start, dur, speed))
            if audio_only or tr.get("hidden"):
                continue
            # ---- imagen
            bw, bh = fit_size(m, c, W, H)
            bw, bh = max(2, int(round(bw / 2)) * 2), max(2, int(round(bh / 2)) * 2)
            ch = [f"[{k}:v]setpts=(PTS-STARTPTS)/{speed:.4f}", f"fps={fps:g}", f"scale={bw}:{bh}"]
            if c.get("flipH"): ch.append("hflip")
            if c.get("flipV"): ch.append("vflip")
            ch += color_chain(c)
            ch.append("format=rgba")
            xe, ye, zoom, zmax, fades = anim_terms(c, start, dur, W, H)
            if zoom:
                pw, ph = int(math.ceil(bw * zmax / 2) * 2), int(math.ceil(bh * zmax / 2) * 2)
                ch.append(f"scale=w='{_e(f'iw*{zoom}')}':h='{_e(f'ih*{zoom}')}':eval=frame")
                ch.append(f"pad=w={pw}:h={ph}:x='(ow-iw)/2':y='(oh-ih)/2':color=0x00000000:eval=frame")
            rot = float(c.get("rotation", 0) or 0)
            if abs(rot) > 0.05:
                a = rot * math.pi / 180
                ch.append(f"rotate=a={a:.5f}:c=none:ow='rotw({a:.5f})':oh='roth({a:.5f})'")
            op = float(c.get("opacity", 1))
            if op < 0.999:
                ch.append(f"colorchannelmixer=aa={op:.3f}")
            ch += fades
            ch.append(f"trim=duration={dur:.3f}")
            ch.append(f"setpts=PTS+{start:.3f}/TB")
            fc.append(",".join(ch) + f"[c{k}]")
            cx = f"{W / 2 + float(c.get('x', 0)) * W:.2f}"
            cy = f"{H / 2 + float(c.get('y', 0)) * H:.2f}"
            X = f"{cx}-w/2" + (f"+{xe}" if xe else "")
            Y = f"{cy}-h/2" + (f"+{ye}" if ye else "")
            ev = ":eval=frame" if (xe or ye) else ""
            fc.append(f"[{cur}][c{k}]overlay=x='{_e(X)}':y='{_e(Y)}':enable='between(t,{start:.3f},{start + dur:.3f})'"
                      f"{ev}:format=auto[v{k}]")
            cur = f"v{k}"
    # ---- pistas de audio
    if include_audio_tracks:
        for tr in p.get("tracks", []):
            if tr.get("kind") != "audio" or tr.get("muted"):
                continue
            for c in tr.get("clips", []):
                m = media.get(c.get("mediaId"))
                if not m or float(c.get("volume", 1)) <= 0:
                    continue
                start, dur = float(c["start"]), float(c["dur"])
                speed = float(c.get("speed", 1) or 1)
                k = add_input(["-ss", f"{float(c.get('in', 0)):.3f}", "-t", f"{dur * speed + 0.1:.3f}", "-i", m["path"]])
                audio_labels.append(audio_chain(fc, k, c, start, dur, speed))
    # ---- mezcla
    if audio_labels:
        fc.append("".join(f"[{a}]" for a in audio_labels) +
                  f"amix=inputs={len(audio_labels)}:normalize=0:dropout_transition=0,apad,atrim=duration={total:.3f}[aout]")
    else:
        fc.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={total:.3f}[aout]")

    q = {"alta": "17", "media": "21", "liviana": "26"}.get(quality, "18")
    if audio_only:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", *inputs,
               "-filter_complex", ";".join(fc), "-map", "[aout]", "-ac", "1", "-ar", "16000", "-t", f"{total:.3f}", out]
        return cmd, total
    post = []
    if ass_file:
        post.append(f"ass={ass_file}:fontsdir=fonts")
    if abs(res_scale - 1) > 1e-3:
        post.append(f"scale={int(W * res_scale / 2) * 2}:{int(H * res_scale / 2) * 2}")
    post.append("format=yuv420p")
    fc.append(f"[{cur}]" + ",".join(post) + "[vout]")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", *inputs,
           "-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", q, "-r", f"{fps:g}",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{total:.3f}", out]
    return cmd, total


def audio_chain(fc: list, k: int, c: dict, start: float, dur: float, speed: float) -> str:
    ch = [f"[{k}:a]asetpts=PTS-STARTPTS", "aresample=48000", "aformat=channel_layouts=stereo"]
    ch += atempo_chain(speed)
    ch.append(f"atrim=duration={dur:.3f}")
    vol = float(c.get("volume", 1))
    if abs(vol - 1) > 1e-3:
        ch.append(f"volume={vol:.3f}")
    fi, fo = float(c.get("fadeIn", 0) or 0), float(c.get("fadeOut", 0) or 0)
    if fi > 0:
        ch.append(f"afade=t=in:st=0:d={min(fi, dur):.3f}")
    if fo > 0:
        ch.append(f"afade=t=out:st={max(0, dur - fo):.3f}:d={min(fo, dur):.3f}")
    ms = int(round(start * 1000))
    if ms > 0:
        ch.append(f"adelay=delays={ms}:all=1")
    lab = f"a{k}"
    fc.append(",".join(ch) + f"[{lab}]")
    return lab


# ------------------------------------------------------------------ medios: info, miniaturas, ondas
IMAGE_CODECS = {"png", "mjpeg", "jpeg2000", "webp", "bmp", "tiff", "gif"}


def media_info(path: str) -> dict:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,codec_name,width,height,disposition:stream_side_data=rotation:format=duration,format_name",
        "-of", "json", path], creationflags=NO_WINDOW)
    j = json.loads(out)
    streams = j.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), None)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    dur = float(j.get("format", {}).get("duration", 0) or 0)
    name = Path(path).name
    if v is None:
        if not has_audio:
            raise ValueError("Archivo sin video ni audio")
        return {"type": "audio", "duration": dur, "width": 0, "height": 0, "has_audio": True, "name": name, "path": path}
    w, h = v.get("width", 0), v.get("height", 0)
    rot = next((abs(int(sd.get("rotation", 0))) for sd in v.get("side_data_list", [])), 0)
    if rot in (90, 270):
        w, h = h, w
    fmt = j.get("format", {}).get("format_name", "")
    is_img = v.get("codec_name") in IMAGE_CODECS and (dur < 0.1 or "image2" in fmt or "_pipe" in fmt) and v.get("codec_name") != "gif"
    return {"type": "image" if is_img else "video", "duration": 0 if is_img else dur, "width": w, "height": h,
            "has_audio": has_audio and not is_img, "name": name, "path": path}


def cache_key(path: str, extra: str = "") -> str:
    st = Path(path).stat()
    return hashlib.md5(f"{path}|{st.st_mtime}|{st.st_size}|{extra}".encode()).hexdigest()[:16]


def make_thumbs(path: str, cache: Path, kind: str, duration: float) -> Path:
    cache.mkdir(exist_ok=True)
    out = cache / f"th_{cache_key(path)}.jpg"
    if out.exists():
        return out
    if kind == "image":
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", path, "-vf", "scale=-2:64", "-frames:v", "1", str(out)]
    else:
        n = 24
        rate = n / max(duration, 0.1)
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", path, "-vf", f"fps={rate:.5f},scale=-2:64,tile={n}x1",
               "-frames:v", "1", "-an", str(out)]
    subprocess.run(cmd, check=True, creationflags=NO_WINDOW)
    return out


def make_wave(path: str, cache: Path) -> Path:
    cache.mkdir(exist_ok=True)
    out = cache / f"wv_{cache_key(path)}.png"
    if out.exists():
        return out
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", path, "-filter_complex",
           "aformat=channel_layouts=mono,showwavespic=s=1600x56:colors=0x7fd8ff", "-frames:v", "1", str(out)]
    subprocess.run(cmd, check=True, creationflags=NO_WINDOW)
    return out
