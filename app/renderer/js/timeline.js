// Línea de tiempo multipista estilo CapCut.
import {
  $, $$, state, on, emit, media, clipEnd, duration, clamp, findClip, getTrack, mainTrack, beginLive, live, endLive, edit,
  overlaps, addTrack, maxDur, esc, clipKind, fmt, defaultVisual, defaultAudio, trackWithRoom, compactMain
} from './core.js'
import { seek, pause } from './preview.js'

const scroll = $('#tlScroll'); const inner = $('#tlInner'); const rows = $('#tlRows'); const ruler = $('#tlRuler')
const heads = $('#tlHeads'); const head = $('#tlHead'); const snapLine = $('#tlSnap')
const LEFT = 12 // margen izquierdo en px
const ROW_H = { subs: 28, text: 34, video: 50, main: 66, audio: 44 }
const X = (t) => LEFT + t * state.pps
const T = (x) => (x - LEFT) / state.pps

// ---------------------------------------------------------------- zoom
const zoomEl = $('#tlZoom')
const ppsFromZoom = (v) => 4 * Math.pow(100, v / 1000) // 4 .. 400 px/s
const zoomFromPps = (p) => Math.round(1000 * Math.log(p / 4) / Math.log(100))
export function setPps (p, anchorT = state.time) {
  const vx = X(anchorT) - scroll.scrollLeft
  state.pps = clamp(p, 4, 400); zoomEl.value = zoomFromPps(state.pps)
  render(); scroll.scrollLeft = Math.max(0, X(anchorT) - vx)
}
export function fit () {
  const d = Math.max(duration(), 5); setPps((scroll.clientWidth - 60) / d, 0); scroll.scrollLeft = 0
}
zoomEl.addEventListener('input', () => setPps(ppsFromZoom(+zoomEl.value)))
$('#tbZoomIn').onclick = () => setPps(state.pps * 1.35)
$('#tbZoomOut').onclick = () => setPps(state.pps / 1.35)
$('#tbFit').onclick = fit
scroll.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault()
    const r = scroll.getBoundingClientRect(); const t = T(e.clientX - r.left + scroll.scrollLeft)
    setPps(state.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), t)
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
    // rueda vertical = desplazamiento horizontal, salvo si hay muchas pistas
    if (scroll.scrollHeight <= scroll.clientHeight + 4) { e.preventDefault(); scroll.scrollLeft += e.deltaY }
  }
}, { passive: false })
scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop })

// ---------------------------------------------------------------- render
function rowsModel () {
  const p = state.project; const out = []
  if (p.subtitles.words.length) out.push({ id: 'subs', kind: 'subs', h: ROW_H.subs })
  for (const t of p.tracks) out.push({ id: t.id, kind: t.kind, track: t, h: t.main ? ROW_H.main : ROW_H[t.kind] })
  return out
}
function thumbsUrl (m) { return `/api/thumbs?path=${encodeURIComponent(m.path)}&type=${m.type}&dur=${m.duration || 1}` }
function waveUrl (m) { return `/api/wave?path=${encodeURIComponent(m.path)}` }

function clipHTML (c, track) {
  const kind = clipKind(c); const m = media(c.mediaId)
  let bg = ''
  if (m && (kind === 'video' || kind === 'audio')) {
    const full = (m.duration / (c.speed || 1)) * state.pps; const off = ((c.in || 0) / (c.speed || 1)) * state.pps
    const url = kind === 'audio' ? waveUrl(m) : thumbsUrl(m)
    bg = `<div class="bgimg" style="background-image:url('${url}');background-size:${full}px 100%;background-position:${-off}px 0"></div>`
  } else if (m && kind === 'image') bg = `<div class="bgimg" style="background-image:url('${thumbsUrl(m)}')"></div>`
  const label = kind === 'text' ? esc(String(c.text).split('\n')[0]) : esc(m ? m.name : '¿?')
  const badges = []
  if (c.speed && c.speed !== 1) badges.push(`${c.speed}x`)
  if (c.muted) badges.push('🔇')
  if (c.filter && c.filter !== 'none') badges.push('◐')
  if ((c.animIn && c.animIn.type !== 'none') || (c.animOut && c.animOut.type !== 'none')) badges.push('✦')
  const sel = state.sel?.kind === 'clip' && state.sel.id === c.id
  const fi = c.fadeIn ? `<div class="fadeL" style="width:${c.fadeIn * state.pps}px"></div>` : ''
  const fo = c.fadeOut ? `<div class="fadeR" style="width:${c.fadeOut * state.pps}px"></div>` : ''
  return `<div class="clip ${kind}${sel ? ' sel' : ''}" data-id="${c.id}" style="left:${X(c.start)}px;width:${Math.max(4, c.dur * state.pps)}px">
    ${bg}${fi}${fo}<div class="lab">${kind === 'text' ? 'T ' : ''}${label}${kind !== 'text' ? ` <span style="opacity:.7">${fmt(c.dur)}</span>` : ''}</div>
    <div class="badges">${badges.join(' ')}</div><div class="hl"></div><div class="hr"></div></div>`
}

