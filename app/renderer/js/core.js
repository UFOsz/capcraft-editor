// Núcleo: estado, eventos, historial (deshacer/rehacer), utilidades y operaciones de proyecto.
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]
export const bridge = window.capcraft || null

export const state = {
  project: null,
  projectId: null,
  time: 0,
  playing: false,
  sel: null, // {kind:'clip', id} | {kind:'subline', line} | {kind:'subs'} | null
  lines: [], // agrupación de líneas de subtítulos (índices de palabras)
  fonts: [],
  templates: { builtin: {}, custom: {} },
  pps: 60, // pixeles por segundo en la línea de tiempo
  snap: true,
  magnet: true,
  boxAll: true
}

// ---------------------------------------------------------------- eventos
const listeners = {}
export function on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) }
export function emit (ev, data) { (listeners[ev] || []).forEach(fn => { try { fn(data) } catch (e) { console.error(e) } }) }

// ---------------------------------------------------------------- utilidades
export const clone = (o) => JSON.parse(JSON.stringify(o))
export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9)
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Saneamiento de datos que vienen de proyectos/plantillas (pueden ser archivos de terceros)
export const safeColor = (v, d = '#FFFFFF') => (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v)) ? (v[0] === '#' ? v : '#' + v) : d
export const safeFont = (v, d = 'Anton') => String(v ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 60).trim() || d
export const cssUrl = (u) => String(u).replace(/['"()\\\s<>]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
export const safeThumb = (t) => (typeof t === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(t)) ? t : null
export const norm = (s) => s.toLowerCase().replace(/[,.;:¿?¡!…"'«»“”]/g, '').trim()
export function fmtTC (t, fps = 30) {
  t = Math.max(0, t || 0)
  const h = Math.floor(t / 3600); const m = Math.floor(t / 60) % 60; const s = Math.floor(t) % 60; const f = Math.floor((t % 1) * fps)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}
export function fmt (t) {
  t = Math.max(0, t || 0); const m = Math.floor(t / 60); const s = t - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

export const api = {
  async get (p) { const r = await fetch(p); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j },
  async post (p, body) {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j
  }
}
export async function pollJob (id, onProgress) {
  for (;;) {
    const j = await api.get(`/api/job?id=${id}`)
    onProgress && onProgress(j)
    if (j.status === 'done') return j.result
    if (j.status === 'error') throw new Error(j.message)
    await new Promise(r => setTimeout(r, 400))
  }
}

export function toast (msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), kind === 'err' ? 9000 : 3500)
}
export function modal ({ title, body = '', buttons = [{ label: 'Aceptar', value: true, cls: 'accent' }], input = null, onOpen = null }) {
  return new Promise(resolve => {
    $('#modalTitle').textContent = title
    $('#modalBody').innerHTML = body + (input !== null ? `<input id="modalInput" type="text" value="${esc(input)}">` : '')
    const btns = $('#modalBtns'); btns.innerHTML = ''
    const close = (v) => { $('#modal').hidden = true; resolve(v) }
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = `btn ${b.cls || ''}`; el.textContent = b.label
      el.onclick = () => close(typeof b.value === 'function' ? b.value() : (input !== null && b.value === true ? $('#modalInput').value.trim() : b.value))
      btns.appendChild(el)
    }
    $('#modal').hidden = false
    const inp = $('#modalInput')
    if (inp) { inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === 'Enter') close(inp.value.trim()); if (e.key === 'Escape') close(null) } }
    onOpen && onOpen()
  })
}
export function progressModal (title) {
  $('#modalTitle').textContent = title
  $('#modalBody').innerHTML = '<div class="progress"><div id="pbar"></div></div><div id="pmsg" class="small"></div>'
  $('#modalBtns').innerHTML = ''; $('#modal').hidden = false
  return {
    update (j) { $('#pbar').style.width = `${Math.round((j.progress || 0) * 100)}%`; $('#pmsg').textContent = j.message || '' },
    close () { $('#modal').hidden = true }
  }
}

// ---------------------------------------------------------------- historial
const undoStack = []; const redoStack = []
let liveSnap = null
const snap = () => JSON.stringify({ ...state.project, thumb: undefined })
function restore (s) {
  const thumb = state.project.thumb
  state.project = JSON.parse(s); state.project.thumb = thumb
  if (state.sel?.kind === 'clip' && !findClip(state.sel.id)) state.sel = null
  emit('project', { history: true }); emit('select')
}
export function edit (fn, { silent = false } = {}) {
  undoStack.push(snap()); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0
  fn()
  cleanup()
  emit('project', { silent })
}
export function beginLive () { if (!liveSnap) liveSnap = snap() }
export function live () { emit('project', { live: true }) }
export function endLive () {
  if (liveSnap) { undoStack.push(liveSnap); redoStack.length = 0; liveSnap = null }
  cleanup(); emit('project', {})
}
export function undo () { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()) }
export function redo () { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()) }
export function resetHistory () { undoStack.length = 0; redoStack.length = 0 }
export const canUndo = () => undoStack.length > 0
export const canRedo = () => redoStack.length > 0

