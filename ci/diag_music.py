"""Diagnóstico de la biblioteca de música desde el CI: cuántas pistas da cada género y prueba una descarga."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "engine"))
from capcraft_subs import music  # noqa: E402

first = None
for g in music.GENRES + music.SFX:
    try:
        r = music.search(g[0], None)
        lic = {}
        for x in r["items"]:
            lic[x["license"]] = lic.get(x["license"], 0) + 1
        print(f"G {g[0]:<16} {len(r['items']):>3} pistas  {lic}  ej: {r['items'][0]['title'][:40] if r['items'] else '-'}")
        first = first or (r["items"][0] if r["items"] else None)
    except Exception as e:  # noqa: BLE001
        print(f"G {g[0]:<16} ERROR {e}")
if first:
    try:
        m = music.fetch(first["id"], pathlib.Path("m"))
        print("FETCH", pathlib.Path(m["path"]).name, pathlib.Path(m["path"]).stat().st_size, m["license_name"])
    except Exception as e:  # noqa: BLE001
        print("FETCH ERROR", e)
print("SEARCH libre:", len(music.search("phonk", "phonk")["items"]))