export function render () {
  const p = state.project; if (!p) return
  const d = duration()
  const width = Math.max(scroll.clientWidth, X(d + Math.max(10, d * 0.3)))
  inner.style.width = width + 'px'
  // regla
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const major = steps.find(s => s * state.pps >= 80) || 600
  const minor = steps.slice().reverse().find(s => s < major && s * state.pps >= 8)
  let rh = ''
  for (let t = 0; X(t) < width; t += major) rh += `<div class="tick" style="left:${X(t)}px">${fmt(t).replace(/\.0$/, '')}</div>`
  if (minor) for (let t = 0; X(t) < width; t += minor) if (Math.abs(t / major - Math.round(t / major)) > 1e-6) rh += `<div class="tick minor" style="left:${X(t)}px"></div>`
  ruler.innerHTML = rh
  // filas
  const model = rowsModel()
  let html = ''; let hh = ''
  for (const r of model) {
    if (r.kind === 'subs') {
      const sub = p.subtitles; let blocks = ''
      state.lines.forEach((idxs, li) => {
        const a = sub.words[idxs[0]]; const b = sub.words[idxs[idxs.length - 1]]; if (!a || !b) return
        const sel = state.sel?.kind === 'subline' && state.sel.line === li
        blocks += `<div class="clip sub${sel ? ' sel' : ''}" data-line="${li}" style="left:${X(a.start)}px;width:${Math.max(4, (b.end - a.start) * state.pps)}px"><div class="lab">${esc(idxs.map(i => sub.words[i].text).join(' '))}</div></div>`
      })
      html += `<div class="trow subs" data-row="subs" style="height:${r.h}px">${blocks}</div>`
      hh += `<div class="thead" style="height:${r.h}px"><span class="tk">💬 Subtítulos</span><button data-act="subs-toggle" class="${sub.enabled ? '' : 'off'}" title="Mostrar / ocultar">${sub.enabled ? '👁' : '⊘'}</button></div>`
      continue
    }
    const t = r.track
    html += `<div class="trow ${t.kind}${t.main ? ' main' : ''}" data-row="${t.id}" data-kind="${t.kind}" style="height:${r.h}px">${t.clips.map(c => clipHTML(c, t)).join('')}</div>`
    const name = t.main ? '🎬 Principal' : { video: '▣ Capa', audio: '♪ Audio', text: 'T Texto' }[t.kind]
    const eye = t.kind !== 'audio' ? `<button data-act="hide" data-track="${t.id}" class="${t.hidden ? 'off' : ''}" title="Ocultar">${t.hidden ? '⊘' : '👁'}</button>` : ''
    const mute = t.kind !== 'text' ? `<button data-act="mute" data-track="${t.id}" class="${t.muted ? 'off' : ''}" title="Silenciar pista">${t.muted ? '🔇' : '🔊'}</button>` : ''
    hh += `<div class="thead" style="height:${r.h}px"><span class="tk">${name}</span>${eye}${mute}</div>`
  }
  rows.innerHTML = html + (p.tracks.every(t => !t.clips.length) ? '<div class="tl-empty">Arrastra aquí videos, fotos o audio desde el panel Multimedia</div>' : '')
  heads.innerHTML = hh
  inner.style.height = (26 + model.reduce((a, r) => a + r.h + 1, 0) + 30) + 'px'
  updateHead()
}

export function updateHead () {
  const x = X(state.time); head.style.left = x + 'px'
  if (state.playing) {
    const vl = scroll.scrollLeft; const vw = scroll.clientWidth
    if (x > vl + vw - 60 || x < vl) scroll.scrollLeft = x - 80
  }
}
on('time', updateHead)
on('project', (d) => { render() })
on('lines', render)
on('select', () => {
  $$('.clip.sel', rows).forEach(e => e.classList.remove('sel'))
  if (state.sel?.kind === 'clip') $(`.clip[data-id="${state.sel.id}"]`, rows)?.classList.add('sel')
  if (state.sel?.kind === 'subline') $(`.clip[data-line="${state.sel.line}"]`, rows)?.classList.add('sel')
})

