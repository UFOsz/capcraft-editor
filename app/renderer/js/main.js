// Capcraft Editor v0.3 — arranque, proyectos, menú, atajos, guardado y exportación.
import {
  $, $$, state, on, emit, api, edit, undo, redo, canUndo, canRedo, resetHistory, newProject, findClip, selectedClip, splitClip,
  clipKind, mainTrack, duration, clone, uid, toast, modal, progressModal, pollJob, esc, fmt, fmtTC, bridge, RATIOS, trackWithRoom,
  clipEnd, overlaps, addTrack, defaultAudio, debounce
} from './core.js'
import { layout, play, pause, toggle, seek, initSubs, thumbnail, dropUnused, refreshAssNow } from './preview.js'
import { render as renderTimeline, fit } from './timeline.js'
import { renderLib, renderProps, importFiles, importDialog } from './panels.js'

// ---------------------------------------------------------------- guardado automático
let saving = false
const saveNow = async () => {
  if (!state.project || !state.projectId) return
  saving = true
  const th = thumbnail(); if (th) state.project.thumb = th
  state.project.modified = Date.now()
  try {
    await api.post('/api/projects/save', { id: state.projectId, project: state.project })
    const d = new Date(); $('#saveState').innerHTML = `<span class="dot">✓</span> Guardado automático: ${d.toLocaleTimeString('es-CO', { hour12: false })}`
  } catch (e) { $('#saveState').textContent = '⚠ No se pudo guardar'; console.warn(e) }
  saving = false
}
const autosave = debounce(saveNow, 1200)
on('project', (d) => {
  if (d?.live) return
  autosave(); updateTools(); dropUnused()
  $('#tDur').textContent = fmtTC(duration(), state.project.canvas.fps)
  $('#emptyStage').hidden = state.project.tracks.some(t => t.clips.length)
  const r = `${state.project.canvas.width}x${state.project.canvas.height}`; const sel = $('#selRatio')
  if ([...sel.options].some(o => o.value === r)) sel.value = r
})
on('time', () => { $('#tCur').textContent = fmtTC(state.time, state.project?.canvas.fps) })
on('play', () => { $('#btnPlay').textContent = state.playing ? '⏸' : '▶' })
on('select', updateTools)
on('fit-if-needed', () => { const d = duration(); const w = $('#tlScroll').clientWidth; if (d * state.pps > w * 1.5 || d * state.pps < w * 0.25) fit() })