// ---------------------------------------------------------------- proyecto
export const RATIOS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440], '21:9': [2560, 1080] }

export function newProject (name, ratio = '9:16') {
  const [w, h] = RATIOS[ratio] || RATIOS['9:16']
  const tpl = state.templates.builtin.hormozi_pop || Object.values(state.templates.builtin)[0]
  return {
    version: 3, name, created: Date.now(),
    canvas: { width: w, height: h, fps: 30, background: '#000000' },
    media: {},
    tracks: [
      { id: 'main', kind: 'video', main: true, clips: [] },
      { id: uid('a'), kind: 'audio', clips: [] }
    ],
    subtitles: { words: [], templateId: 'hormozi_pop', template: clone(tpl), keywords: [], enabled: true }
  }
}

export const P = () => state.project
export const media = (id) => state.project.media[id]
export const mainTrack = () => state.project.tracks.find(t => t.main)
export const getTrack = (id) => state.project.tracks.find(t => t.id === id)
export function findClip (id) {
  for (const t of state.project?.tracks || []) {
    const i = t.clips.findIndex(c => c.id === id)
    if (i >= 0) return { track: t, clip: t.clips[i], index: i }
  }
  return null
}
export function selectedClip () { return state.sel?.kind === 'clip' ? findClip(state.sel.id) : null }
export const clipEnd = (c) => c.start + c.dur
export function duration () {
  let d = 0
  for (const t of state.project?.tracks || []) for (const c of t.clips) d = Math.max(d, clipEnd(c))
  return d
}
export function maxDur (c) {
  const m = c.mediaId && media(c.mediaId)
  if (!m || m.type === 'image' || c.kind === 'text') return Infinity
  return (m.duration - (c.in || 0)) / (c.speed || 1)
}
export function clipKind (c) { if (c.text !== undefined) return 'text'; const m = media(c.mediaId); return m ? m.type : 'video' }

// Inserta una pista nueva en su lugar (texto arriba, videos superpuestos sobre la principal, audio abajo).
export function addTrack (kind, near = null) {
  const T = state.project.tracks
  const t = { id: uid(kind[0]), kind, clips: [] }
  if (kind === 'text') {
    const i = near ? T.indexOf(near) : 0
    T.splice(Math.max(0, i), 0, t)
  } else if (kind === 'video') {
    const i = near && !near.main ? T.indexOf(near) : T.indexOf(mainTrack())
    T.splice(i, 0, t)
  } else {
    const i = near ? T.indexOf(near) + 1 : T.length
    T.splice(i, 0, t)
  }
  return t
}
export function overlaps (track, start, end, ignoreId = null) {
  return track.clips.some(c => c.id !== ignoreId && start < clipEnd(c) - 1e-3 && end > c.start + 1e-3)
}
// Busca una pista del tipo dado con espacio libre en [start, end), o crea una.
export function trackWithRoom (kind, start, end, preferMain = false) {
  if (kind === 'video' && preferMain) return mainTrack()
  const list = state.project.tracks.filter(t => t.kind === kind && !t.main)
  const free = (kind === 'video' ? [...list].reverse() : list).find(t => !overlaps(t, start, end))
  return free || addTrack(kind)
}
export function compactMain () {
  const m = mainTrack(); if (!m || !state.magnet) return
  m.clips.sort((a, b) => a.start - b.start)
  let t = 0
  for (const c of m.clips) { c.start = +t.toFixed(4); t += c.dur }
}
export function cleanup () {
  const p = state.project; if (!p) return
  compactMain()
  for (const t of p.tracks) t.clips.sort((a, b) => a.start - b.start)
  // quita pistas vacías (deja la principal y al menos una de audio)
  p.tracks = p.tracks.filter(t => t.main || t.clips.length || (t.kind === 'audio' && p.tracks.filter(x => x.kind === 'audio').indexOf(t) === 0))
}

