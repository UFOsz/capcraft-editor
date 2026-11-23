# Arranca capcraft-engine.exe como lo haría la app instalada y verifica que todo funcione.
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$env:CAPCRAFT_RES = "$root\engine"
$env:CAPCRAFT_DATA = "$env:RUNNER_TEMP\capcraft-data"
$env:CAPCRAFT_RENDERER = "$root\app\renderer"
$env:PATH = "$root\ffmpeg;$env:PATH"
$exe = "$root\engine\dist\capcraft-engine\capcraft-engine.exe"
$p = Start-Process -FilePath $exe -ArgumentList "--port","8799" -PassThru -NoNewWindow -RedirectStandardOutput "$env:RUNNER_TEMP\engine.out" -RedirectStandardError "$env:RUNNER_TEMP\engine.err"
try {
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try { $h = Invoke-RestMethod "http://127.0.0.1:8799/api/health"; $ok = $true; break } catch {}
  }
  if (-not $ok) { Get-Content "$env:RUNNER_TEMP\engine.err" -ErrorAction SilentlyContinue; throw "El motor no arrancó" }
  $t = Invoke-RestMethod "http://127.0.0.1:8799/api/selftest"
  $t | ConvertTo-Json | Write-Host
  foreach ($k in "faster_whisper","ctranslate2","numpy","ffmpeg_ass") { if ($t.$k -ne "ok") { throw "Falla en $k : $($t.$k)" } }
  if ($t.fonts -lt 3) { throw "Faltan fuentes" }
  # exportación real con un video de prueba, texto y subtítulos
  & "$root\ffmpeg\ffmpeg.exe" -v error -y -f lavfi -i "testsrc2=s=640x360:d=3:r=30" -f lavfi -i "sine=d=3" -shortest -pix_fmt yuv420p "$env:RUNNER_TEMP\t.mp4"
  $info = Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "http://127.0.0.1:8799/api/media/info" -Body (@{ path = "$env:RUNNER_TEMP\t.mp4" } | ConvertTo-Json)
  $info | Add-Member -NotePropertyName id -NotePropertyValue "m1"
  $tpl = (Invoke-RestMethod "http://127.0.0.1:8799/api/templates").builtin.hormozi_pop
  $proj = @{
    canvas = @{ width = 1080; height = 1920; fps = 30; background = "#000000" }
    media = @{ m1 = $info }
    tracks = @(
      @{ id = "t"; kind = "text"; clips = @(@{ id = "x"; start = 0; dur = 2; text = "Prueba"; style = @{ font = "Anton"; size = 120; color = "#FFE600" }; x = 0.5; y = 0.3; animIn = @{ type = "pop"; dur = 0.4 } }) },
      @{ id = "main"; kind = "video"; main = $true; clips = @(@{ id = "c"; mediaId = "m1"; start = 0; dur = 3; in = 0; fit = "cover"; animIn = @{ type = "zoom_in"; dur = 0.5 } }) }
    )
    subtitles = @{ words = @(@{ text = "hola"; start = 0.2; end = 0.8 }, @{ text = "mundo"; start = 0.8; end = 1.5 }); template = $tpl; keywords = @(); enabled = $true }
  }
  $body = @{ project = $proj; out = "$env:RUNNER_TEMP\out.mp4"; quality = "liviana" } | ConvertTo-Json -Depth 12
  $job = (Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "http://127.0.0.1:8799/api/v2/export" -Body $body).job
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $s = Invoke-RestMethod "http://127.0.0.1:8799/api/job?id=$job"
    if ($s.status -ne "running") { break }
  }
  if ($s.status -ne "done") { throw "La exportación falló: $($s.message)" }
  if ((Get-Item "$env:RUNNER_TEMP\out.mp4").Length -lt 10000) { throw "Video exportado vacío" }
  Write-Host "OK: motor, transcripción (librerías), FFmpeg con libass y exportación funcionando"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
