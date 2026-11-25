"""Biblioteca de música y efectos de sonido (Openverse: Creative Commons de Jamendo, Freesound y Wikimedia).

Solo se muestran obras con licencia que permite USO COMERCIAL (license_type=commercial):
CC0, dominio público, CC BY y CC BY-SA. Las que exigen atribución guardan el texto de créditos.
Las descargas se hacen por ID desde la API oficial (nunca desde una URL enviada por la interfaz),
con tamaño máximo y solo por HTTPS.
"""
from __future__ import annotations

import json
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.openverse.org/v1/audio/"
UA = "CapcraftEditor/0.5 (+https://github.com/UFOsz/capcraft-editor)"
MAX_BYTES = 60 * 1024 * 1024
ID_RE = re.compile(r"^[0-9a-fA-F-]{32,36}$")
ALLOWED_LICENSES = {"cc0", "pdm", "by", "by-sa"}
EXTS = {"mp3", "ogg", "wav", "flac", "m4a", "opus", "aac"}

# (id, nombre, búsqueda, categoría)
GENRES = [
    ("tendencias", "🔥 Tendencias", "upbeat energetic", "music"),
    ("phonk", "Phonk", "phonk", "music"),
    ("reggaeton", "Reggaetón", "reggaeton", "music"),
    ("latina", "Latina", "latin", "music"),
    ("pop", "Pop", "pop", "music"),
    ("electronica", "Electrónica", "electronic", "music"),
    ("edm", "EDM / Dance", "dance edm", "music"),
    ("hiphop", "Hip hop", "hip hop", "music"),
    ("trap", "Trap", "trap beat", "music"),
    ("rock", "Rock", "rock", "music"),
    ("lofi", "Lo-fi", "lofi", "music"),
    ("vlog", "Vlog", "vlog", "music"),
    ("alegre", "Alegre", "happy", "music"),
    ("relajante", "Relajante", "relaxing", "music"),
    ("cinematica", "Cinemática", "cinematic", "music"),
    ("epica", "Épica", "epic", "music"),
    ("corporativa", "Corporativa / Anuncios", "corporate", "music"),
    ("acustica", "Acústica", "acoustic guitar", "music"),
    ("jazz", "Jazz", "jazz", "music"),
    ("funk", "Funk", "funk", "music"),
    ("clasica", "Clásica", "classical piano", "music"),
    ("romantica", "Romántica", "romantic", "music"),
    ("suspenso", "Suspenso", "suspense dark", "music"),
    ("entrenamiento", "Entrenamiento", "workout", "music"),
    ("infantil", "Infantil", "children kids", "music"),
    ("navidad", "Navidad", "christmas", "music"),
    ("ambiente", "Ambiente", "ambient", "music"),
]
SFX = [
    ("sfx_whoosh", "Whoosh / transición", "whoosh", "sound_effect"),
    ("sfx_pop", "Pop / burbuja", "pop bubble", "sound_effect"),
    ("sfx_click", "Clic / interfaz", "click button", "sound_effect"),
    ("sfx_notif", "Notificación", "notification", "sound_effect"),
    ("sfx_aplausos", "Aplausos", "applause", "sound_effect"),
    ("sfx_risas", "Risas", "laugh", "sound_effect"),
    ("sfx_caja", "Caja registradora / dinero", "cash register", "sound_effect"),
    ("sfx_impacto", "Impacto / golpe", "impact hit", "sound_effect"),
    ("sfx_explosion", "Explosión", "explosion", "sound_effect"),
    ("sfx_tambores", "Redoble", "drum roll", "sound_effect"),
    ("sfx_ding", "Ding / campana", "ding bell", "sound_effect"),
    ("sfx_glitch", "Glitch", "glitch", "sound_effect"),
]
ALL = {g[0]: g for g in GENRES + SFX}

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
_ctx = ssl.create_default_context()


class MusicError(Exception):
    pass


