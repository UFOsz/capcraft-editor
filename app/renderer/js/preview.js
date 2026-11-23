// Vista previa: compone todas las pistas en un canvas y dibuja textos/subtítulos con libass (JASSUB).
import { $, state, on, emit, api, media, clipEnd, duration, clamp, findClip, beginLive, live, endLive, edit, debounce, norm, toast } from './core.js'

const comp = $('#comp'); const ctx = comp.getContext('2d')
const subsCanvas = $('#subsCanvas'); const screen = $('#screen'); const stage = $('#stage')
const pool = new Map() // clipId -> elemento <video>/<audio>
const imgs = new Map() // mediaId -> Image
let ps = 0.5 // escala interna del canvas respecto al lienzo del proyecto
let dirty = true
let jassub = null; let assReady = false; let lastDemand = -1; let busySince = 0
let clock = { t0: 0, time0: 0 }

export const W = () => state.project.canvas.width
export const H = () => state.project.canvas.height

// ---------------------------------------------------------------- tamaño
export function layout () {
  if (!state.project) return
  const r = stage.getBoundingClientRect()
  const ar = W() / H()
  let w = r.width - 24; let h = w / ar
  if (h > r.height - 24) { h = r.height - 24; w = h * ar }
  w = Math.max(40, Math.floor(w)); h = Math.max(40, Math.floor(h))
  screen.style.width = w + 'px'; screen.style.height = h + 'px'
  const dpr = window.devicePixelRatio || 1
  ps = Math.min(1, (h * dpr) / H())
  const cw = Math.round(W() * ps); const ch = Math.round(H() * ps)
  if (comp.width !== cw || comp.height !== ch) { comp.width = cw; comp.height = ch }
  if (jassub) { jassub._videoWidth = W(); jassub._videoHeight = H(); try { jassub.resize(cw, ch) } catch (e) { console.warn(e) } lastDemand = -1 }
  $('#playerInfo').textContent = `${W()}×${H()} · ${state.project.canvas.fps} fps`
  dirty = true; updateBox()
}
new ResizeObserver(() => layout()).observe(stage)

// ---------------------------------------------------------------- reloj y transporte
export function play () {
  if (!state.project || state.playing) return
  if (state.time >= duration() - 0.02) state.time = 0
  state.playing = true; clock = { t0: performance.now(), time0: state.time }
  emit('play')
}
export function pause () { if (!state.playing) return; state.playing = false; syncMedia(); emit('play') }
export function toggle () { state.playing ? pause() : play() }
export function seek (t) {
  state.time = clamp(t, 0, Math.max(0, duration()))
  if (state.playing) clock = { t0: performance.now(), time0: state.time }
  dirty = true; emit('time')
}

// ---------------------------------------------------------------- elementos de medios
function srcOf (m) { return `/media?path=${encodeURIComponent(m.preview || m.path)}` }
function elFor (c, m) {
  let el = pool.get(c.id)
  const want = srcOf(m)
  if (el && el.dataset.src !== want) { el.remove(); pool.delete(c.id); el = null }
  if (!el) {
    el = document.createElement(m.type === 'audio' ? 'audio' : 'video')
    el.preload = 'auto'; el.playsInline = true; el.dataset.src = want; el.src = want
    el.addEventListener('seeked', () => { dirty = true })
    el.addEventListener('loadeddata', () => { dirty = true })
    el.addEventListener('error', () => { if (m.type === 'video' && !m.preview) emit('needproxy', m.id) })
    $('#mediaPool').appendChild(el); pool.set(c.id, el)
  }
  return el
}
function image (m) {
  let im = imgs.get(m.id)
  if (!im) { im = new Image(); im.onload = () => { dirty = true }; im.src = srcOf(m); imgs.set(m.id, im) }
  return im
}
export function dropUnused () {
  const ids = new Set(); for (const t of state.project?.tracks || []) for (const c of t.clips) ids.add(c.id)
  for (const [id, el] of pool) if (!ids.has(id)) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); pool.delete(id) }
}

