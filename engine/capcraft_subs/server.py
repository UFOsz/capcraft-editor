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
from . import music

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
                        "duration": prj.project_duration(d), "thumb": clean_thumb(d.get("thumb")),
                        "ratio": f"{d['canvas']['width']}x{d['canvas']['height']}"})
        except Exception:
            continue
    return out


def safe_id(pid: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", pid)[:64] or "proyecto"


# ------------------------------------------------------------------ seguridad
# Token secreto: la app de escritorio lo genera al arrancar y lo pasa al motor (CAPCRAFT_TOKEN). La ventana lo
# recibe una sola vez en la URL y queda en una cookie HttpOnly/SameSite=Strict. Así ninguna página web abierta
# en el navegador del usuario puede usar este servidor local aunque adivine el puerto.
TOKEN = os.environ.get("CAPCRAFT_TOKEN", "")
PORT = 0
MAX_BODY = 25 * 1024 * 1024
MEDIA_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".3gp", ".ts", ".mts", ".m2ts", ".wmv", ".flv",
             ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac", ".opus", ".wma",
             ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"}
THUMB_RE = re.compile(r"^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$")
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
MUSIC = DATA / "musica"
FAVS = MUSIC / "favoritos.json"


class Forbidden(Exception):
    pass


def media_path(raw: str) -> Path:
    """Valida una ruta de medio enviada por la interfaz: archivo local existente con extensión de video/audio/imagen."""
    if not raw or "\x00" in raw or "://" in raw or raw.startswith(("\\\\", "//")):
        raise Forbidden("Ruta no permitida")
    path = Path(raw)
    if path.suffix.lower() not in MEDIA_EXT and not raw.endswith(".preview.mp4"):
        raise Forbidden("Tipo de archivo no permitido")
    if not path.is_file():
        raise FileNotFoundError(raw)
    return path


def output_path(raw: str) -> str:
    if not raw or "\x00" in raw or "://" in raw or raw.startswith(("\\\\", "//")):
        raise Forbidden("Ruta de salida no permitida")
    out = Path(raw).resolve()
    if out.suffix.lower() != ".mp4":
        raise Forbidden("La salida debe ser un archivo .mp4")
    if not out.parent.is_dir():
        raise Forbidden("La carpeta de destino no existe")
    return str(out)


def check_project_media(proj: dict) -> None:
    for m in (proj.get("media") or {}).values():
        media_path(str(m.get("path", "")))


def clean_thumb(t):
    return t if isinstance(t, str) and len(t) < 400_000 and THUMB_RE.match(t) else None


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "Capcraft"
    sys_version = ""

    def log_message(self, fmt, *args):  # silencio salvo errores
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("%s\n" % (fmt % args))

    # --- cabeceras de seguridad comunes
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    # --- respuestas
    def _json(self, obj, code=200, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({"error": msg}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise Forbidden("Solicitud demasiado grande")
        return json.loads(self.rfile.read(n) or b"{}")

    # --- control de acceso
    def _authorized(self, method: str) -> bool:
        host = (self.headers.get("Host") or "").lower()
        if PORT and host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return False  # protege contra DNS rebinding
        origin = self.headers.get("Origin")
        if origin and PORT and origin.lower() not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return False  # otra página web intentando usar el servidor
        if method == "POST" and "application/json" not in (self.headers.get("Content-Type") or ""):
            return False  # evita formularios/peticiones simples de otros sitios
        if not TOKEN:
            return True
        cookie = self.headers.get("Cookie") or ""
        m = re.search(r"(?:^|;\s*)cc_token=([A-Za-z0-9_-]+)", cookie)
        import hmac
        return bool(m) and hmac.compare_digest(m.group(1), TOKEN)

    def _file(self, path: Path, ctype: str | None = None, html=False):
        if not path.is_file():
            return self._err("No encontrado", 404)
        size = path.stat().st_size
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and size:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = max(0, end - start + 1)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        if html:
            self.send_header("Content-Security-Policy", CSP)
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
        # arranque: la ventana llega con ?t=TOKEN una sola vez; se guarda como cookie y se limpia la URL
        if TOKEN and p in ("/", "/index.html") and "t" in q:
            import hmac
            if hmac.compare_digest(q["t"][0], TOKEN) and (self.headers.get("Host") or "").lower() == f"127.0.0.1:{PORT}":
                self.send_response(302)
                self.send_header("Set-Cookie", f"cc_token={TOKEN}; Path=/; HttpOnly; SameSite=Strict")
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        if not self._authorized("GET"):
            return self._err("Acceso denegado", 403)
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
                path = media_path(q.get("path", [""])[0])
                f = prj.make_thumbs(str(path), CACHE, q.get("type", ["video"])[0], float(q.get("dur", ["1"])[0]))
                return self._file(f)
            if p == "/api/wave":
                return self._file(prj.make_wave(str(media_path(q.get("path", [""])[0])), CACHE))
            if p == "/media":
                return self._file(media_path(q.get("path", [""])[0]))
            if p == "/api/music/genres":
                return self._json(music.genres())
            if p == "/api/music/search":
                try:
                    return self._json(music.search(q.get("genre", [None])[0], q.get("q", [None])[0], int(q.get("page", ["1"])[0])))
                except music.MusicError as e:
                    return self._err(str(e), 502)
            if p == "/api/music/favs":
                return self._json(read_json(FAVS, []))
            if p.startswith("/fonts/"):
                return self._file(FONTS / Path(urllib.parse.unquote(p[7:])).name)
            rel = urllib.parse.unquote(p.lstrip("/")) or "index.html"
            target = (RENDERER / rel).resolve()
            if RENDERER.resolve() not in target.parents:
                return self._err("Prohibido", 403)
            return self._file(target, html=target.suffix == ".html")
        except Forbidden as e:
            return self._err(str(e), 403)
        except FileNotFoundError:
            return self._err("No encontrado", 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(str(e), 500)

    # --- POST
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if not self._authorized("POST"):
            return self._err("Acceso denegado", 403)
        try:
            b = self._body()
            if p == "/api/media/info":
                return self._json(prj.media_info(str(media_path(b["path"]))))
            if p == "/api/v2/ass":
                ass, lines = prj.build_ass(b["project"], load_templates()["builtin"])
                return self._json({"ass": ass, "lines": lines})
            if p == "/api/v2/export":
                b["out"] = output_path(b.get("out", ""))
                check_project_media(b["project"])
                if any(str(Path(m["path"]).resolve()) == b["out"] for m in b["project"].get("media", {}).values()):
                    raise Forbidden("No puedes sobrescribir un archivo usado en el proyecto")
                return self._json({"job": start_job(job_export_v2, b)})
            if p == "/api/v2/transcribe":
                check_project_media(b["project"])
                return self._json({"job": start_job(job_transcribe_v2, b)})
            if p == "/api/projects/load":
                f = PROJECTS / f"{safe_id(b['id'])}.json"
                d = json.loads(f.read_text(encoding="utf-8"))
                d["thumb"] = clean_thumb(d.get("thumb"))
                return self._json(d)
            if p == "/api/projects/save":
                PROJECTS.mkdir(parents=True, exist_ok=True)
                proj = b["project"]
                if not isinstance(proj, dict) or "tracks" not in proj:
                    raise Forbidden("Proyecto inválido")
                proj["thumb"] = clean_thumb(proj.get("thumb"))
                f = PROJECTS / f"{safe_id(b['id'])}.json"
                tmpf = f.with_suffix(".tmp")
                tmpf.write_text(json.dumps(proj, ensure_ascii=False), encoding="utf-8")
                os.replace(tmpf, f)
                return self._json({"ok": True})
            if p == "/api/projects/delete":
                (PROJECTS / f"{safe_id(b['id'])}.json").unlink(missing_ok=True)
                return self._json({"ok": True})
            if p == "/api/proxy":
                return self._json({"job": start_job(job_proxy, str(media_path(b["path"])))})
            if p == "/api/templates/save":
                tid = safe_id(str(b["id"]))
                if not isinstance(b.get("template"), dict):
                    raise Forbidden("Plantilla inválida")
                custom = read_json(CUSTOM_TPL, {})
                custom[tid] = b["template"]
                CUSTOM_TPL.parent.mkdir(parents=True, exist_ok=True)
                CUSTOM_TPL.write_text(json.dumps(custom, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json({"ok": True})
            if p == "/api/templates/delete":
                custom = read_json(CUSTOM_TPL, {})
                custom.pop(str(b["id"]), None)
                CUSTOM_TPL.parent.mkdir(parents=True, exist_ok=True)
                CUSTOM_TPL.write_text(json.dumps(custom, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json({"ok": True})
            if p == "/api/music/get":
                try:
                    return self._json(music.fetch(str(b.get("id", "")), MUSIC))
                except music.MusicError as e:
                    return self._err(str(e), 502)
            if p == "/api/music/favs":
                favs = [x for x in (b.get("favs") or []) if isinstance(x, dict) and music.ID_RE.match(str(x.get("id", "")))][:500]
                MUSIC.mkdir(parents=True, exist_ok=True)
                FAVS.write_text(json.dumps(favs, ensure_ascii=False), encoding="utf-8")
                return self._json({"ok": True})
            return self._err("Ruta desconocida", 404)
        except Forbidden as e:
            return self._err(str(e), 403)
        except FileNotFoundError as e:
            return self._err(f"No se encontró el archivo: {e}", 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    PORT = a.port
    DATA.mkdir(parents=True, exist_ok=True)
    sync_fonts()
    os.chdir(WORK)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.daemon_threads = True
    print(f"CAPCRAFT_READY http://127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