// ---------------------------------------------------------------- abrir / crear proyectos
async function openProject (id, project) {
  pause()
  if (state.projectId && state.project) await saveNow()
  state.project = project; state.projectId = id; state.sel = null; state.time = 0; state.lines = []
  if (!project.subtitles) project.subtitles = { words: [], template: clone(state.templates.builtin.hormozi_pop), templateId: 'hormozi_pop', keywords: [], enabled: true }
  resetHistory()
  $('#home').hidden = true
  $('#projName').textContent = project.name
  document.title = `Capcraft Editor — ${project.name}`
  layout(); initSubs()
  emit('project', {}); emit('select'); emit('time')
  renderLib(); setTimeout(() => { fit(); refreshAssNow() }, 50)
}
async function showHome () {
  pause()
  if (state.project) await saveNow()
  const list = await api.get('/api/projects')
  $('#homeList').innerHTML = list.length ? list.map(p => `<div class="pcard" data-id="${p.id}">
      <div class="pth" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}">${p.thumb ? '' : '🎬'}</div>
      <div class="pinfo"><div class="pname">${esc(p.name)}</div><div class="muted small">${fmt(p.duration)} · ${new Date(p.modified * 1000).toLocaleDateString('es-CO')}</div></div>
      <button class="pdel" data-del="${p.id}" title="Eliminar proyecto">🗑</button></div>`).join('') : '<p class="muted">Todavía no tienes proyectos. Crea el primero.</p>'
  $('#home').hidden = false
}
$('#homeList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]')
  if (del) {
    e.stopPropagation()
    const ok = await modal({ title: 'Eliminar proyecto', body: 'Se borra el proyecto (tus videos originales no se tocan).', buttons: [{ label: 'Cancelar', value: false, cls: 'ghost' }, { label: 'Eliminar', value: true, cls: 'primary' }] })
    if (ok) { await api.post('/api/projects/delete', { id: del.dataset.del }); if (state.projectId === del.dataset.del) { state.project = null; state.projectId = null } showHome() }
    return
  }
  const card = e.target.closest('.pcard'); if (!card) return
  try { const p = await api.post('/api/projects/load', { id: card.dataset.id }); openProject(card.dataset.id, p) } catch (er) { toast(`No se pudo abrir: ${er.message}`, 'err') }
})
async function createProject () {
  let ratio = '9:16'
  const shapes = Object.entries(RATIOS).map(([k, [w, h]]) => { const s = 34 / Math.max(w, h); return `<div class="ratio${k === ratio ? ' on' : ''}" data-r="${k}"><div class="shape" style="width:${w * s}px;height:${h * s}px"></div>${k}</div>` }).join('')
  const name = await modal({
    title: 'Nuevo proyecto',
    body: `<div class="field">Nombre<input type="text" id="npName" value="Proyecto ${new Date().toLocaleDateString('es-CO')}"></div>Formato<div class="ratio-grid" id="npRatio">${shapes}</div>`,
    buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Crear', value: () => $('#npName').value.trim() || 'Proyecto', cls: 'accent' }],
    onOpen: () => {
      $('#npRatio').onclick = (e) => { const r = e.target.closest('.ratio'); if (!r) return; ratio = r.dataset.r; $$('.ratio').forEach(x => x.classList.toggle('on', x === r)) }
      const i = $('#npName'); i.focus(); i.select()
    }
  })
  if (!name) return
  const id = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36)
  await openProject(id, newProject(name, ratio))
  saveNow()
}
$('#homeNew').onclick = createProject

