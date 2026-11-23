"""Punto de entrada del motor empaquetado (PyInstaller): capcraft-engine.exe --port N"""
import multiprocessing
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # en un .exe sin consola stdout puede no existir; con consola oculta sí existe
    if sys.stdout is None:
        import io
        sys.stdout = io.StringIO()
    from capcraft_subs.server import main
    main()
