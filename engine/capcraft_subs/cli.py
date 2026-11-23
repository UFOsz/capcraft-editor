"""Línea de comandos de Capcraft Subs.

Ejemplos:
  python -m capcraft_subs.cli plantillas
  python -m capcraft_subs.cli transcribir video.mp4 -o palabras.json
  python -m capcraft_subs.cli quemar video.mp4 -p hormozi_pop -o final.mp4
  python -m capcraft_subs.cli quemar video.mp4 --palabras palabras.json -p karaoke_fill --clave dinero gratis
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from .ass_render import render_ass, words_to_srt
from .transcribe import load_words, save_words, transcribe

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates" / "plantillas.json"
FONTS = ROOT / "fonts"


def load_templates(path: Path = TEMPLATES) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def probe_size(video: str) -> tuple[int, int]:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:stream_side_data=rotation",
        "-of", "json", video,
    ])
    st = json.loads(out)["streams"][0]
    w, h = st["width"], st["height"]
    rot = next((abs(int(sd.get("rotation", 0))) for sd in st.get("side_data_list", [])), 0)
    return (h, w) if rot in (90, 270) else (w, h)


def burn(video: str, ass_path: Path, out: str, crf: int = 18) -> None:
    # Se copia el .ass a la carpeta del proyecto y se ejecuta FFmpeg desde ahí con rutas
    # relativas: evita los problemas de escapar "C:\\..." en los filtros de FFmpeg en Windows.
    tmp = ROOT / "_render_tmp.ass"
    shutil.copyfile(ass_path, tmp)
    vf = "ass=_render_tmp.ass:fontsdir=fonts"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
           "-i", str(Path(video).resolve()), "-vf", vf,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", str(Path(out).resolve())]
    try:
        subprocess.run(cmd, check=True, cwd=ROOT)
    finally:
        tmp.unlink(missing_ok=True)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="capcraft-subs", description="Subtítulos animados por palabra")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("plantillas", help="Lista las plantillas disponibles")

    t = sub.add_parser("transcribir", help="Genera palabras.json con tiempos por palabra")
    t.add_argument("media")
    t.add_argument("-o", "--out", default="palabras.json")
    t.add_argument("--modelo", default="large-v3", help="tiny, base, small, medium, large-v3, turbo")
    t.add_argument("--idioma", default="es")
    t.add_argument("--motor", default="auto", choices=["auto", "whisperx", "faster-whisper"])

    q = sub.add_parser("quemar", help="Transcribe (o usa palabras.json) y graba los subtítulos en el video")
    q.add_argument("video")
    q.add_argument("-p", "--plantilla", default="hormozi_pop", help="nombre de plantilla o 'todas'")
    q.add_argument("-o", "--out", default=None)
    q.add_argument("--palabras", help="Usar un palabras.json existente (p. ej. corregido a mano)")
    q.add_argument("--clave", nargs="*", default=[], help="Palabras clave a resaltar siempre")
    q.add_argument("--modelo", default="large-v3")
    q.add_argument("--idioma", default="es")
    q.add_argument("--motor", default="auto", choices=["auto", "whisperx", "faster-whisper"])
    q.add_argument("--solo-ass", action="store_true", help="Solo genera el .ass, sin renderizar video")
    q.add_argument("--srt", action="store_true", help="Además exporta un .srt sin animación")

    a = ap.parse_args(argv)
    tpls = load_templates()

    if a.cmd == "plantillas":
        for k, v in tpls.items():
            print(f"  {k:<14} {v['name']}  [{v['animation']}]")
        return

    if a.cmd == "transcribir":
        data = transcribe(a.media, a.motor, a.modelo, a.idioma)
        save_words(data, a.out)
        print(f"{len(data['words'])} palabras -> {a.out}")
        return

    if a.cmd == "quemar":
        names = list(tpls) if a.plantilla == "todas" else [a.plantilla]
        for n in names:
            if n not in tpls:
                sys.exit(f"Plantilla desconocida: {n}. Usa: {', '.join(tpls)} o todas")
        stem = Path(a.video).with_suffix("")
        if a.palabras:
            data = load_words(a.palabras)
        else:
            print("Transcribiendo (la primera vez descarga el modelo, puede tardar)...")
            data = transcribe(a.video, a.motor, a.modelo, a.idioma)
            save_words(data, f"{stem}.palabras.json")
            print(f"{len(data['words'])} palabras -> {stem}.palabras.json")
        w, h = probe_size(a.video)
        if a.srt:
            Path(f"{stem}.srt").write_text(words_to_srt(data["words"]), encoding="utf-8")
        for n in names:
            ass = render_ass(data["words"], tpls[n], w, h, a.clave)
            ass_path = Path(f"{stem}.{n}.ass")
            ass_path.write_text(ass, encoding="utf-8")
            if a.solo_ass:
                print(f"ASS -> {ass_path}")
                continue
            out = a.out if (a.out and len(names) == 1) else f"{stem}.{n}.mp4"
            print(f"Renderizando {n}...")
            burn(a.video, ass_path, out)
            print(f"Video -> {out}")


if __name__ == "__main__":
    main()