// ---------------------------------------------------------------- menú
$('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden }
document.addEventListener('click', () => { $('#menu').hidden = true })
$('#menu').addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act; if (!act) return
  $('#menu').hidden = true
  if (act === 'home') showHome()
  if (act === 'new') createProject()
  if (act === 'rename') rename()
  if (act === 'import') importDialog()
  if (act === 'devtools' && bridge) bridge.toggleDevtools()
  if (act === 'updates') window.__checkUpdates(true)
  if (act === 'about') {
    const info = bridge?.appInfo ? await bridge.appInfo() : { version: 'dev', packaged: false }
    modal({ title: 'Capcraft Editor', body: `Versión <b>${esc(info.version)}</b>${info.packaged ? '' : ' (modo desarrollo)'}<br>Editor de video con subtítulos animados por palabra.<br>${info.data ? `<span class="small mono">Datos: ${esc(info.data)}</span>` : ''}` })
  }
  if (act === 'shortcuts') {
    modal({ title: 'Atajos de teclado', body: `<div class="kbd">
      <b>Espacio</b><span>Reproducir / pausar</span><b>S · Ctrl+B</b><span>Dividir en el cabezal</span><b>Supr · Retroceso</b><span>Eliminar selección</span>
      <b>Ctrl+Z / Ctrl+Y</b><span>Deshacer / rehacer</span><b>Ctrl+D</b><span>Duplicar clip</span><b>← / →</b><span>Cuadro anterior / siguiente (Shift = 1 s)</span>
      <b>Inicio / Fin</b><span>Ir al principio / final</span><b>+ / −</b><span>Zoom de la línea de tiempo</span><b>Esc</b><span>Quitar selección</span>
      <b>Ctrl+rueda</b><span>Zoom en la línea de tiempo</span><b>Doble clic en video</b><span>Reproducir / pausar</span></div>` })
  }
})
async function rename () {
  if (!state.project) return
  const n = await modal({ title: 'Renombrar proyecto', input: state.project.name, buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Guardar', value: true, cls: 'accent' }] })
  if (n) { edit(() => { state.project.name = n }); $('#projName').textContent = n; document.title = `Capcraft Editor — ${n}` }
}
$('#projName').ondblclick = rename

// ---------------------------------------------------------------- herramientas de la línea de tiempo
function updateTools () {
  $('#tbUndo').disabled = !canUndo(); $('#tbRedo').disabled = !canRedo()
  const f = selectedClip()
  $('#tbDelete').disabled = !f; $('#tbDup').disabled = !f
  $('#tbDetach').disabled = !(f && clipKind(f.clip) === 'video' && !f.clip.muted && state.project.media[f.clip.mediaId]?.has_audio)
}
function doSplit () {
  const t = state.time; let f = selectedClip()
  // sin selección: divide el clip de la pista principal bajo el cabezal
  if (!f || t <= f.clip.start || t >= clipEnd(f.clip)) {
    const c = mainTrack().clips.find(c => t > c.start && t < clipEnd(c))
    f = c ? findClip(c.id) : null
  }
  if (!f) return toast('Pon el cabezal sobre un clip para dividirlo.')
  edit(() => { const r = splitClip(f.clip, t); if (r) { f.track.clips.push(r); state.sel = { kind: 'clip', id: r.id } } })
  emit('select')
}
function doDelete () {
  if (state.sel?.kind === 'subline') return
  const f = selectedClip(); if (!f) return
  edit(() => { f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); state.sel = null })
  emit('select')
}
function doDuplicate () {
  const f = selectedClip(); if (!f) return
  edit(() => {
    const c = clone(f.clip); c.id = uid('c'); c.start = clipEnd(f.clip)
    if (f.track.main) { f.track.clips.splice(f.track.clips.indexOf(f.clip) + 1, 0, c); c.start = clipEnd(f.clip) - 0.0001 } else {
      const tr = overlaps(f.track, c.start, clipEnd(c)) ? addTrack(f.track.kind, f.track) : f.track; tr.clips.push(c)
    }
    state.sel = { kind: 'clip', id: c.id }
  })
  emit('select')
}
function doDetach () {
  const f = selectedClip(); if (!f) return
  edit(() => {
    const c = f.clip; const a = defaultAudio(c.mediaId, c.start, c.dur)
    Object.assign(a, { in: c.in || 0, speed: c.speed || 1, volume: c.volume ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 })
    trackWithRoom('audio', a.start, clipEnd(a)).clips.push(a)
    c.muted = true
  })
  toast('Audio separado en su propia pista. El video quedó silenciado.', 'ok')
}
$('#tbUndo').onclick = undo; $('#tbRedo').onclick = redo
$('#tbSplit').onclick = doSplit; $('#tbDelete').onclick = doDelete; $('#tbDup').onclick = doDuplicate; $('#tbDetach').onclick = doDetach
$('#tbMagnet').onclick = () => { state.magnet = !state.magnet; $('#tbMagnet').classList.toggle('on', state.magnet); if (state.magnet) edit(() => {}) }
$('#tbSnap').onclick = () => { state.snap = !state.snap; $('#tbSnap').classList.toggle('on', state.snap) }

// ---------------------------------------------------------------- transporte
$('#btnPlay').onclick = toggle
$('#btnPrev').onclick = () => seek(0)
$('#btnNext').onclick = () => seek(duration())
$('#selRatio').onchange = (e) => { const [w, h] = e.target.value.split('x').map(Number); edit(() => { state.project.canvas.width = w; state.project.canvas.height = h }); setTimeout(layout, 0) }
$('#btnFull').onclick = () => { const s = $('#stage'); document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen() }

// divisor entre paneles y línea de tiempo
$('#splitter').addEventListener('pointerdown', (e) => {
  const y0 = e.clientY; const h0 = $('#timeline').getBoundingClientRect().height
  const mv = (ev) => { document.documentElement.style.setProperty('--tl-h', Math.max(150, Math.min(window.innerHeight - 300, h0 - (ev.clientY - y0))) + 'px') }
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); renderTimeline() }
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
})