function fadeGain (c, local) {
  let g = 1
  if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn
  if (c.fadeOut > 0 && local > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - local) / c.fadeOut)
  return g
}

function syncMedia () {
  const t = state.time; const p = state.project; if (!p) return
  for (const tr of p.tracks) {
    if (tr.kind === 'text') continue
    for (const c of tr.clips) {
      const m = media(c.mediaId); if (!m || m.type === 'image') continue
      const el = elFor(c, m)
      const active = t >= c.start && t < clipEnd(c)
      const speed = c.speed || 1
      if (!active) {
        if (!el.paused) el.pause()
        // precarga: deja listo el siguiente clip
        if (c.start > t && c.start - t < 1.5 && Math.abs(el.currentTime - (c.in || 0)) > 0.1 && !el.seeking) el.currentTime = c.in || 0
        continue
      }
      const target = (c.in || 0) + (t - c.start) * speed
      const local = t - c.start
      el.muted = !!(c.muted || tr.muted || (tr.kind === 'video' && !m.has_audio))
      el.volume = clamp((c.volume ?? 1) * fadeGain(c, local), 0, 1)
      if (state.playing) {
        if (el.playbackRate !== speed) el.playbackRate = speed
        if (el.paused) { el.currentTime = target; el.play().catch(() => {}) } else if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.5 / (p.canvas.fps || 30) && !el.seeking) el.currentTime = target
      }
    }
  }
}

// ---------------------------------------------------------------- animaciones (igual que en la exportación)
const easeOut = (p) => 1 - Math.pow(1 - p, 3)
const easeIn = (p) => Math.pow(p, 3)
export function animState (c, t) {
  const local = t - c.start
  const ai = c.animIn || {}; const ao = c.animOut || {}
  const di = Math.min(Math.max(0.05, ai.dur || 0.5), c.dur); const dO = Math.min(Math.max(0.05, ao.dur || 0.5), c.dur)
  const pin = clamp(local / di, 0, 1); const pout = clamp((local - (c.dur - dO)) / dO, 0, 1)
  let alpha = 1; let zoom = 1; let dx = 0; let dy = 0
  const Wd = W(); const Hd = H()
  const ti = ai.type || 'none'; const to = ao.type || 'none'
  if (['fade', 'zoom_in', 'zoom_out'].includes(ti)) alpha *= pin
  if (['fade', 'zoom_in', 'zoom_out'].includes(to)) alpha *= 1 - pout
  if (ti === 'zoom_in') zoom *= 0.6 + 0.4 * easeOut(pin)
  if (ti === 'zoom_out') zoom *= 1.4 - 0.4 * easeOut(pin)
  if (to === 'zoom_in') zoom *= 1 + 0.4 * easeIn(pout)
  if (to === 'zoom_out') zoom *= 1 - 0.4 * easeIn(pout)
  const sl = { slide_left: [Wd, 0], slide_right: [-Wd, 0], slide_up: [0, Hd], slide_down: [0, -Hd] }
  if (sl[ti]) { dx += sl[ti][0] * (1 - easeOut(pin)); dy += sl[ti][1] * (1 - easeOut(pin)) }
  if (sl[to]) { dx -= sl[to][0] * easeIn(pout); dy -= sl[to][1] * easeIn(pout) }
  return { alpha, zoom, dx, dy }
}

