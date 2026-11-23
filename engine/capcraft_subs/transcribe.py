"""Transcripción con marcas de tiempo POR PALABRA.

Backends (en orden de precisión):
  - whisperx        -> alineación forzada wav2vec2, error < 100 ms (recomendado, mejor con GPU)
  - faster-whisper  -> más liviano, tiempos por palabra aproximados

Salida: dict {"language": "es", "words": [{"text": "Hola", "start": 0.12, "end": 0.40}, ...]}
"""
from __future__ import annotations

import json
from pathlib import Path


def _detect_device() -> tuple[str, str]:
    try:
        import torch  # noqa: F401

        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def transcribe_whisperx(media: str, model: str = "large-v3", language: str | None = "es") -> dict:
    import whisperx

    device, compute = _detect_device()
    audio = whisperx.load_audio(media)
    asr = whisperx.load_model(model, device, compute_type=compute, language=language)
    result = asr.transcribe(audio, batch_size=16 if device == "cuda" else 4)
    lang = result.get("language", language or "es")
    align_model, meta = whisperx.load_align_model(language_code=lang, device=device)
    aligned = whisperx.align(result["segments"], align_model, meta, audio, device,
                             return_char_alignments=False)
    words = []
    for seg in aligned["segments"]:
        for w in seg.get("words", []):
            # whisperx puede omitir start/end en números o símbolos: se interpolan luego
            words.append({"text": w["word"].strip(), "start": w.get("start"), "end": w.get("end")})
    return {"language": lang, "words": _fill_missing_times(words)}


def load_audio_ffmpeg(media: str, sr: int = 16000):
    """Extrae el audio con FFmpeg a 16 kHz mono (float32). Evita depender de PyAV,
    cuyas versiones nuevas rompen faster-whisper ('metadata_errors')."""
    import subprocess

    import numpy as np

    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", media,
           "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def transcribe_faster_whisper(media: str, model: str = "large-v3", language: str | None = "es",
                              progress=None) -> dict:
    from faster_whisper import WhisperModel

    device, compute = _detect_device()
    m = WhisperModel(model, device=device, compute_type=compute)
    segments, info = m.transcribe(load_audio_ffmpeg(media), language=language, word_timestamps=True,
                                  vad_filter=True, beam_size=5)
    words = []
    total = max(getattr(info, "duration", 0) or 0, 0.001)
    for seg in segments:
        if progress:
            progress(min(0.99, seg.end / total))
        for w in seg.words or []:
            words.append({"text": w.word.strip(), "start": w.start, "end": w.end})
    return {"language": info.language, "words": _fill_missing_times(words)}


def _fill_missing_times(words: list[dict]) -> list[dict]:
    """Rellena start/end faltantes interpolando con los vecinos."""
    words = [w for w in words if w["text"]]
    for i, w in enumerate(words):
        if w["start"] is None:
            prev_end = words[i - 1]["end"] if i > 0 and words[i - 1]["end"] is not None else 0.0
            w["start"] = prev_end
        if w["end"] is None:
            nxt = next((x["start"] for x in words[i + 1:] if x["start"] is not None), w["start"] + 0.3)
            w["end"] = max(w["start"] + 0.08, nxt)
        w["start"], w["end"] = round(float(w["start"]), 3), round(float(w["end"]), 3)
    return words


def transcribe(media: str, backend: str = "auto", model: str = "large-v3",
               language: str | None = "es", progress=None) -> dict:
    if backend in ("auto", "whisperx"):
        try:
            return transcribe_whisperx(media, model, language)
        except ImportError:
            if backend == "whisperx":
                raise
    return transcribe_faster_whisper(media, model, language, progress)


def save_words(data: dict, path: str | Path) -> None:
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_words(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