// soltar archivos del explorador sobre el reproductor o la línea de tiempo
for (const zone of [$('#stage'), $('#timeline')]) {
  zone.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#stage').classList.add('drag') } })
  zone.addEventListener('dragleave', () => $('#stage').classList.remove('drag'))
  zone.addEventListener('drop', async (e) => {
    $('#stage').classList.remove('drag')
    if (!e.dataTransfer.files.length || !state.project) return
    e.preventDefault()
    const before = new Set(Object.keys(state.project.media))
    await importFiles([...e.dataTransfer.files])
    // agrega a la línea de tiempo lo recién importado
    const nuevos = Object.values(state.project.media).filter(m => !before.has(m.id))
    const { addMediaAt } = await import('./timeline.js')
    for (const m of nuevos) addMediaAt(m.id, m.type === 'audio' ? state.time : duration() + 1, m.type === 'audio' ? null : mainTrack())
  })
}

// ---------------------------------------------------------------- teclado
document.addEventListener('keydown', (e) => {
  if (!state.project || !$('#home').hidden) return
  const tag = (document.activeElement || {}).tagName
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || !$('#modal').hidden) return
  const ctrl = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase()
  const fps = state.project.canvas.fps || 30
  if (e.code === 'Space') { e.preventDefault(); toggle() } else if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo() } else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo() } else if ((k === 's' && !ctrl) || (ctrl && k === 'b')) { e.preventDefault(); doSplit() } else if (ctrl && k === 'd') { e.preventDefault(); doDuplicate() } else if (k === 'delete' || k === 'backspace') { e.preventDefault(); doDelete() } else if (k === 'arrowright') { e.preventDefault(); pause(); seek(state.time + (e.shiftKey ? 1 : 1 / fps)) } else if (k === 'arrowleft') { e.preventDefault(); pause(); seek(state.time - (e.shiftKey ? 1 : 1 / fps)) } else if (k === 'home') seek(0)
  else if (k === 'end') seek(duration())
  else if (k === 'escape') { state.sel = null; emit('select') } else if (k === '+' || k === '=') $('#tbZoomIn').click()
  else if (k === '-') $('#tbZoomOut').click()
  else if (k === 'f12' && bridge) bridge.toggleDevtools()
})