const FILTER_CSS = {
  none: '', bn: 'grayscale(1)', sepia: 'sepia(1)', calido: 'sepia(.25) saturate(1.25)', frio: 'hue-rotate(-12deg) saturate(1.05) brightness(1.02)',
  vivido: 'saturate(1.5) contrast(1.1)', vintage: 'sepia(.45) contrast(.9) brightness(1.05)', cine: 'contrast(1.15) saturate(.85) hue-rotate(-6deg)',
  desvanecido: 'contrast(.85) brightness(1.05) saturate(.8)', dramatico: 'contrast(1.35) saturate(1.1) brightness(.97)'
}
export function cssFilter (c) {
  const k = c.color || {}; const f = []
  if (k.brightness) f.push(`brightness(${1 + k.brightness})`)
  if (k.contrast !== undefined && k.contrast !== 1) f.push(`contrast(${k.contrast})`)
  if (k.saturation !== undefined && k.saturation !== 1) f.push(`saturate(${k.saturation})`)
  if (k.hue) f.push(`hue-rotate(${k.hue}deg)`)
  if (k.temperature > 0) f.push(`sepia(${k.temperature * 0.35})`)
  if (k.temperature < 0) f.push(`hue-rotate(${k.temperature * 15}deg)`)
  if (FILTER_CSS[c.filter]) f.push(FILTER_CSS[c.filter])
  return f.join(' ') || 'none'
}

export function visualGeom (c) {
  const m = media(c.mediaId); const Wd = W(); const Hd = H()
  const mw = m?.width || Wd; const mh = m?.height || Hd
  const f = c.fit === 'cover' ? Math.max(Wd / mw, Hd / mh) : Math.min(Wd / mw, Hd / mh)
  const s = f * (c.scale || 1)
  return { cx: Wd / 2 + (c.x || 0) * Wd, cy: Hd / 2 + (c.y || 0) * Hd, w: mw * s, h: mh * s, rot: c.rotation || 0 }
}

