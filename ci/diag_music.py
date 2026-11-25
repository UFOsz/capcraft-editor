"""Diagnóstico de la biblioteca de música (Openverse) desde el CI."""
import json
import pathlib
import ssl
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "engine"))
URL = "https://api.openverse.org/v1/audio/?q=phonk&license_type=commercial&category=music&page_size=3"
req = urllib.request.Request(URL, headers={"User-Agent": "CapcraftEditor/0.5 (+https://github.com/UFOsz/capcraft-editor)"})
try:
    r = urllib.request.urlopen(req, timeout=20, context=ssl.create_default_context())
    d = json.loads(r.read())
    print("RAW OK", r.status, d.get("result_count"))
    for i in d.get("results", []):
        print("  -", i.get("title"), "|", i.get("license"), "|", i.get("filetype"), "|", str(i.get("url"))[:80], "| dur", i.get("duration"))
except urllib.error.HTTPError as e:
    print("RAW HTTP", e.code, e.read()[:500])
except Exception as e:  # noqa: BLE001
    print("RAW ERR", type(e).__name__, e)

from capcraft_subs import music  # noqa: E402
try:
    res = music.search("phonk", None)
    print("SEARCH", len(res["items"]), res["items"][:1])
    if res["items"]:
        m = music.fetch(res["items"][0]["id"], pathlib.Path("m"))
        print("FETCH", m["path"], pathlib.Path(m["path"]).stat().st_size, m["license_name"])
except Exception as e:  # noqa: BLE001
    print("APP ERR", type(e).__name__, e)