// ---------------------------------------------------------------- exportar
$('#btnExport').onclick = async () => {
  if (!state.project) return
  if (!state.project.tracks.some(t => t.clips.length)) return toast('La línea de tiempo está vacía.', 'err')
  const p = state.project; const W = p.canvas.width; const H = p.canvas.height; const short = Math.min(W, H)
  const resOpts = [[1, `Original (${W}×${H})`], ...(short > 720 ? [[720 / short, `720p (${Math.round(W * 720 / short)}×${Math.round(H * 720 / short)})`]] : []), ...(short > 480 ? [[480 / short, '480p (liviano)']] : [])]
  const go = await modal({
    title: 'Exportar',
    body: `<div class="field">Nombre<input type="text" id="exName" value="${esc(p.name)}"></div>
      <div class="field">Resolución<select id="exRes">${resOpts.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
      <div class="field">Calidad<select id="exQ"><option value="alta">Alta (recomendada)</option><option value="media">Media</option><option value="liviana">Liviana</option></select></div>
      <label class="check"><input id="exSrt" type="checkbox" ${p.subtitles.words.length ? 'checked' : ''}> Guardar también los subtítulos en .srt</label>
      <p class="small">Duración: <b>${fmt(duration())}</b> · ${p.canvas.fps} fps · MP4 (H.264 + AAC)</p>`,
    buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Exportar…', value: () => ({ name: $('#exName').value.trim() || p.name, res: +$('#exRes').value, q: $('#exQ').value, srt: $('#exSrt').checked }), cls: 'accent' }]
  })
  if (!go) return
  let out = `${go.name.replace(/[\\/:*?"<>|]/g, '_')}.mp4`
  if (bridge) { out = await bridge.saveVideo(out); if (!out) return } else {
    out = await modal({ title: 'Ruta de salida', input: '/tmp/' + out, buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Exportar', value: true, cls: 'accent' }] }); if (!out) return
  }
  const pm = progressModal('Exportando video')
  try {
    const { job } = await api.post('/api/v2/export', { project: { ...p, thumb: undefined }, out, quality: go.q, res_scale: go.res, srt: go.srt })
    const r = await pollJob(job, pm.update)
    pm.close()
    const again = await modal({ title: '¡Video exportado! 🎉', body: `<span class="mono small">${esc(r.out)}</span>`, buttons: bridge ? [{ label: 'Cerrar', value: false, cls: 'ghost' }, { label: 'Mostrar en carpeta', value: true, cls: 'accent' }] : [{ label: 'Cerrar', value: false }] })
    if (again && bridge) bridge.showInFolder(r.out)
  } catch (e) { pm.close(); modal({ title: 'Error al exportar', body: `<pre class="mono small" style="white-space:pre-wrap;max-height:300px;overflow:auto">${esc(e.message)}</pre>` }) }
}

// ---------------------------------------------------------------- actualizaciones
const badge = $('#updBadge')
async function checkUpdates (manual = false) {
  if (!bridge?.checkUpdates) return manual && toast('Las actualizaciones automáticas funcionan en la versión instalada.', '')
  if (manual) toast('Buscando actualizaciones…')
  const r = await bridge.checkUpdates()
  if (!manual) return
  if (r.status === 'dev') toast('Estás usando la versión de desarrollo: las actualizaciones automáticas funcionan en la versión instalada.')
  else if (r.status === 'error') toast(`No se pudo buscar actualizaciones: ${r.message}`, 'err')
}
if (bridge?.onUpdate) {
  bridge.onUpdate((u) => {
    if (u.status === 'available') { badge.hidden = false; badge.className = 'upd-badge'; badge.textContent = `⬇ Descargando ${u.version}…`; toast(`Nueva versión ${u.version}: descargando en segundo plano.`) }
    if (u.status === 'downloading') { badge.hidden = false; badge.textContent = `⬇ Actualización ${u.percent} %` }
    if (u.status === 'ready') { badge.hidden = false; badge.className = 'upd-badge ready'; badge.textContent = `↻ Reiniciar para actualizar a ${u.version}` }
    if (u.status === 'none' && manualCheck) { toast(`Ya tienes la última versión (${u.version}).`, 'ok'); manualCheck = false }
    if (u.status === 'error' && manualCheck) { toast(`Error al actualizar: ${u.message}`, 'err'); manualCheck = false }
  })
  badge.onclick = () => { if (badge.classList.contains('ready')) { saveNow().finally(() => bridge.installUpdate()) } }
}
let manualCheck = false
const _cu = checkUpdates
// marca la búsqueda manual para avisar también si no hay nada nuevo
window.__checkUpdates = (m) => { manualCheck = m; return _cu(m) }

// ---------------------------------------------------------------- arranque
async function boot () {
  try {
    state.fonts = await api.get('/api/fonts')
    const css = state.fonts.map(f => `@font-face{font-family:'${f.family}';src:url('/fonts/${encodeURIComponent(f.file)}')}`).join('\n')
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st)
    state.fonts.forEach(f => document.fonts.load(`40px "${f.family}"`).catch(() => {}))
    state.templates = await api.get('/api/templates')
    const q = new URLSearchParams(location.search)
    if (q.get('project')) { const p = await api.post('/api/projects/load', { id: q.get('project') }); return openProject(q.get('project'), p) }
    const list = await api.get('/api/projects')
    if (list.length) { const p = await api.post('/api/projects/load', { id: list[0].id }); openProject(list[0].id, p) } else showHome()
  } catch (e) { toast(`No se pudo iniciar: ${e.message}`, 'err'); console.error(e) }
}
window.addEventListener('beforeunload', () => { if (state.project) navigator.sendBeacon && saveNow() })
boot()
window.__cc = state