// ---------------------------------------------------------------- dibujo
function draw () {
  const p = state.project; const t = state.time
  // si algún clip activo no está listo (buscando cuadro), conserva el cuadro anterior
  const active = []
  const vtracks = p.tracks.filter(tr => tr.kind === 'video' && !tr.hidden)
  for (let i = vtracks.length - 1; i >= 0; i--) {
    for (const c of vtracks[i].clips) {
      if (t < c.start || t >= clipEnd(c)) continue
      const m = media(c.mediaId); if (!m) continue
      const src = m.type === 'image' ? image(m) : elFor(c, m)
      const ready = m.type === 'image' ? src.complete && src.naturalWidth : src.readyState >= 2 && !src.seeking
      if (!ready) { dirty = true; return }
      active.push([c, src])
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1; ctx.filter = 'none'
  ctx.fillStyle = p.canvas.background || '#000'; ctx.fillRect(0, 0, comp.width, comp.height)
  for (const [c, src] of active) {
    const g = visualGeom(c); const a = animState(c, t)
    ctx.save()
    ctx.setTransform(ps, 0, 0, ps, 0, 0)
    ctx.translate(g.cx + a.dx, g.cy + a.dy)
    ctx.rotate((g.rot * Math.PI) / 180)
    ctx.scale((c.flipH ? -1 : 1) * a.zoom, (c.flipV ? -1 : 1) * a.zoom)
    ctx.globalAlpha = clamp((c.opacity ?? 1) * a.alpha, 0, 1)
    ctx.filter = cssFilter(c)
    ctx.drawImage(src, -g.w / 2, -g.h / 2, g.w, g.h)
    ctx.restore()
  }
  dirty = false
}

// ---------------------------------------------------------------- textos y subtítulos (libass)
export function initSubs () {
  if (jassub) return
  const availableFonts = { 'liberation sans': '/vendor/jassub/default.woff2' }
  for (const f of state.fonts) availableFonts[f.family.toLowerCase()] = `/fonts/${encodeURIComponent(f.file)}`
  jassub = new window.JASSUB({
    canvas: subsCanvas, subContent: '[Script Info]\nScriptType: v4.00+\n',
    workerUrl: '/vendor/jassub/jassub-worker.js', wasmUrl: '/vendor/jassub/jassub-worker.wasm',
    modernWasmUrl: '/vendor/jassub/jassub-worker-modern.wasm', availableFonts, fallbackFont: 'liberation sans'
  })
  setTimeout(() => { layout(); assReady = true; refreshAssNow() }, 600)
}
function demandSubs () {
  if (!jassub || !assReady) return
  const now = performance.now()
  if (jassub.busy && now - busySince > 600) jassub.busy = false // por si se queda colgado
  if (jassub.busy || Math.abs(lastDemand - state.time) < 1e-4) return
  jassub.busy = true; busySince = now; lastDemand = state.time
  jassub.sendMessage('demand', { time: state.time })
}
export async function refreshAssNow () {
  if (!state.project) return
  try {
    const r = await api.post('/api/v2/ass', { project: { ...state.project, thumb: undefined } })
    state.lines = r.lines
    if (jassub) { jassub.setTrack(r.ass); lastDemand = -1; setTimeout(() => { lastDemand = -1 }, 250) }
    emit('lines')
  } catch (e) { console.warn(e); toast(`Textos: ${e.message}`, 'err') }
}
export const refreshAss = debounce(refreshAssNow, 140)
let assTimer = null
export function refreshAssSoon () { if (assTimer) return; assTimer = setTimeout(() => { assTimer = null; refreshAssNow() }, 70) }

// ---------------------------------------------------------------- bucle
function frame (now) {
  if (state.project) {
    if (state.playing) {
      const t = clock.time0 + (now - clock.t0) / 1000
      const d = duration()
      if (t >= d) { state.time = d; pause() } else state.time = t
      dirty = true; emit('time')
    }
    syncMedia()
    if (dirty) draw()
    demandSubs()
    if (selItem) updateBox()
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
export function markDirty () { dirty = true }
on('project', (d) => { dirty = true; if (d?.live) refreshAssSoon(); else refreshAss() })

export function thumbnail () {
  try {
    const c = document.createElement('canvas'); const s = 180 / Math.max(comp.width, comp.height)
    c.width = Math.round(comp.width * s); c.height = Math.round(comp.height * s)
    const x = c.getContext('2d'); x.drawImage(comp, 0, 0, c.width, c.height); x.drawImage(subsCanvas, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.7)
  } catch { return null }
}

// ================================================================ edición directa en el lienzo
const measure = document.createElement('canvas').getContext('2d')
const BOX_KEYS = ['pos_x', 'pos_y', 'scale', 'rotation', 'flip_x', 'flip_y']
const PUNCT = /^[,.;:¿?¡!…"'«»“”]+|[,.;:¿?¡!…"'«»“”]+$/g
let selItem = null // {type:'clip'|'subline', id|line}
const fontScale = (fam) => (state.fonts.find(f => f.family === fam) || {}).ass_scale || 1

function lineEnd (li) {
  const t = state.project.subtitles.template; const L = state.lines; const w = state.project.subtitles.words
  const last = w[L[li][L[li].length - 1]]
  const next = L[li + 1] ? w[L[li + 1][0]].start : Infinity
  return Math.min(next, last.end + (t.animation === 'one_word' ? 0.5 : (t.hold ?? 0.35)))
}
export function activeLine (time = state.time) {
  const sub = state.project.subtitles
  if (!sub.enabled || !sub.words.length) return -1
  for (let li = 0; li < state.lines.length; li++) {
    const s = sub.words[state.lines[li][0]]?.start
    if (s != null && time >= s && time < lineEnd(li)) return li
  }
  return -1
}
function effBox (li) {
  const t = state.project.subtitles.template; const w = state.project.subtitles.words[state.lines[li][0]]
  const b = {}; for (const k of BOX_KEYS) b[k] = t[k]
  return { ...b, ...(w.box || {}) }
}
function sublineGeom (li) {
  const sub = state.project.subtitles; const t = sub.template; const Wd = W(); const Hd = H()
  const k = Math.min(Wd, Hd) / 1080; const kv = Hd / 1920
  const b = effBox(li); const sc = b.scale || 1; const size = t.size * k * sc
  let text = state.lines[li].map(i => sub.words[i].text).map(x => t.strip_punctuation !== false ? (x.replace(PUNCT, '') || x) : x).join(' ')
  if (t.uppercase) text = text.toUpperCase()
  measure.font = `${size * fontScale(t.font)}px "${t.font}"`
  let w = measure.measureText(text).width + (t.outline || 0) * k * sc * 2 + (t.animation === 'box' ? (t.box_outline || 16) * k * sc * 2 : 0)
  const maxW = Wd - 120 * k; const rows = Math.max(1, Math.ceil(w / maxW)); if (rows > 1) w = maxW
  const h = size * 1.05 * rows
  let cx = Wd / 2; let cy
  if (b.pos_x != null && b.pos_y != null) { cx = b.pos_x * Wd; cy = b.pos_y * Hd } else {
    const mv = (t.margin_v ?? 400) * kv
    cy = { lower: Hd - mv - h / 2, center: Hd / 2, upper: mv + h / 2 }[t.position || 'lower']
  }
  return { cx, cy, w, h, rot: b.rotation || 0, b }
}
export function textGeom (c) {
  const st = c.style || {}; const sc = c.scale || 1; const size = (st.size || 90) * sc
  measure.font = `${size * fontScale(st.font)}px "${st.font}"`
  const lines = String(c.text || ' ').split('\n')
  let w = Math.max(...lines.map(l => measure.measureText(l || ' ').width)) + (st.spacing || 0) * Math.max(...lines.map(l => l.length))
  w += st.box ? size * 0.56 : (st.outline || 0) * sc * 2
  const h = lines.length * size * 1.05 + (st.box ? size * 0.5 : 0)
  return { cx: (c.x ?? 0.5) * W(), cy: (c.y ?? 0.5) * H(), w, h, rot: c.rotation || 0 }
}
function geomOf (item) {
  if (item.type === 'subline') return item.line >= 0 && item.line < state.lines.length ? sublineGeom(item.line) : null
  const f = findClip(item.id); if (!f) return null
  return f.clip.text !== undefined ? textGeom(f.clip) : visualGeom(f.clip)
}
function viewScale () { return screen.clientWidth / W() }
function toCanvas (ev) { const r = screen.getBoundingClientRect(); const s = viewScale(); return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s } }
function inside (g, pt, pad = 10) {
  const a = (-g.rot * Math.PI) / 180; const px = pt.x - g.cx; const py = pt.y - g.cy
  const x = px * Math.cos(a) - py * Math.sin(a); const y = px * Math.sin(a) + py * Math.cos(a)
  return Math.abs(x) <= g.w / 2 + pad && Math.abs(y) <= g.h / 2 + pad
}
function hitTest (pt) {
  const t = state.time; const p = state.project
  const li = activeLine(); if (li >= 0 && inside(sublineGeom(li), pt)) return { type: 'subline', line: li }
  for (const tr of p.tracks) { // orden visual: de arriba hacia abajo
    if (tr.hidden || tr.kind === 'audio') continue
    for (const c of tr.clips) {
      if (t < c.start || t >= clipEnd(c)) continue
      const g = c.text !== undefined ? textGeom(c) : visualGeom(c)
      if (inside(g, pt, tr.main ? 0 : 6)) return { type: 'clip', id: c.id }
    }
  }
  return null
}

export function selectOnCanvas (item) {
  selItem = item
  if (!item) state.sel = null
  else if (item.type === 'subline') state.sel = { kind: 'subline', line: item.line }
  else state.sel = { kind: 'clip', id: item.id }
  emit('select'); updateBox()
}
on('select', () => {
  const s = state.sel
  if (!s) selItem = null
  else if (s.kind === 'subline') selItem = { type: 'subline', line: s.line }
  else if (s.kind === 'clip') { const f = findClip(s.id); selItem = f && f.track.kind !== 'audio' ? { type: 'clip', id: s.id } : null } else selItem = null
  updateBox()
})

export function updateBox () {
  const tb = $('#tbox'); const bar = $('#tbar')
  if (!state.project || !selItem) { tb.hidden = true; bar.hidden = true; return }
  // el subtítulo seleccionado sigue al que esté en pantalla
  if (selItem.type === 'subline') { const li = activeLine(); if (li >= 0) selItem.line = li }
  let g = geomOf(selItem)
  let visible = !!g
  if (g && selItem.type === 'clip') { const c = findClip(selItem.id).clip; visible = state.time >= c.start && state.time < clipEnd(c) }
  if (selItem.type === 'subline' && activeLine() < 0) visible = false
  bar.hidden = false
  const isSub = selItem.type === 'subline'
  $('#tbAllWrap').hidden = !isSub; $('#tbSep').hidden = !isSub
  if (!visible) { tb.hidden = true; return }
  const s = viewScale(); const pad = 6
  tb.hidden = false; tb.classList.toggle('sub', isSub)
  tb.style.left = `${(g.cx - g.w / 2) * s - pad}px`; tb.style.top = `${(g.cy - g.h / 2) * s - pad}px`
  tb.style.width = `${g.w * s + pad * 2}px`; tb.style.height = `${g.h * s + pad * 2}px`
  tb.style.transform = `rotate(${g.rot}deg)`
  let scale; let rot; let fx; let fy
  if (isSub) { scale = g.b.scale || 1; rot = g.b.rotation || 0; fx = g.b.flip_x; fy = g.b.flip_y; $('#tbOwn').hidden = !(state.boxAll && state.project.subtitles.words[state.lines[selItem.line][0]].box) } else {
    const c = findClip(selItem.id).clip; scale = c.scale || 1; rot = c.rotation || 0; fx = c.flipH; fy = c.flipV; $('#tbOwn').hidden = true
  }
  if (document.activeElement !== $('#tbScale')) $('#tbScale').value = Math.round(scale * 100)
  if (document.activeElement !== $('#tbRot')) $('#tbRot').value = Math.round(rot)
  $('#tbFlipX').classList.toggle('on', !!fx); $('#tbFlipY').classList.toggle('on', !!fy)
}

function applyPatch (item, patch) {
  if (item.type === 'subline') {
    const sub = state.project.subtitles; const map = { cx: 'pos_x', cy: 'pos_y' }; const out = {}
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'cx') out.pos_x = +(v / W()).toFixed(4); else if (k === 'cy') out.pos_y = +(v / H()).toFixed(4)
      else if (k === 'flipH') out.flip_x = v; else if (k === 'flipV') out.flip_y = v; else out[map[k] || k] = v
    }
    if (state.boxAll) Object.assign(sub.template, out)
    else { const w = sub.words[state.lines[item.line][0]]; w.box = { ...(w.box || {}), ...out } }
    return
  }
  const c = findClip(item.id).clip
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'cx') c.x = c.text !== undefined ? +(v / W()).toFixed(4) : +((v - W() / 2) / W()).toFixed(4)
    else if (k === 'cy') c.y = c.text !== undefined ? +(v / H()).toFixed(4) : +((v - H() / 2) / H()).toFixed(4)
    else c[k] = v
  }
}