// ---------------------------------------------------------------- clips
export function defaultVisual (mediaId, start, dur) {
  return {
    id: uid('c'), mediaId, start, dur, in: 0, speed: 1, volume: 1, muted: false, fit: 'contain',
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false,
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, temperature: 0 }, filter: 'none',
    animIn: { type: 'none', dur: 0.5 }, animOut: { type: 'none', dur: 0.5 }, fadeIn: 0, fadeOut: 0
  }
}
export function defaultAudio (mediaId, start, dur) {
  return { id: uid('a'), mediaId, start, dur, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 }
}
export const TEXT_PRESETS = {
  basico: { name: 'Texto predeterminado', style: { font: 'Poppins ExtraBold', size: 90, color: '#FFFFFF', outline: 0, outline_color: '#000000', shadow: 3, shadow_color: '#000000' } },
  titulo: { name: 'Título grande', style: { font: 'Anton', size: 150, color: '#FFFFFF', outline: 8, outline_color: '#000000', shadow: 0 } },
  amarillo: { name: 'Llamativo amarillo', style: { font: 'Anton', size: 120, color: '#FFE600', outline: 7, outline_color: '#000000', shadow: 4, shadow_color: '#000000' } },
  caja: { name: 'Con caja', style: { font: 'Poppins Black', size: 80, color: '#111111', box: true, box_color: '#FFFFFF' } },
  neon: { name: 'Neón rosa', style: { font: 'Poppins Black', size: 96, color: '#FFFFFF', outline: 5, outline_color: '#FF2E88', shadow: 0 } },
  elegante: { name: 'Elegante', style: { font: 'Bebas Neue', size: 130, color: '#FFFFFF', outline: 0, shadow: 2, shadow_color: '#000000', spacing: 8 } },
  etiqueta: { name: 'Etiqueta', style: { font: 'Poppins ExtraBold', size: 70, color: '#FFFFFF', box: true, box_color: '#7C5CFF' } },
  cian: { name: 'Cian con borde', style: { font: 'Poppins Black', size: 100, color: '#22D3DB', outline: 6, outline_color: '#05282A', shadow: 0 } }
}
export function defaultText (start, preset = 'basico', text = 'Escribe tu texto') {
  const pr = TEXT_PRESETS[preset] || TEXT_PRESETS.basico
  return {
    id: uid('t'), start, dur: 3, text, style: clone(pr.style), x: 0.5, y: 0.5, scale: 1, rotation: 0,
    animIn: { type: 'none', dur: 0.5 }, animOut: { type: 'none', dur: 0.5 }
  }
}

export function splitClip (c, t) {
  if (t <= c.start + 0.05 || t >= clipEnd(c) - 0.05) return null
  const right = clone(c); right.id = uid('c')
  const leftDur = t - c.start
  right.start = t; right.dur = c.dur - leftDur
  if (c.in !== undefined) right.in = (c.in || 0) + leftDur * (c.speed || 1)
  c.dur = leftDur
  if (c.animOut) c.animOut = { type: 'none', dur: c.animOut.dur }
  if (right.animIn) right.animIn = { type: 'none', dur: right.animIn.dur }
  if (c.fadeOut) c.fadeOut = 0
  if (right.fadeIn) right.fadeIn = 0
  return right
}

// Elimina rangos de tiempo y desplaza lo que viene después (no corta las pistas de música).
export function rippleDelete (ranges) {
  ranges = ranges.map(r => [...r]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push(r) }
  const before = (t) => merged.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, t) - s), 0)
  for (const tr of state.project.tracks) {
    if (tr.kind === 'audio') continue
    const out = []
    for (const c of tr.clips) {
      let pieces = [[c.start, clipEnd(c)]]
      for (const [s, e] of merged) {
        const next = []
        for (const [a, b] of pieces) { if (e <= a || s >= b) { next.push([a, b]); continue } if (s > a) next.push([a, s]); if (e < b) next.push([e, b]) }
        pieces = next
      }
      pieces.filter(([a, b]) => b - a > 0.04).forEach(([a, b], k) => {
        const n = k === 0 ? c : { ...clone(c), id: uid('c') }
        if (c.in !== undefined) n.in = (c.in || 0) + (a - c.start) * (c.speed || 1)
        n.start = +(a - before(a)).toFixed(4); n.dur = +(b - a).toFixed(4)
        out.push(n)
      })
    }
    tr.clips = out
  }
  const sub = state.project.subtitles
  sub.words = sub.words.filter(w => !merged.some(([s, e]) => (w.start + w.end) / 2 >= s && (w.start + w.end) / 2 < e))
    .map(w => ({ ...w, start: +(w.start - before(w.start)).toFixed(3), end: +(w.end - before(w.end)).toFixed(3) }))
}