heads.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return
  if (b.dataset.act === 'subs-toggle') return edit(() => { state.project.subtitles.enabled = !state.project.subtitles.enabled })
  const t = getTrack(b.dataset.track); if (!t) return
  edit(() => { if (b.dataset.act === 'hide') t.hidden = !t.hidden; else t.muted = !t.muted })
})

// ---------------------------------------------------------------- cabezal y regla
function seekFromEvent (e) { const r = scroll.getBoundingClientRect(); seek(Math.max(0, T(e.clientX - r.left + scroll.scrollLeft))) }
function scrub (e) {
  pause(); seekFromEvent(e)
  const mv = (ev) => seekFromEvent(ev); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
}
ruler.addEventListener('pointerdown', scrub)
head.querySelector('.knob').addEventListener('pointerdown', (e) => { e.stopPropagation(); scrub(e) })

// ---------------------------------------------------------------- imán
function snapPoints (ignoreId) {
  const pts = [0, state.time]
  for (const t of state.project.tracks) for (const c of t.clips) if (c.id !== ignoreId) pts.push(c.start, clipEnd(c))
  return pts
}
function snapT (t, ignoreId, extra = []) {
  if (!state.snap) return { t, hit: null }
  const thr = 8 / state.pps; let best = null
  for (const p of [...snapPoints(ignoreId), ...extra]) { const d = Math.abs(p - t); if (d < thr && (!best || d < best.d)) best = { p, d } }
  return best ? { t: best.p, hit: best.p } : { t, hit: null }
}
function showSnap (t) { if (t == null) snapLine.hidden = true; else { snapLine.hidden = false; snapLine.style.left = X(t) + 'px' } }

// ---------------------------------------------------------------- arrastrar y recortar clips
let drag = null
rows.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const sub = e.target.closest('.clip.sub')
  if (sub) { const li = +sub.dataset.line; state.sel = { kind: 'subline', line: li }; emit('select'); seek(state.project.subtitles.words[state.lines[li][0]].start + 0.01); return }
  const el = e.target.closest('.clip')
  if (!el) { // clic en vacío: deseleccionar y mover cabezal
    state.sel = null; emit('select'); scrub(e); return
  }
  const f = findClip(el.dataset.id); if (!f) return
  if (state.sel?.id !== f.clip.id) { state.sel = { kind: 'clip', id: f.clip.id }; emit('select') }
  const mode = e.target.classList.contains('hl') ? 'left' : e.target.classList.contains('hr') ? 'right' : 'move'
  drag = { mode, el, f, x0: e.clientX, y0: e.clientY, orig: { start: f.clip.start, dur: f.clip.dur, in: f.clip.in || 0 }, moved: false }
  el.setPointerCapture(e.pointerId); e.preventDefault()
})
rows.addEventListener('pointermove', (e) => {
  if (!drag) return
  const dx = e.clientX - drag.x0; const dy = e.clientY - drag.y0
  if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
  if (!drag.moved) { drag.moved = true; beginLive(); drag.el.classList.add('dragging'); pause() }
  const c = drag.f.clip; const o = drag.orig; const dt = dx / state.pps
  if (drag.mode === 'move') {
    let s = Math.max(0, o.start + dt)
    const a = snapT(s, c.id); const b = snapT(s + c.dur, c.id)
    let hit = null
    if (a.hit != null && (b.hit == null || Math.abs(a.t - s) <= Math.abs(b.t - s - c.dur))) { s = a.t; hit = a.hit } else if (b.hit != null) { s = b.t - c.dur; hit = b.hit }
    showSnap(hit)
    drag.el.style.left = X(s) + 'px'
    drag.el.style.transform = `translateY(${dy}px)`
    drag.newStart = s
    $$('.trow.drop', rows).forEach(r => r.classList.remove('drop'))
    const row = rowAt(e.clientY, drag.f.track.kind); if (row) row.classList.add('drop')
    drag.row = row
  } else if (drag.mode === 'left') {
    const minStart = Math.max(0, o.start - o.in / (c.speed || 1))
    let s = clamp(o.start + dt, minStart, o.start + o.dur - 0.1)
    const sn = snapT(s, c.id); s = sn.t; showSnap(sn.hit)
    c.start = +s.toFixed(4); c.dur = +(o.start + o.dur - s).toFixed(4)
    if (c.in !== undefined) c.in = +(o.in + (s - o.start) * (c.speed || 1)).toFixed(4)
    drag.el.style.left = X(c.start) + 'px'; drag.el.style.width = c.dur * state.pps + 'px'
    seek(c.start); live()
  } else {
    let end = o.start + o.dur + dt
    const sn = snapT(end, c.id); end = sn.t; showSnap(sn.hit)
    c.dur = +clamp(end - o.start, 0.1, maxDur({ ...c, dur: 0 })).toFixed(4)
    drag.el.style.width = c.dur * state.pps + 'px'
    seek(Math.max(c.start, clipEnd(c) - 0.02)); live()
  }
})
function rowAt (y, kind) {
  for (const r of $$('.trow', rows)) {
    const b = r.getBoundingClientRect()
    if (y >= b.top && y < b.bottom) return r.dataset.kind === kind || (kind === 'video' && r.dataset.kind === 'video') ? r : null
  }
  return null
}
rows.addEventListener('pointerup', (e) => {
  if (!drag) return
  const d = drag; drag = null; showSnap(null)
  $$('.trow.drop', rows).forEach(r => r.classList.remove('drop'))
  if (!d.moved) return
  if (d.mode !== 'move') { endLive(); return }
  const c = d.f.clip; const from = d.f.track
  let to = d.row ? getTrack(d.row.dataset.row) : from
  // fuera de cualquier fila: arriba crea pista nueva (video/texto), abajo (audio)
  if (!d.row) {
    const rb = rows.getBoundingClientRect()
    if (e.clientY < rb.top + 26 || e.clientY > rb.bottom - 30) to = null
  }
  const s = d.newStart ?? c.start
  from.clips.splice(from.clips.indexOf(c), 1)
  if (to && to.main && state.magnet) {
    // pista principal: reordenar según la posición soltada
    const list = to.clips.filter(x => x !== c).sort((a, b) => a.start - b.start)
    const center = s + c.dur / 2; let idx = list.findIndex(x => center < x.start + x.dur / 2); if (idx < 0) idx = list.length
    list.splice(idx, 0, c); list.forEach((x, i) => { x.start = i === 0 ? 0 : list[i - 1].start + list[i - 1].dur })
    to.clips = list
  } else {
    c.start = +s.toFixed(4)
    if (!to || overlaps(to, c.start, clipEnd(c), c.id)) to = addTrack(from.kind, to || from)
    to.clips.push(c)
  }
  endLive()
})