let drag = null
const layer = $('#editLayer')
layer.addEventListener('pointerdown', (ev) => {
  if (!state.project || ev.button !== 0) return
  const pt = toCanvas(ev); const handle = ev.target.dataset?.h
  let item = handle ? selItem : hitTest(pt)
  if (!item) { selectOnCanvas(null); return }
  if (!handle && (!selItem || selItem.type !== item.type || selItem.id !== item.id || selItem.line !== item.line)) selectOnCanvas(item)
  item = selItem
  if (state.playing) pause()
  const g = geomOf(item); if (!g) return
  drag = { item, mode: handle || 'move', pt0: pt, g, sc: (item.type === 'subline' ? g.b.scale : findClip(item.id).clip.scale) || 1, moved: false,
    d0: Math.hypot(pt.x - g.cx, pt.y - g.cy) || 1, a0: Math.atan2(pt.y - g.cy, pt.x - g.cx) * 180 / Math.PI }
  layer.setPointerCapture(ev.pointerId); ev.preventDefault()
})
layer.addEventListener('pointermove', (ev) => {
  if (!state.project) return
  const pt = toCanvas(ev)
  if (!drag) { layer.classList.toggle('hover', !!hitTest(pt)); return }
  if (!drag.moved) { beginLive(); drag.moved = true }
  const { g } = drag
  if (drag.mode === 'move') {
    let cx = g.cx + pt.x - drag.pt0.x; let cy = g.cy + pt.y - drag.pt0.y
    const sx = Math.abs(cx - W() / 2) < W() * 0.012; const sy = Math.abs(cy - H() / 2) < H() * 0.008
    if (sx) cx = W() / 2; if (sy) cy = H() / 2
    $('#guideV').hidden = !sx; $('#guideH').hidden = !sy
    applyPatch(drag.item, { cx, cy })
  } else if (drag.mode === 'scale') {
    const d = Math.hypot(pt.x - g.cx, pt.y - g.cy)
    applyPatch(drag.item, { scale: +clamp(drag.sc * d / drag.d0, 0.05, 10).toFixed(3) })
  } else {
    let rot = g.rot + (Math.atan2(pt.y - g.cy, pt.x - g.cx) * 180 / Math.PI - drag.a0)
    rot = ((rot + 540) % 360) - 180
    if (ev.shiftKey) rot = Math.round(rot / 15) * 15; else for (const m of [-180, -90, 0, 90, 180]) if (Math.abs(rot - m) < 4) rot = m
    applyPatch(drag.item, { rotation: +rot.toFixed(1) })
  }
  dirty = true; live(); updateBox()
})
layer.addEventListener('pointerup', () => {
  if (!drag) return
  const moved = drag.moved; drag = null; $('#guideV').hidden = $('#guideH').hidden = true
  if (moved) endLive()
})
layer.addEventListener('dblclick', (ev) => { if (!hitTest(toCanvas(ev))) toggle() })

