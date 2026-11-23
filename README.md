# Capcraft Editor

Editor de video de escritorio estilo CapCut, con **subtítulos automáticos animados por palabra**.

## Instalar (Windows 10/11)

1. Entra a **[Releases](https://github.com/UFOsz/capcraft-editor/releases/latest)** y descarga `Capcraft-Editor-Setup-x.y.z.exe`.
2. Ábrelo. Si Windows muestra "Windows protegió su PC", pulsa **Más información → Ejecutar de todas formas** (la app no tiene firma digital paga).
3. Se crea el acceso directo **Capcraft Editor** en el escritorio.

No hace falta instalar Python, FFmpeg ni nada más. La primera vez que generes subtítulos se descarga el modelo de voz (~1,5 GB con "medium").

### Actualizaciones automáticas
La app revisa GitHub al abrir y cada 2 horas. Si hay una versión nueva la descarga sola y te ofrece reiniciar; si no, se instala al cerrar. También: **Menú → Buscar actualizaciones**.

Tus proyectos y plantillas se guardan en `%APPDATA%\Capcraft Editor` y no se tocan al actualizar ni al desinstalar.

## Funciones
- Línea de tiempo multipista: principal magnética, capas de video/foto, texto, audio y subtítulos.
- Dividir, recortar, mover entre pistas, imán, duplicar, separar audio, deshacer/rehacer.
- Transformar en el lienzo (mover, escalar, girar, voltear), color, 10 filtros, velocidad 0.1–10x, volumen y fundidos.
- Animaciones de entrada/salida (fundido, zoom, deslizar; textos: pop, máquina de escribir).
- Subtítulos con Whisper: 9 plantillas animadas por palabra, editor de palabras, palabras clave, quitar silencios.
- Exportación MP4 (original / 720p / 480p) y .srt.

## Desarrollo
- `engine/` — motor en Python (servidor local + FFmpeg + faster-whisper).
- `app/` — Electron (interfaz en `app/renderer`).
- Modo desarrollo en Windows: `instalar.bat` y luego `Capcraft Editor.bat`.

### Publicar una versión nueva
1. Sube el número en `app/package.json` (por ejemplo `0.4.1`).
2. `git commit -am "v0.4.1" && git push`
3. GitHub Actions detecta la versión nueva, empaqueta el motor, prueba que funcione, construye el instalador y lo publica en Releases (crea la etiqueta `v0.4.1`). Todas las apps instaladas se actualizan solas. Si la versión ya existe, no vuelve a publicar.
