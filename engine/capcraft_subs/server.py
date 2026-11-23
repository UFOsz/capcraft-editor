"""Servidor local de Capcraft Editor.

Sirve la interfaz (app/renderer), los videos (con soporte de Range para poder adelantar),
las fuentes, y una API JSON para transcribir, generar el ASS de vista previa y exportar.

Arranque:  python -m capcraft_subs.server --port 8765
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import struct
import subprocess
import sys
import threading
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .ass_render import AssRenderer, words_to_srt
from .transcribe import transcribe
from . import project as prj

ENGINE = Path(__file__).resolve().parent.parent
# Rutas: en desarrollo todo vive junto al código; en la app instalada (empaquetada) los recursos son
# de solo lectura (CAPCRAFT_RES) y los datos del usuario van en su carpeta de AppData (CAPCRAFT_DATA).
RES = Path(os.environ.get("CAPCRAFT_RES") or ENGINE)
DATA = Path(os.environ.get("CAPCRAFT_DATA") or ENGINE)
RENDERER = Path(os.environ.get("CAPCRAFT_RENDERER") or (ENGINE.parent / "app" / "renderer"))
BUILTIN_TPL = RES / "templates" / "plantillas.json"
CUSTOM_TPL = DATA / "templates" / "mis_plantillas.json"
PROJECTS = Path(os.environ["CAPCRAFT_DATA"]) / "proyectos" if os.environ.get("CAPCRAFT_DATA") else ENGINE.parent / "proyectos"
CACHE = DATA / "cache"
WORK = DATA  # carpeta de trabajo de FFmpeg (archivos .ass temporales y fuentes en ./fonts)
FONTS = WORK / "fonts"


def sync_fonts():
    """En la app instalada copia las fuentes incluidas a la carpeta de trabajo (FFmpeg las lee de ./fonts)."""
    src = RES / "fonts"
    if src.resolve() == FONTS.resolve():
        return
    FONTS.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        dst = FONTS / f.name
        if not dst.exists() or dst.stat().st_size != f.stat().st_size:
            dst.write_bytes(f.read_bytes())


mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
mimetypes.add_type("font/woff2", ".woff2")

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # que FFmpeg no abra ventanas en Windows


# ------------------------------------------------------------------ utilidades
def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_templates() -> dict:
    builtin = {k: v for k, v in read_json(BUILTIN_TPL, {}).items() if not k.startswith("_")}
    custom = read_json(CUSTOM_TPL, {})
    return {"builtin": builtin, "custom": custom}


def font_family(path: Path) -> str | None:
    """Lee el nombre de familia (nameID 1) de un .ttf/.otf sin librerías externas."""
    try:
        data = path.read_bytes()
        num = struct.unpack(">H", data[4:6])[0]
        for i in range(num):
            tag, _, off, _ = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
            if tag != b"name":
                continue
            _, count, str_off = struct.unpack(">HHH", data[off:off + 6])
            best = None
            for j in range(count):
                pid, eid, lid, nid, ln, so = struct.unpack(">HHHHHH", data[off + 6 + 12 * j: off + 18 + 12 * j])
                if nid != 1:
                    continue
                raw = data[off + str_off + so: off + str_off + so + ln]
                if pid == 3:
                    name = raw.decode("utf-16-be", "ignore")
                    if lid == 0x409:
                        return name
                    best = best or name
                elif pid == 1 and not best:
                    best = raw.decode("latin-1", "ignore")
            return best
    except Exception:
        return None
    return None


def font_ass_scale(path: Path) -> float:
    """En ASS el tamaño de fuente equivale a la altura de línea (winAscent + winDescent), no al 'em'.
    Devuelve unitsPerEm / (winAscent + winDescent) para que la app mida el texto igual que libass."""
    try:
        data = path.read_bytes()
        num = struct.unpack(">H", data[4:6])[0]
        tables = {}
        for i in range(num):
            tag, _, off, _ = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
            tables[tag] = off
        upem = struct.unpack(">H", data[tables[b"head"] + 18: tables[b"head"] + 20])[0]
        o = tables.get(b"OS/2")
        asc, desc = (struct.unpack(">HH", data[o + 74: o + 78]) if o else (0, 0))
        if not asc + desc and b"hhea" in tables:
            h = tables[b"hhea"]
            a, d = struct.unpack(">hh", data[h + 4: h + 8])
            asc, desc = a, -d
        return round(upem / (asc + desc), 4) if asc + desc else 1.0
    except Exception:
        return 1.0


def list_fonts() -> list[dict]:
    out = []
    for f in sorted(FONTS.iterdir()):
        if f.suffix.lower() in (".ttf", ".otf"):
            fam = font_family(f)
            if fam:
                out.append({"family": fam, "file": f.name, "ass_scale": font_ass_scale(f)})
    return out


def probe(path: str) -> dict:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,width,height,r_frame_rate:stream_side_data=rotation:format=duration",
        "-of", "json", path], creationflags=NO_WINDOW)
    j = json.loads(out)
    v = next((s for s in j["streams"] if s.get("codec_type") == "video"), None)
    if not v:
        raise ValueError("El archivo no tiene video")
    w, h = v["width"], v["height"]
    rot = next((abs(int(sd.get("rotation", 0))) for sd in v.get("side_data_list", [])), 0)
    if rot in (90, 270):
        w, h = h, w
    num, den = (v.get("r_frame_rate") or "30/1").split("/")
    return {
        "width": w, "height": h,
        "duration": float(j.get("format", {}).get("duration", 0) or 0),
        "fps": round(float(num) / float(den or 1), 3),
        "has_audio": any(s.get("codec_type") == "audio" for s in j["streams"]),
    }


def project_path(video: str) -> Path:
    return Path(video).with_suffix(Path(video).suffix + ".capcraft.json")


# ------------------------------------------------------------------ trabajos en segundo plano
JOBS: dict[str, dict] = {}


def start_job(fn, *args) -> str:
    jid = uuid.uuid4().hex[:10]
    job = {"status": "running", "progress": 0.0, "message": "", "result": None}
    JOBS[jid] = job

    def run():
        try:
            job["result"] = fn(job, *args)
            job["status"], job["progress"] = "done", 1.0
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["status"], job["message"] = "error", f"{type(e).__name__}: {e}"

    threading.Thread(target=run, daemon=True).start()
    return jid


def job_transcribe(job, path, model, language):
    job["message"] = "Cargando modelo (la primera vez se descarga)…"

    def prog(p):
        job["progress"], job["message"] = p, f"Transcribiendo… {int(p * 100)} %"

    data = transcribe(path, "auto", model, language or None, progress=prog)
    return data


def remap_words(words: list[dict], segments: list[list[float]]) -> list[dict]:
    """Pasa las palabras del tiempo original al tiempo del video ya cortado."""
    out, offset = [], 0.0
    for s, e in segments:
        for w in words:
            mid = (w["start"] + w["end"]) / 2
            if s <= mid < e:
                nw = dict(w)
                nw["start"] = round(offset + max(w["start"], s) - s, 3)
                nw["end"] = round(offset + min(w["end"], e) - s, 3)
                out.append(nw)
        offset += e - s
    return out


def job_export(job, req):
    path, out = req["path"], req["out"]
    info = probe(path)
    dur = info["duration"]
    segs = [[max(0.0, float(s)), min(dur, float(e))] for s, e in (req.get("segments") or [[0, dur]])]
    segs = [s for s in segs if s[1] - s[0] > 0.04]
    full = len(segs) == 1 and segs[0][0] <= 0.01 and segs[0][1] >= dur - 0.01
    words = req["words"] if full else remap_words(req["words"], segs)
    out_dur = sum(e - s for s, e in segs)

    ass_text, _ = AssRenderer(req["template"], info["width"], info["height"],
                              req.get("keywords") or []).render_full(words)
    tmp_name = f"_render_{uuid.uuid4().hex[:8]}.ass"
    (WORK / tmp_name).write_text(ass_text, encoding="utf-8")
    if req.get("srt"):
        Path(out).with_suffix(".srt").write_text(words_to_srt(words), encoding="utf-8")

    sub = f"ass={tmp_name}:fontsdir=fonts"
    if full:
        fc = f"[0:v]{sub}[vo]"
        amap = ["-map", "0:a?"]
    else:
        parts, labels = [], ""
        for i, (s, e) in enumerate(segs):
            parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")
            if info["has_audio"]:
                parts.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")
                labels += f"[v{i}][a{i}]"
            else:
                labels += f"[v{i}]"
        a = 1 if info["has_audio"] else 0
        parts.append(f"{labels}concat=n={len(segs)}:v=1:a={a}[vc]" + ("[ac]" if a else ""))
        parts.append(f"[vc]{sub}[vo]")
        fc = ";".join(parts)
        amap = ["-map", "[ac]"] if a else []

    q = {"alta": "16", "media": "20", "liviana": "24"}.get(req.get("quality", "alta"), "18")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
           "-i", str(Path(path).resolve()), "-filter_complex", fc, "-map", "[vo]", *amap,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", q, "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(Path(out).resolve())]
    job["message"] = "Exportando…"
    try:
        p = subprocess.Popen(cmd, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
        for line in p.stdout:
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    t = int(line.split("=")[1]) / 1e6
                    job["progress"] = min(0.99, t / max(out_dur, 0.01))
                    job["message"] = f"Exportando… {int(job['progress'] * 100)} %"
                except ValueError:
                    pass
        err = p.stderr.read()
        if p.wait() != 0:
            raise RuntimeError(err.strip()[-800:] or "FFmpeg falló")
    finally:
        (WORK / tmp_name).unlink(missing_ok=True)
    return {"out": out}


def job_proxy(job, path):
    """Copia liviana H.264 720p solo para la vista previa (videos HEVC/HDR del iPhone, etc.)."""
    info = probe(path)
    out = Path(path).with_suffix(Path(path).suffix + ".preview.mp4")
    vf = "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)',format=yuv420p"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
           "-i", path, "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
           "-c:a", "aac", "-b:a", "128k", str(out)]
    job["message"] = "Creando copia de vista previa…"
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    for line in p.stdout:
        if line.startswith("out_time_us="):
            try:
                job["progress"] = min(0.99, int(line.split("=")[1]) / 1e6 / max(info["duration"], 0.01))
                job["message"] = f"Creando copia de vista previa… {int(job['progress'] * 100)} %"
            except ValueError:
                pass
    if p.wait() != 0:
        raise RuntimeError(p.stderr.read().strip()[-500:])
    return {"preview": str(out)}


def run_ffmpeg_progress(job, cmd, total, label):
    p = subprocess.Popen(cmd, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    for line in p.stdout:
        if line.startswith("out_time_us="):
            try:
                job["progress"] = min(0.99, int(line.split("=")[1]) / 1e6 / max(total, 0.01))
                job["message"] = f"{label}… {int(job['progress'] * 100)} %"
            except ValueError:
                pass
    err = p.stderr.read()
    if p.wait() != 0:
        raise RuntimeError(err.strip()[-1200:] or "FFmpeg falló")


def job_export_v2(job, req):
    proj = req["project"]
    builtin = load_templates()["builtin"]
    ass, _ = prj.build_ass(proj, builtin)
    tmp = f"_render_{uuid.uuid4().hex[:8]}.ass"
    (WORK / tmp).write_text(ass, encoding="utf-8")
    out = str(Path(req["out"]).resolve())
    try:
        cmd, total = prj.build_export(proj, tmp, out, req.get("quality", "alta"), float(req.get("res_scale", 1)))
        job["message"] = "Exportando…"
        run_ffmpeg_progress(job, cmd, total, "Exportando")
    finally:
        (WORK / tmp).unlink(missing_ok=True)
    words = (proj.get("subtitles") or {}).get("words") or []
    if req.get("srt") and words:
        Path(out).with_suffix(".srt").write_text(words_to_srt(words), encoding="utf-8")
    return {"out": out}


def job_transcribe_v2(job, req):
    proj = req["project"]
    wav = CACHE / f"_mix_{uuid.uuid4().hex[:8]}.wav"
    CACHE.mkdir(exist_ok=True)
    try:
        cmd, total = prj.build_export(proj, None, str(wav), audio_only=True,
                                      include_audio_tracks=bool(req.get("include_audio_tracks")))
        job["message"] = "Preparando el audio…"
        run_ffmpeg_progress(job, cmd, total, "Preparando el audio")
        return job_transcribe(job, str(wav), req.get("model", "medium"), req.get("language", "es"))
    finally:
        wav.unlink(missing_ok=True)


def list_projects():
    PROJECTS.mkdir(exist_ok=True)
    out = []
    for f in sorted(PROJECTS.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            out.append({"id": f.stem, "name": d.get("name", f.stem), "modified": f.stat().st_mtime,
                        "duration": prj.project_duration(d), "thumb": d.get("thumb"),
                        "ratio": f"{d['canvas']['width']}x{d['canvas']['height']}"})
        except Exception:
            continue
    return out


def safe_id(pid: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", pid)[:64] or "proyecto"


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "Capcraft/0.2"

    def log_message(self, fmt, *args):  # silencio salvo errores
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s\n" % (fmt % args))

    # --- respuestas
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({"error": msg}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _file(self, path: Path, ctype: str | None = None):
        if not path.is_file():
            return self._err("No encontrado", 404)
        size = path.stat().st_size
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = size - int(m.group(2))
                end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    # --- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path
        try:
            if p == "/api/templates":
                return self._json(load_templates())
            if p == "/api/fonts":
                return self._json(list_fonts())
            if p == "/api/job":
                job = JOBS.get(q.get("id", [""])[0])
                return self._json(job) if job else self._err("Trabajo no existe", 404)
            if p == "/api/selftest":
                out = {}
                for mod in ("faster_whisper", "ctranslate2", "numpy"):
                    try:
                        __import__(mod); out[mod] = "ok"
                    except Exception as e:  # noqa: BLE001
                        out[mod] = f"ERROR {e}"
                try:
                    v = subprocess.check_output(["ffmpeg", "-hide_banner", "-filters"], creationflags=NO_WINDOW, text=True)
                    out["ffmpeg_ass"] = "ok" if " ass " in v else "ERROR sin libass"
                except Exception as e:  # noqa: BLE001
                    out["ffmpeg_ass"] = f"ERROR {e}"
                out["fonts"] = len(list_fonts())
                return self._json(out)
            if p == "/api/health":
                return self._json({"ok": True, "version": os.environ.get("CAPCRAFT_VERSION", "dev")})
            if p == "/api/projects":
                return self._json(list_projects())
            if p == "/api/thumbs":
                f = prj.make_thumbs(q["path"][0], CACHE, q.get("type", ["video"])[0], float(q.get("dur", ["1"])[0]))
                return self._file(f)
            if p == "/api/wave":
                return self._file(prj.make_wave(q["path"][0], CACHE))
            if p == "/media":
                return self._file(Path(q.get("path", [""])[0]))
            if p.startswith("/fonts/"):
                return self._file(FONTS / Path(urllib.parse.unquote(p[7:])).name)
            rel = urllib.parse.unquote(p.lstrip("/")) or "index.html"
            target = (RENDERER / rel).resolve()
            if RENDERER.resolve() not in target.parents and target != RENDERER.resolve():
                return self._err("Prohibido", 403)
            return self._file(target)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(str(e), 500)

    # --- POST
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        try:
            b = self._body()
            if p == "/api/probe":
                return self._json(probe(b["path"]))
            if p == "/api/ass":
                r = AssRenderer(b["template"], int(b.get("width", 1080)), int(b.get("height", 1920)),
                                b.get("keywords") or [])
                ass, lines = r.render_full(b["words"])
                return self._json({"ass": ass, "lines": lines})
            if p == "/api/transcribe":
                jid = start_job(job_transcribe, b["path"], b.get("model", "medium"), b.get("language", "es"))
                return self._json({"job": jid})
            if p == "/api/media/info":
                return self._json(prj.media_info(b["path"]))
            if p == "/api/v2/ass":
                ass, lines = prj.build_ass(b["project"], load_templates()["builtin"])
                return self._json({"ass": ass, "lines": lines})
            if p == "/api/v2/export":
                return self._json({"job": start_job(job_export_v2, b)})
            if p == "/api/v2/transcribe":
                return self._json({"job": start_job(job_transcribe_v2, b)})
            if p == "/api/projects/load":
                f = PROJECTS / f"{safe_id(b['id'])}.json"
                return self._json(json.loads(f.read_text(encoding="utf-8")))
            if p == "/api/projects/save":
                PROJECTS.mkdir(exist_ok=True)
                f = PROJECTS / f"{safe_id(b['id'])}.json"
                tmpf = f.with_suffix(".tmp")
                tmpf.write_text(json.dumps(b["project"], ensure_ascii=False), encoding="utf-8")
                os.replace(tmpf, f)
                return self._json({"ok": True})
            if p == "/api/projects/delete":
                (PROJECTS / f"{safe_id(b['id'])}.json").unlink(missing_ok=True)
                return self._json({"ok": True})
            if p == "/api/proxy":
                return self._json({"job": start_job(job_proxy, b["path"])})
            if p == "/api/export":
                return self._json({"job": start_job(job_export, b)})
            if p == "/api/project/load":
                pp = project_path(b["path"])
                return self._json(read_json(pp, None) if pp.exists() else {"empty": True})
            if p == "/api/project/save":
                project_path(b["path"]).write_text(json.dumps(b["project"], ensure_ascii=False), encoding="utf-8")
                return self._json({"ok": True})
            if p == "/api/templates/save":
                custom = read_json(CUSTOM_TPL, {})
                custom[b["id"]] = b["template"]
                CUSTOM_TPL.parent.mkdir(parents=True, exist_ok=True)
                CUSTOM_TPL.write_text(json.dumps(custom, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json({"ok": True})
            if p == "/api/templates/delete":
                custom = read_json(CUSTOM_TPL, {})
                custom.pop(b["id"], None)
                CUSTOM_TPL.write_text(json.dumps(custom, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json({"ok": True})
            return self._err("Ruta desconocida", 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    sync_fonts()
    os.chdir(WORK)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"CAPCRAFT_READY http://127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