// ---------------------------------------------------------------- soltar medios desde la biblioteca
scroll.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('text/capcraft-media')) return
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
  $$('.trow.drop', rows).forEach(r => r.classList.remove('drop'))
  const r = [...$$('.trow', rows)].find(r => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom })
  if (r) r.classList.add('drop')
})
scroll.addEventListener('dragleave', () => $$('.trow.drop', rows).forEach(r => r.classList.remove('drop')))
scroll.addEventListener('drop', (e) => {
  const id = e.dataTransfer.getData('text/capcraft-media'); if (!id) return
  e.preventDefault(); $$('.trow.drop', rows).forEach(r => r.classList.remove('drop'))
  const r = scroll.getBoundingClientRect(); const t = Math.max(0, T(e.clientX - r.left + scroll.scrollLeft))
  const row = [...$$('.trow', rows)].find(r => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom })
  addMediaAt(id, t, row ? getTrack(row.dataset.row) : null)
})

export function addMediaAt (mediaId, t, track = null) {
  const m = media(mediaId); if (!m) return
  edit(() => {
    if (m.type === 'audio') {
      const c = defaultAudio(mediaId, t, m.duration)
      let tr = track && track.kind === 'audio' ? track : null
      if (!tr || overlaps(tr, c.start, clipEnd(c))) tr = trackWithRoom('audio', c.start, clipEnd(c))
      tr.clips.push(c)
    } else {
      const dur = m.type === 'image' ? 4 : m.duration
      const c = defaultVisual(mediaId, t, dur)
      let tr = track && track.kind === 'video' ? track : mainTrack()
      if (tr.main) {
        if (state.magnet) { // insertar en la posición más cercana
          const list = tr.clips.slice().sort((a, b) => a.start - b.start)
          let idx = list.findIndex(x => t < x.start + x.dur / 2); if (idx < 0) idx = list.length
          c.start = idx === 0 ? -0.001 : clipEnd(list[idx - 1]) - 0.0001
        }
        tr.clips.push(c)
        compactMain()
      } else {
        if (overlaps(tr, c.start, clipEnd(c))) tr = trackWithRoom('video', c.start, clipEnd(c))
        tr.clips.push(c)
      }
    }
  })
  emit('fit-if-needed')
}