function barEdit (patch) { if (!selItem) return; edit(() => applyPatch(selItem, patch)); updateBox() }
$('#tbAll').addEventListener('change', (e) => { state.boxAll = e.target.checked; updateBox() })
$('#tbScale').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (isFinite(v)) barEdit({ scale: clamp(v / 100, 0.05, 10) }) })
$('#tbRot').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (isFinite(v)) barEdit({ rotation: clamp(v, -180, 180) }) })
function curFlip (k) {
  if (selItem.type === 'subline') return !!sublineGeom(selItem.line).b[k === 'flipH' ? 'flip_x' : 'flip_y']
  return !!findClip(selItem.id).clip[k]
}
$('#tbFlipX').onclick = () => selItem && barEdit({ flipH: !curFlip('flipH') })
$('#tbFlipY').onclick = () => selItem && barEdit({ flipV: !curFlip('flipV') })
$('#tbReset').onclick = () => {
  if (!selItem) return
  edit(() => {
    if (selItem.type === 'subline') {
      const sub = state.project.subtitles
      if (state.boxAll) for (const k of BOX_KEYS) delete sub.template[k]; else delete sub.words[state.lines[selItem.line][0]].box
    } else {
      const c = findClip(selItem.id).clip
      if (c.text !== undefined) Object.assign(c, { x: 0.5, y: 0.5, scale: 1, rotation: 0, flipH: false })
      else Object.assign(c, { x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false })
    }
  })
}
$('#tbOwnClear').onclick = () => { if (selItem?.type === 'subline') edit(() => { delete state.project.subtitles.words[state.lines[selItem.line][0]].box }) }
export { norm }