def _get_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
            return json.loads(r.read(5 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise MusicError("Openverse limitó las búsquedas por un rato (demasiadas seguidas). Intenta en unos minutos.")
        raise MusicError(f"Openverse respondió {e.code}")
    except urllib.error.URLError as e:
        raise MusicError(f"Sin conexión con la biblioteca de música ({e.reason}).")


def _clean(s, n=200) -> str:
    return re.sub(r"[\x00-\x1f]", " ", str(s or ""))[:n].strip()


def _norm(r: dict) -> dict | None:
    lic = str(r.get("license") or "").lower()
    if lic not in ALLOWED_LICENSES or not ID_RE.match(str(r.get("id", ""))):
        return None
    dur = r.get("duration") or 0
    try:
        dur = float(dur) / 1000.0
    except (TypeError, ValueError):
        dur = 0
    title = _clean(r.get("title"), 120) or "Sin título"
    creator = _clean(r.get("creator"), 80) or "Desconocido"
    lic_name = "CC0" if lic == "cc0" else "Dominio público" if lic == "pdm" else f"CC {lic.upper()} {r.get('license_version') or ''}".strip()
    credit = _clean(r.get("attribution"), 400) or f'"{title}" de {creator}, licencia {lic_name}.'
    return {
        "id": str(r["id"]), "title": title, "creator": creator, "duration": round(dur, 1),
        "license": lic, "license_name": lic_name, "attribution_required": lic not in ("cc0", "pdm"),
        "credit": credit, "license_url": _clean(r.get("license_url"), 300),
        "landing": _clean(r.get("foreign_landing_url"), 300), "source": _clean(r.get("source") or r.get("provider"), 40),
        "filetype": _clean(r.get("filetype"), 8).lower(),
    }


def search(genre: str | None, q: str | None, page: int = 1) -> dict:
    page = max(1, min(int(page or 1), 20))
    if q:
        query, cat = _clean(q, 80), ("sound_effect" if genre and genre.startswith("sfx") else "music")
    else:
        g = ALL.get(genre or "tendencias") or ALL["tendencias"]
        query, cat = g[2], g[3]
    params = {"q": query, "license_type": "commercial", "page_size": 20, "page": page, "mature": "false"}
    if cat:
        params["category"] = cat
    url = API + "?" + urllib.parse.urlencode(params)
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
    data = _get_json(url)
    items = [x for x in (_norm(r) for r in data.get("results", [])) if x]
    out = {"items": items, "page": page, "has_more": page < int(data.get("page_count") or 1)}
    with _lock:
        _cache[url] = (time.time(), out)
        if len(_cache) > 300:
            _cache.pop(next(iter(_cache)))
    return out


def fetch(track_id: str, folder: Path) -> dict:
    """Descarga (o reutiliza) la pista por su ID oficial. Devuelve ruta local + metadatos."""
    if not ID_RE.match(track_id or ""):
        raise MusicError("ID de pista inválido")
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / f"{track_id}.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if Path(meta.get("path", "")).is_file():
            return meta
    info = _get_json(API + urllib.parse.quote(track_id) + "/")
    item = _norm(info)
    if not item:
        raise MusicError("Esta pista no tiene una licencia que permita uso comercial.")
    src = str(info.get("url") or "")
    if not src.lower().startswith("https://"):
        raise MusicError("La pista no tiene una descarga segura (HTTPS).")
    ext = item["filetype"] if item["filetype"] in EXTS else (Path(urllib.parse.urlparse(src).path).suffix.lstrip(".").lower() or "mp3")
    if ext not in EXTS:
        ext = "mp3"
    dest = folder / f"{track_id}.{ext}"
    tmp = dest.with_suffix(".part")
    req = urllib.request.Request(src, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=40, context=_ctx) as r, open(tmp, "wb") as f:
            if not r.geturl().lower().startswith("https://"):
                raise MusicError("La descarga fue redirigida a un sitio no seguro.")
            total = 0
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BYTES:
                    raise MusicError("El archivo es demasiado grande.")
                f.write(chunk)
        tmp.replace(dest)
    except urllib.error.URLError as e:
        tmp.unlink(missing_ok=True)
        raise MusicError(f"No se pudo descargar la pista ({getattr(e, 'reason', e)}).")
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    meta = {**item, "path": str(dest)}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


def genres() -> dict:
    return {"music": [{"id": g[0], "name": g[1]} for g in GENRES], "sfx": [{"id": g[0], "name": g[1]} for g in SFX]}
