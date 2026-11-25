"""Diagnóstico de la biblioteca de música (Openverse) desde el CI: cuántos resultados da cada combinación de filtros."""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "CapcraftEditor/0.5 (+https://github.com/UFOsz/capcraft-editor)"}
CTX = ssl.create_default_context()


def count(params):
    url = "https://api.openverse.org/v1/audio/?" + urllib.parse.urlencode({**params, "page_size": 5})
    try:
        d = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20, context=CTX).read())
        res = d.get("results", [])
        sample = [(r.get("title"), r.get("license"), r.get("source"), r.get("category"), r.get("genres")) for r in res[:2]]
        return f"{d.get('result_count')} {sample}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code} {e.read()[:200]}"
    except Exception as e:  # noqa: BLE001
        return f"ERR {e}"


tests = [
    {"q": "phonk"}, {"q": "phonk", "category": "music"}, {"q": "phonk", "license_type": "commercial"},
    {"q": "happy"}, {"q": "happy", "category": "music"}, {"q": "happy", "license_type": "commercial"},
    {"q": "happy", "category": "music", "license_type": "commercial"},
    {"q": "music"}, {"q": "rock", "source": "jamendo"}, {"q": "rock", "source": "jamendo", "license_type": "commercial"},
    {"q": "whoosh"}, {"q": "whoosh", "category": "sound_effect", "license_type": "commercial"},
    {"q": "cinematic", "license": "cc0,by,by-sa"}, {"q": "piano", "license": "by"},
]
for t in tests:
    print("T", json.dumps(t), "->", count(t))
