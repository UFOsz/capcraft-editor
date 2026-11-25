// Paneles: biblioteca (izquierda) y propiedades (derecha).
import {
  $, $$, state, on, emit, api, edit, beginLive, live, endLive, media, findClip, selectedClip, clipKind, clone, esc, norm, fmt,
  toast, modal, progressModal, pollJob, uid, clamp, mainTrack, duration, defaultText, TEXT_PRESETS, trackWithRoom, clipEnd,
  rippleDelete, RATIOS, bridge, safeColor, safeFont, cssUrl
} from './core.js'
import { seek, refreshAssNow, layout, markDirty } from './preview.js'
import { addMediaAt } from './timeline.js'

// ================================================================ BIBLIOTECA
let libTab = 'media'
$('#libTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.ltab'); if (!b) return
  libTab = b.dataset.tab; $$('.ltab').forEach(x => x.classList.toggle('active', x === b)); renderLib()
})
export function renderLib () {
  const body = $('#libBody'); if (!state.project) { body.innerHTML = ''; return }
  body.innerHTML = ({ media: libMedia, audio: libAudio, text: libText, subs: libSubs, filters: libFilters, anims: libAnims }[libTab])()
  bindLib()
}
on('project', (d) => { if (!d?.live && (['media', 'subs', 'filters', 'anims'].includes(libTab) || (libTab === 'audio' && audioNav.kind === 'mine'))) renderLib() })
on('select', () => { if (['filters', 'anims'].includes(libTab)) renderLib() })

const thumbsUrl = (m) => cssUrl(`/api/thumbs?path=${encodeURIComponent(m.path)}&type=${encodeURIComponent(m.type)}&dur=${Number(m.duration) || 1}`)
const waveUrl = (m) => cssUrl(`/api/wave?path=${encodeURIComponent(m.path)}`)
function mediaCard (m) {
  const isA = m.type === 'audio'
  const style = isA ? `background-image:url('${waveUrl(m)}')` : `background-image:url('${thumbsUrl(m)}');background-size:${m.type === 'image' ? 'cover' : '2400% 100%'};background-position:0 0`
  return `<div class="mcard ${isA ? 'audio' : ''}" draggable="true" data-media="${esc(m.id)}" title="${esc(m.name)}">
    <div class="thumb" style="${style}"></div>
    <span class="kind">${{ video: '🎞', image: '🖼', audio: '♪' }[m.type]}</span>
    ${m.type !== 'image' ? `<span class="dur">${fmt(Number(m.duration) || 0)}</span>` : ''}
    <div class="name">${esc(m.name)}</div>
    <button class="add" data-add="${esc(m.id)}" title="Agregar a la línea de tiempo">+</button>
    ${m._busy ? `<div class="busy">${esc(m._busy)}</div>` : ''}</div>`
}
function libMedia () {
  const list = Object.values(state.project.media).filter(m => m.type !== 'audio')
  return `<button class="btn accent full" data-act="import">⬆ Importar videos y fotos</button>
    <div class="drop-hint" id="dropHint" style="margin-top:10px">o arrastra archivos aquí</div>
    <h4>En este proyecto (${list.length})</h4>
    <div class="media-grid">${list.map(mediaCard).join('') || '<p class="muted small">Aún no hay medios.</p>'}</div>
    <p class="muted small" style="margin-top:12px">Clic en <b>+</b> para agregar al final de la pista principal, o arrastra a la línea de tiempo para elegir la posición o crear una capa superpuesta.</p>`
}
// ---- audio: biblioteca de música por géneros (Openverse, solo licencias de uso comercial)
let audioNav = { kind: 'genre', id: 'tendencias' }
let musicGenres = null
let musicFavs = null
const musicCache = new Map() // clave -> {items, page, has_more}
let musicQuery = ''
let musicLoading = false
let openGroups = { music: true, sfx: false }
const previewAudio = new Audio(); previewAudio.preload = 'auto'
let previewId = null
previewAudio.addEventListener('ended', () => { previewId = null; markPlaying() })
const mmss = (s) => { s = Math.round(Number(s) || 0); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

function libAudio () {
  const list = Object.values(state.project.media).filter(m => m.type === 'audio')
  const g = musicGenres || { music: [], sfx: [] }
  const navBtn = (kind, id, label) => `<button class="anav${audioNav.kind === kind && (audioNav.id || '') === (id || '') ? ' on' : ''}" data-nav="${kind}:${esc(id || '')}">${esc(label)}</button>`
  const group = (key, title, items, kind) => `<button class="agroup" data-group="${key}">${title} <span>${openGroups[key] ? '▴' : '▾'}</span></button>
    ${openGroups[key] ? items.map(x => navBtn(kind, x.id, x.name)).join('') : ''}`
  const key = navKey()
  let right = ''
  if (audioNav.kind === 'mine') {
    right = `<div class="alist">${list.map(m => `<div class="arow" data-media="${esc(m.id)}" draggable="true">
        <div class="aicon">♪</div><div class="ainfo"><div class="at">${esc(m.title || m.name)}</div><div class="as">${esc(m.creator || 'Importado')} · ${mmss(m.duration)}</div></div>
        <button class="abtn" data-add="${esc(m.id)}" title="Agregar en el cabezal">＋</button></div>`).join('') || '<p class="muted small">Aquí aparecen los audios que importes o agregues desde la biblioteca.</p>'}</div>`
  } else {
    const data = audioNav.kind === 'favs' ? { items: musicFavs || [], has_more: false } : musicCache.get(key)
    const favIds = new Set((musicFavs || []).map(f => f.id))
    const rows = (data?.items || []).map(t => `<div class="arow" data-track="${esc(t.id)}">
        <button class="aplay" data-play="${esc(t.id)}" title="Escuchar">${previewId === t.id ? '⏸' : '▶'}</button>
        <div class="ainfo"><div class="at">${esc(t.title)}</div><div class="as">${esc(t.creator)} · ${mmss(t.duration)} <span class="lic${t.attribution_required ? ' by' : ''}" title="${esc(t.credit)}">${esc(t.license_name)}</span></div></div>
        <button class="abtn" data-fav="${esc(t.id)}" title="Favorito">${favIds.has(t.id) ? '★' : '☆'}</button>
        <button class="abtn add" data-get="${esc(t.id)}" title="Agregar en el cabezal">＋</button></div>`).join('')
    right = `<div class="asearch"><input type="text" id="musicQ" placeholder="Buscar música o efectos (en inglés funciona mejor)" value="${esc(musicQuery)}"></div>
      <div class="ahead">${esc(navLabel())}</div>
      <div class="alist">${rows || (musicLoading || !data ? '<p class="muted small">Cargando…</p>' : '<p class="muted small">Sin resultados.</p>')}
      ${data?.has_more ? '<button class="btn small full" data-act="music-more">Cargar más</button>' : ''}</div>
      <p class="muted small anote">Música con licencia Creative Commons <b>apta para uso comercial</b> (Openverse: Jamendo, Freesound, Wikimedia). Las marcadas <span class="lic by">CC BY</span> piden dar crédito al autor: al exportar te mostramos el texto para copiarlo en la descripción.</p>`
  }
  return `<div class="audio-lib"><nav class="anavs">
      <button class="btn accent small full" data-act="import-audio">⬆ Importar</button>
      ${navBtn('mine', '', `Tuyos (${list.length})`)}
      ${navBtn('favs', '', `★ Favoritos${musicFavs ? ` (${musicFavs.length})` : ''}`)}
      ${group('music', 'Música', g.music, 'genre')}
      ${group('sfx', 'Efectos de sonido', g.sfx, 'genre')}
    </nav><div class="amain">${right}</div></div>`
}
function navKey () { return audioNav.kind === 'genre' ? `${audioNav.id}|${musicQuery}` : audioNav.kind }
function navLabel () {
  if (musicQuery) return `Resultados: “${musicQuery}”`
  const all = [...(musicGenres?.music || []), ...(musicGenres?.sfx || [])]
  return audioNav.kind === 'favs' ? 'Favoritos' : (all.find(x => x.id === audioNav.id)?.name || '')
}
async function loadMusic (more = false) {
  if (audioNav.kind !== 'genre') return
  const key = navKey(); const cur = musicCache.get(key)
  if (cur && !more) return
  musicLoading = true
  const page = more && cur ? cur.page + 1 : 1
  try {
    const qs = new URLSearchParams({ genre: audioNav.id, page: String(page) }); if (musicQuery) qs.set('q', musicQuery)
    const r = await api.get(`/api/music/search?${qs}`)
    musicCache.set(key, { items: [...(more && cur ? cur.items : []), ...r.items], page: r.page, has_more: r.has_more })
  } catch (e) { toast(e.message, 'err'); if (!cur) musicCache.set(key, { items: [], page: 1, has_more: false }) }
  musicLoading = false
  if (libTab === 'audio' && navKey() === key) renderLib()
}
function findTrack (id) {
  for (const v of musicCache.values()) { const t = v.items.find(x => x.id === id); if (t) return t }
  return (musicFavs || []).find(x => x.id === id)
}
function markPlaying () { $$('[data-play]').forEach(b => { b.textContent = b.dataset.play === previewId ? '⏸' : '▶' }) }
async function getTrack (id, btn) {
  const old = btn?.textContent; if (btn) { btn.textContent = '…'; btn.disabled = true }
  try { return await api.post('/api/music/get', { id }) } catch (e) { toast(e.message, 'err'); return null } finally { if (btn) { btn.textContent = old; btn.disabled = false } }
}
async function addTrack (id, btn) {
  const meta = await getTrack(id, btn); if (!meta) return
  const added = await importPaths([meta.path], { quiet: true })
  const m = added[0]; if (!m) return
  edit(() => { const mm = media(m.id); Object.assign(mm, { name: meta.title, title: meta.title, creator: meta.creator, credit: meta.credit, license_name: meta.license_name, attribution_required: meta.attribution_required, landing: meta.landing }) })
  addMediaAt(m.id, state.time)
  toast(`“${meta.title}” agregado en el cabezal.${meta.attribution_required ? ' Recuerda dar crédito al autor (te lo mostramos al exportar).' : ''}`, 'ok')
}
function bindAudio (body) {
  if (!musicGenres) api.get('/api/music/genres').then(g => { musicGenres = g; if (libTab === 'audio') renderLib() }).catch(() => {})
  if (!musicFavs) api.get('/api/music/favs').then(f => { musicFavs = f; if (libTab === 'audio') renderLib() }).catch(() => { musicFavs = [] })
  if (audioNav.kind === 'genre' && !musicCache.get(navKey()) && !musicLoading) loadMusic()
  body.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
    const [kind, id] = b.dataset.nav.split(':'); audioNav = { kind, id }; if (kind !== 'genre') musicQuery = ''
    renderLib(); if (kind === 'genre') loadMusic()
  })
  body.querySelectorAll('[data-group]').forEach(b => b.onclick = () => { openGroups[b.dataset.group] = !openGroups[b.dataset.group]; renderLib() })
  const q = $('#musicQ', body)
  if (q) q.onkeydown = (e) => { if (e.key === 'Enter') { musicQuery = q.value.trim().slice(0, 80); if (audioNav.kind !== 'genre') audioNav = { kind: 'genre', id: 'tendencias' }; renderLib(); loadMusic() } }
  body.querySelectorAll('[data-play]').forEach(b => b.onclick = async () => {
    const id = b.dataset.play
    if (previewId === id) { previewAudio.pause(); previewId = null; markPlaying(); return }
    const meta = await getTrack(id, b); if (!meta) return
    previewAudio.src = `/media?path=${encodeURIComponent(meta.path)}`
    previewId = id; markPlaying(); previewAudio.play().catch(() => {})
  })
  body.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
    const id = b.dataset.fav; const t = findTrack(id); if (!t) return
    musicFavs = musicFavs || []
    const i = musicFavs.findIndex(x => x.id === id)
    if (i >= 0) musicFavs.splice(i, 1); else musicFavs.unshift(t)
    try { await api.post('/api/music/favs', { favs: musicFavs }) } catch (e) { toast(e.message, 'err') }
    renderLib()
  })
  body.querySelectorAll('[data-get]').forEach(b => b.onclick = () => addTrack(b.dataset.get, b))
  body.querySelectorAll('.arow[data-media]').forEach(r => r.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/capcraft-media', r.dataset.media) }))
}
export function musicCredits () {
  const used = new Set(); for (const t of state.project.tracks) for (const c of t.clips) if (c.mediaId) used.add(c.mediaId)
  return Object.values(state.project.media).filter(m => used.has(m.id) && m.credit && m.attribution_required).map(m => m.credit)
}

function libText () {
  return `<button class="btn accent full" data-text="basico">＋ Agregar texto</button>
    <h4>Estilos</h4>
    <div class="preset-grid">${Object.entries(TEXT_PRESETS).map(([k, p]) => {
      const s = p.style
      const css = `font-family:'${s.font}';font-size:20px;color:${s.color};${s.box ? `background:${s.box_color};padding:2px 8px;border-radius:5px;` : ''}${s.outline ? `-webkit-text-stroke:${Math.min(2, s.outline / 3)}px ${s.outline_color};paint-order:stroke fill;` : ''}${s.spacing ? `letter-spacing:${s.spacing / 4}px;` : ''}`
      return `<div class="preset" data-text="${k}"><span style="${css}">Texto</span><span class="lbl">${p.name}</span></div>`
    }).join('')}</div>
    <p class="muted small" style="margin-top:12px">El texto aparece en la posición del cabezal. Edítalo a la derecha o muévelo directamente en el video.</p>`
}

// ---- subtítulos
const ANIMS_SUB = [['pop', 'Pop'], ['karaoke', 'Karaoke'], ['box', 'Caja'], ['bounce', 'Rebote'], ['reveal', 'Máquina de escribir'], ['blur_in', 'Desenfoque'], ['rainbow', 'Arcoíris'], ['one_word', 'Una palabra'], ['dim', 'Línea tenue']]
export function tplSampleHTML (raw) {
  const t = { ...raw, font: safeFont(raw.font), color: safeColor(raw.color), highlight: raw.highlight && safeColor(raw.highlight, '#FFE600'),
    outline_color: safeColor(raw.outline_color, '#000000'), base_color: safeColor(raw.base_color), active_text: safeColor(raw.active_text),
    palette: Array.isArray(raw.palette) ? raw.palette.map(c => safeColor(c)) : null, outline: Number(raw.outline) || 0 }
  const words = t.uppercase ? ['HOLA', 'MUNDO'] : ['Hola', 'mundo']
  const stroke = `-webkit-text-stroke:${Math.min(3, t.outline / 2)}px ${t.outline_color};paint-order:stroke fill`
  const hl = t.highlight || (t.palette ? t.palette[1] || t.color : t.color); const a = t.animation
  let w1 = `<span style="color:${t.color}">${words[0]}</span>`; let w2 = `<span style="color:${hl}">${words[1]}</span>`
  if (a === 'box') w2 = `<span style="color:${t.active_text};background:${hl};border-radius:5px;padding:0 4px;-webkit-text-stroke:0">${words[1]}</span>`
  if (a === 'karaoke') w2 = `<span style="color:${t.base_color}">${words[1]}</span>`
  if (a === 'rainbow' || a === 'one_word') { const p = t.palette || [t.color]; w1 = `<span style="color:${p[0]}">${words[0]}</span>`; w2 = a === 'one_word' ? '' : `<span style="color:${p[1 % p.length]}">${words[1]}</span>` }
  if (a === 'dim') w1 = `<span style="color:${t.color};opacity:.45">${words[0]}</span>`
  return `<span style="font-family:'${t.font}';font-size:19px;${stroke}">${w1} ${w2}</span>`
}
function libSubs () {
  const sub = state.project.subtitles
  const tpls = state.templates
  const card = (id, t, custom) => `<div class="preset${sub.templateId === id ? ' active' : ''}" data-tpl="${esc(id)}">${tplSampleHTML(t)}<span class="lbl">${esc(t.name || id)}</span>${custom ? `<button class="del" data-deltpl="${esc(id)}">✕</button>` : ''}</div>`
  return `<h4>Subtítulos automáticos</h4>
    <div class="field">Idioma<select id="subLang"><option value="es">Español</option><option value="en">Inglés</option><option value="pt">Portugués</option><option value="">Detectar</option></select></div>
    <div class="field">Precisión<select id="subModel"><option value="small">Rápida (small)</option><option value="medium" selected>Recomendada (medium)</option><option value="large-v3">Máxima (large-v3)</option></select></div>
    <label class="check" style="margin-bottom:10px"><input type="checkbox" id="subMusic"> Incluir pistas de música (normalmente no)</label>
    <button class="btn accent full" data-act="transcribe">✨ Generar subtítulos</button>
    ${sub.words.length ? `<p class="muted small" style="margin:8px 0">${sub.words.length} palabras · ${state.lines.length} líneas. Clic en una línea de la fila 💬 para corregirla.</p>
      <div class="row gap wrap"><label class="check"><input type="checkbox" id="subOn" ${sub.enabled ? 'checked' : ''}> Mostrar subtítulos</label>
      <button class="btn small" data-act="sub-style">🎨 Editar estilo</button><button class="btn small danger" data-act="sub-clear">Borrar</button></div>
      <h4>Quitar silencios</h4>
      <div class="prow"><span>Silencio mín.</span><input type="range" id="silMin" min="0.25" max="2" step="0.05" value="0.6"><span class="val" id="silMinV">0.60 s</span></div>
      <div class="prow"><span>Margen</span><input type="range" id="silPad" min="0" max="0.4" step="0.01" value="0.12"><span class="val" id="silPadV">0.12 s</span></div>
      <button class="btn small full" data-act="silence">✂ Quitar silencios de todo el video</button>
      <p class="muted small">Corta las pausas en todas las pistas (menos la música) y reacomoda los subtítulos.</p>` : '<p class="muted small" style="margin-top:8px">Transcribe el audio de la línea de tiempo con la voz de los clips de video.</p>'}
    <h4>Plantillas</h4>
    <div class="preset-grid">${Object.entries(tpls.builtin).map(([k, t]) => card(k, t, false)).join('')}</div>
    ${Object.keys(tpls.custom).length ? `<h4>Mis plantillas</h4><div class="preset-grid">${Object.entries(tpls.custom).map(([k, t]) => card(k, t, true)).join('')}</div>` : ''}`
}

// ---- filtros y animaciones
const FILTERS = [['none', 'Ninguno', ''], ['bn', 'Blanco y negro', 'grayscale(1)'], ['sepia', 'Sepia', 'sepia(1)'], ['calido', 'Cálido', 'sepia(.25) saturate(1.25)'],
  ['frio', 'Frío', 'hue-rotate(-12deg) saturate(1.05)'], ['vivido', 'Vívido', 'saturate(1.5) contrast(1.1)'], ['vintage', 'Vintage', 'sepia(.45) contrast(.9) brightness(1.05)'],
  ['cine', 'Cine', 'contrast(1.15) saturate(.85) hue-rotate(-6deg)'], ['desvanecido', 'Desvanecido', 'contrast(.85) brightness(1.05) saturate(.8)'], ['dramatico', 'Dramático', 'contrast(1.35) saturate(1.1) brightness(.97)']]
function visualSel () { const f = selectedClip(); return f && ['video', 'image'].includes(clipKind(f.clip)) ? f : null }
function libFilters () {
  const f = visualSel(); const cur = f?.clip.filter || 'none'
  return `${f ? '' : '<p class="muted small">Selecciona un clip de video o foto en la línea de tiempo para aplicarle un filtro.</p>'}
    <div class="preset-grid">${FILTERS.map(([k, n, css]) => `<div class="preset${f && cur === k ? ' active' : ''}" data-filter="${k}"><div class="fswatch" style="filter:${css}"></div><span class="lbl" style="color:#fff;text-shadow:0 1px 2px #000">${n}</span></div>`).join('')}</div>
    ${f ? '<button class="btn small full" style="margin-top:10px" data-act="filter-all">Aplicar este filtro a todos los clips</button>' : ''}
    <p class="muted small" style="margin-top:10px">Ajustes finos (brillo, contraste, saturación, temperatura): pestaña <b>Color</b> a la derecha.</p>`
}
export const ANIMS = [['none', 'Ninguna', '⊘'], ['fade', 'Fundido', '◐'], ['zoom_in', 'Zoom +', '⊕'], ['zoom_out', 'Zoom −', '⊖'], ['slide_left', 'Desde der.', '←'], ['slide_right', 'Desde izq.', '→'], ['slide_up', 'Desde abajo', '↑'], ['slide_down', 'Desde arriba', '↓']]
export const TEXT_ANIMS = [['none', 'Ninguna', '⊘'], ['fade', 'Fundido', '◐'], ['pop', 'Pop', '✺'], ['zoom_out', 'Zoom', '⊖'], ['typewriter', 'Escribir', '⌨'], ['slide_up', 'Subir', '↑'], ['slide_down', 'Bajar', '↓'], ['slide_left', 'Izquierda', '←'], ['slide_right', 'Derecha', '→']]
function animSel () { const f = selectedClip(); return f && clipKind(f.clip) !== 'audio' ? f : null }
function libAnims () {
  const f = animSel()
  if (!f) return '<p class="muted small">Selecciona un clip de video, foto o texto para darle animación de entrada y salida.</p>'
  const isT = f.clip.text !== undefined; const list = isT ? TEXT_ANIMS : ANIMS
  const grid = (which) => {
    const cur = f.clip[which]?.type || 'none'
    const opts = which === 'animOut' && isT ? list.filter(a => a[0] !== 'typewriter') : list
    return `<div class="anim-grid">${opts.map(([k, n, i]) => `<div class="anim${cur === k ? ' active' : ''}" data-anim="${which}:${k}"><i>${i}</i>${which === 'animOut' ? n.replace('Desde ', 'Hacia ') : n}</div>`).join('')}</div>`
  }
  const dur = (which) => `<div class="prow" style="margin-top:8px"><span>Duración</span><input type="range" data-animdur="${which}" min="0.1" max="${Math.min(3, f.clip.dur).toFixed(1)}" step="0.05" value="${f.clip[which]?.dur || 0.5}"><span class="val">${(f.clip[which]?.dur || 0.5).toFixed(2)} s</span></div>`
  return `<h4>Entrada</h4>${grid('animIn')}${dur('animIn')}<h4>Salida</h4>${grid('animOut')}${dur('animOut')}`
}

function bindLib () {
  const body = $('#libBody')
  body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => libAction(b.dataset.act)))
  if (libTab === 'audio') bindAudio(body)
  body.querySelectorAll('.mcard').forEach(card => {
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/capcraft-media', card.dataset.media); e.dataTransfer.effectAllowed = 'copy' })
    card.addEventListener('dblclick', () => quickAdd(card.dataset.media))
  })
  body.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); quickAdd(b.dataset.add) }))
  body.querySelectorAll('[data-text]').forEach(b => b.addEventListener('click', () => addText(b.dataset.text)))
  body.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', (e) => {
    if (e.target.dataset.deltpl) return deleteTemplate(e.target.dataset.deltpl)
    const id = b.dataset.tpl; const t = state.templates.builtin[id] || state.templates.custom[id]
    edit(() => {
      const sub = state.project.subtitles; const keep = {}
      for (const k of ['pos_x', 'pos_y', 'scale', 'rotation', 'flip_x', 'flip_y']) if (sub.template[k] != null) keep[k] = sub.template[k]
      sub.templateId = id; sub.template = { ...clone(t), ...keep }
    })
  }))
  body.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
    const f = visualSel(); if (!f) return toast('Primero selecciona un clip de video o foto.', 'err')
    edit(() => { f.clip.filter = b.dataset.filter })
  }))
  body.querySelectorAll('[data-anim]').forEach(b => b.addEventListener('click', () => {
    const f = animSel(); if (!f) return
    const [which, type] = b.dataset.anim.split(':')
    edit(() => { f.clip[which] = { type, dur: f.clip[which]?.dur || 0.5 } })
    seek(which === 'animIn' ? f.clip.start : Math.max(f.clip.start, clipEnd(f.clip) - (f.clip.animOut.dur || 0.5) - 0.1))
    if (!state.playing) setTimeout(() => import('./preview.js').then(p => p.play()), 50)
  }))
  body.querySelectorAll('[data-animdur]').forEach(r => {
    r.addEventListener('input', () => { const f = animSel(); beginLive(); f.clip[r.dataset.animdur].dur = +r.value; r.nextElementSibling.textContent = (+r.value).toFixed(2) + ' s'; live() })
    r.addEventListener('change', () => endLive())
  })
  const hint = $('#dropHint')
  if (hint) {
    hint.addEventListener('dragover', (e) => { e.preventDefault(); hint.classList.add('drag') })
    hint.addEventListener('dragleave', () => hint.classList.remove('drag'))
    hint.addEventListener('drop', (e) => { e.preventDefault(); hint.classList.remove('drag'); importFiles([...e.dataTransfer.files]) })
  }
  const so = $('#subOn'); if (so) so.onchange = () => edit(() => { state.project.subtitles.enabled = so.checked })
  for (const [id, lab] of [['silMin', 'silMinV'], ['silPad', 'silPadV']]) { const el = $('#' + id); if (el) el.oninput = () => { $('#' + lab).textContent = (+el.value).toFixed(2) + ' s' } }
}

function quickAdd (id) {
  const m = media(id); if (!m) return
  if (m.type === 'audio') addMediaAt(id, state.time)
  else addMediaAt(id, duration() + 1, mainTrack())
}
function addText (preset) {
  const t = state.time
  edit(() => {
    const c = defaultText(t, preset)
    const tr = trackWithRoom('text', c.start, clipEnd(c)); tr.clips.push(c)
    state.sel = { kind: 'clip', id: c.id }
  })
  emit('select')
}
async function deleteTemplate (id) {
  const ok = await modal({ title: 'Eliminar plantilla', body: `¿Eliminar “${esc(state.templates.custom[id].name || id)}”?`, buttons: [{ label: 'Cancelar', value: false, cls: 'ghost' }, { label: 'Eliminar', value: true, cls: 'primary' }] })
  if (!ok) return
  await api.post('/api/templates/delete', { id }); state.templates = await api.get('/api/templates'); renderLib()
}

async function libAction (act) {
  if (act === 'import') return importDialog()
  if (act === 'import-audio') return importDialog()
  if (act === 'music-more') return loadMusic(true)
  if (act === 'transcribe') return transcribe()
  if (act === 'sub-style') { state.sel = { kind: 'subs' }; emit('select'); return }
  if (act === 'sub-clear') {
    const ok = await modal({ title: 'Borrar subtítulos', body: '¿Borrar todas las palabras transcritas?', buttons: [{ label: 'Cancelar', value: false, cls: 'ghost' }, { label: 'Borrar', value: true, cls: 'primary' }] })
    if (ok) edit(() => { state.project.subtitles.words = [] })
    return
  }
  if (act === 'silence') return removeSilences()
  if (act === 'filter-all') {
    const f = visualSel(); if (!f) return
    edit(() => { for (const t of state.project.tracks) for (const c of t.clips) if (['video', 'image'].includes(clipKind(c))) c.filter = f.clip.filter })
    toast('Filtro aplicado a todos los clips.', 'ok')
  }
}

// ---------------------------------------------------------------- importar
export async function importDialog () {
  if (!bridge) {
    const p = await modal({ title: 'Ruta del archivo', input: '', buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Importar', value: true, cls: 'accent' }] })
    if (p) importPaths([p]); return
  }
  const paths = await bridge.openMedia(); if (paths?.length) importPaths(paths)
}
export function importFiles (files) { importPaths(files.map(f => bridge ? bridge.pathForFile(f) : f.path).filter(Boolean)) }
export async function importPaths (paths, { quiet = false } = {}) {
  const added = []
  for (const path of paths) {
    try {
      const info = await api.post('/api/media/info', { path })
      const exists = Object.values(state.project.media).find(m => m.path === path)
      if (exists) { added.push(exists); continue }
      const m = { id: uid('m'), ...info }
      edit(() => { state.project.media[m.id] = m })
      added.push(m)
      if (m.type === 'video') checkPlayable(m)
    } catch (e) { toast(`No se pudo importar ${path.split(/[\\/]/).pop()}: ${e.message}`, 'err') }
  }
  if (added.length && !quiet) toast(`${added.length} archivo(s) importado(s).`, 'ok')
  return added
}
function checkPlayable (m) {
  const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true
  v.onloadeddata = () => { v.removeAttribute('src'); v.load() }
  v.onerror = () => makeProxy(m.id)
  v.src = `/media?path=${encodeURIComponent(m.path)}`
  v.load()
  setTimeout(() => { if (v.readyState < 2 && !v.error) v.currentTime = 0.01 }, 300)
}
const proxying = new Set()
export async function makeProxy (id) {
  const m = media(id); if (!m || m.preview || proxying.has(id)) return
  proxying.add(id)
  m._busy = 'Preparando vista previa…'; renderLib()
  toast(`“${m.name}” no se puede mostrar directamente (HEVC/HDR). Creando copia de vista previa; la exportación usará el original.`)
  try {
    const { job } = await api.post('/api/proxy', { path: m.path })
    const r = await pollJob(job, (j) => { m._busy = `Vista previa ${Math.round((j.progress || 0) * 100)} %`; const el = $(`.mcard[data-media="${id}"] .busy`); if (el) el.textContent = m._busy })
    delete m._busy
    edit(() => { media(id).preview = r.preview })
    markDirty()
  } catch (e) { delete m._busy; toast(`No se pudo crear la vista previa: ${e.message}`, 'err') }
  proxying.delete(id); renderLib()
}
on('needproxy', (id) => makeProxy(id))

// ---------------------------------------------------------------- transcribir y silencios
async function transcribe () {
  const p = state.project
  if (!p.tracks.some(t => t.kind === 'video' && t.clips.some(c => media(c.mediaId)?.has_audio)) && !$('#subMusic').checked) return toast('No hay clips de video con audio en la línea de tiempo.', 'err')
  if (p.subtitles.words.length) {
    const ok = await modal({ title: '¿Volver a generar?', body: 'Se reemplazarán los subtítulos actuales y sus correcciones.', buttons: [{ label: 'Cancelar', value: false, cls: 'ghost' }, { label: 'Reemplazar', value: true, cls: 'primary' }] })
    if (!ok) return
  }
  const pm = progressModal('Generando subtítulos')
  try {
    const { job } = await api.post('/api/v2/transcribe', { project: { ...p, thumb: undefined }, model: $('#subModel').value, language: $('#subLang').value, include_audio_tracks: $('#subMusic').checked })
    const r = await pollJob(job, pm.update)
    pm.close()
    edit(() => { p.subtitles.words = r.words; p.subtitles.enabled = true })
    toast(`Listo: ${r.words.length} palabras. Clic en una línea 💬 para corregirla.`, 'ok')
  } catch (e) { pm.close(); toast(`Error al transcribir: ${e.message}`, 'err') }
}
function removeSilences () {
  const words = [...state.project.subtitles.words].sort((a, b) => a.start - b.start); if (!words.length) return
  const min = +$('#silMin').value; const pad = +$('#silPad').value; const ranges = []
  const gap = (s, e) => { if (e - s >= min && e - pad - (s + pad) > 0.05) ranges.push([Math.max(0, s + pad), e - pad]) }
  gap(-pad, words[0].start)
  for (let i = 0; i < words.length - 1; i++) gap(words[i].end, words[i + 1].start)
  const end = mainTrack().clips.reduce((a, c) => Math.max(a, clipEnd(c)), 0)
  gap(words[words.length - 1].end, end + pad)
  if (!ranges.length) return toast('No se encontraron silencios con ese mínimo.', '')
  const before = duration()
  edit(() => rippleDelete(ranges))
  toast(`Se quitaron ${ranges.length} silencios (${(before - duration()).toFixed(1)} s menos).`, 'ok')
}

// ================================================================ PROPIEDADES
let propTab = {}
export function renderProps () {
  const tabs = $('#propsTabs'); const body = $('#propsBody'); const title = $('#propsTitle')
  if (!state.project) { tabs.innerHTML = ''; body.innerHTML = ''; return }
  const s = state.sel; let spec
  if (!s) spec = { title: 'Detalles del proyecto', tabs: [['proj', 'Proyecto']] }
  else if (s.kind === 'subs') spec = { title: 'Estilo de subtítulos', tabs: [['substyle', 'Estilo']] }
  else if (s.kind === 'subline') spec = { title: 'Subtítulo', tabs: [['subtext', 'Texto'], ['substyle', 'Estilo']] }
  else {
    const f = findClip(s.id); if (!f) { state.sel = null; return renderProps() }
    const k = clipKind(f.clip); const m = media(f.clip.mediaId)
    if (k === 'text') spec = { title: 'Texto', tabs: [['text', 'Texto'], ['basic', 'Básico'], ['anim', 'Animación']] }
    else if (k === 'audio') spec = { title: `Audio · ${esc(m?.name || '')}`, tabs: [['audio', 'Audio'], ['speed', 'Velocidad']] }
    else spec = { title: `${k === 'image' ? 'Foto' : 'Video'} · ${esc(m?.name || '')}`, tabs: [['basic', 'Básico'], ['color', 'Color'], ...(k === 'video' ? [['speed', 'Velocidad']] : []), ...(k === 'video' && m?.has_audio ? [['audio', 'Audio']] : []), ['anim', 'Animación']] }
  }
  const key = s ? (s.kind === 'clip' ? clipKind(findClip(s.id).clip) : s.kind) : 'proj'
  let cur = propTab[key]; if (!spec.tabs.some(t => t[0] === cur)) cur = spec.tabs[0][0]
  title.innerHTML = spec.title
  tabs.innerHTML = spec.tabs.length > 1 ? spec.tabs.map(([k, n]) => `<button class="ptab${k === cur ? ' active' : ''}" data-ptab="${k}">${n}</button>`).join('') : ''
  tabs.querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => { propTab[key] = b.dataset.ptab; renderProps() })
  body.innerHTML = ''
  const f = s?.kind === 'clip' ? findClip(s.id) : null
  ;({ proj: pProject, basic: pBasic, color: pColor, speed: pSpeed, audio: pAudio, anim: pAnim, text: pText, subtext: pSubText, substyle: pSubStyle })[cur](body, f?.clip, f?.track)
}
on('select', renderProps)
on('project', (d) => { if (!d?.live) renderProps() })
on('lines', () => { if (state.sel?.kind === 'subline') renderProps() })

// ---- constructores de controles
function sect (body, title, extra = '') { const d = document.createElement('div'); d.className = 'sect'; d.innerHTML = `<div class="sect-title">${title}${extra}</div>`; body.appendChild(d); return d }
function slider (parent, label, get, set, { min, max, step = 0.01, show = (v) => v.toFixed(2), parse = parseFloat } = {}) {
  const row = document.createElement('div'); row.className = 'prow'
  row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><input class="val" type="text">`
  const r = row.children[1]; const v = row.children[2]
  r.value = get(); v.value = show(+get())
  r.addEventListener('input', () => { beginLive(); set(+r.value); v.value = show(+r.value); markDirty(); live() })
  r.addEventListener('change', () => endLive())
  v.addEventListener('change', () => { const n = parse(v.value); if (isFinite(n)) edit(() => set(clamp(n, min, max))) })
  r.addEventListener('dblclick', () => edit(() => set(+r.defaultValue)))
  parent.appendChild(row); return row
}
function color (parent, label, get, set) {
  const row = document.createElement('label'); row.className = 'prow2'
  row.innerHTML = `${label}<input type="color" value="${safeColor(get(), '#FFFFFF')}">`
  const i = row.children[0]
  i.addEventListener('input', () => { beginLive(); set(i.value.toUpperCase()); live() }); i.addEventListener('change', () => endLive())
  parent.appendChild(row)
}
function check (parent, label, get, set) {
  const row = document.createElement('label'); row.className = 'check'; row.style.marginBottom = '8px'
  row.innerHTML = `<input type="checkbox" ${get() ? 'checked' : ''}> ${label}`
  row.children[0].addEventListener('change', (e) => edit(() => set(e.target.checked)))
  parent.appendChild(row)
}
function select (parent, label, opts, get, set) {
  const row = document.createElement('div'); row.className = 'field'
  row.innerHTML = `${label}<select>${opts.map(([k, n]) => `<option value="${esc(k)}" ${String(get()) === String(k) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`
  row.children[0].addEventListener('change', (e) => edit(() => set(e.target.value)))
  parent.appendChild(row); return row
}
function buttons (parent, list) {
  const d = document.createElement('div'); d.className = 'row gap wrap'; d.style.marginBottom = '8px'
  for (const [label, fn, cls] of list) { const b = document.createElement('button'); b.className = `btn small ${cls || ''}`; b.innerHTML = label; b.onclick = fn; d.appendChild(b) }
  parent.appendChild(d)
}
const pct = (v) => Math.round(v * 100) + ' %'
const parsePct = (s) => parseFloat(s) / 100

// ---- proyecto
function pProject (body) {
  const p = state.project; const d = duration()
  const s = sect(body, 'Proyecto')
  const kv = document.createElement('div'); kv.className = 'kv'
  const counts = p.tracks.reduce((a, t) => a + t.clips.length, 0)
  kv.innerHTML = `<span>Nombre</span><b>${esc(p.name)}</b><span>Lienzo</span><b>${Number(p.canvas.width)}×${Number(p.canvas.height)}</b><span>Duración</span><b>${fmt(d)}</b><span>Clips</span><b>${counts}</b><span>Medios</span><b>${Object.keys(p.media).length}</b><span>Subtítulos</span><b>${p.subtitles.words.length ? p.subtitles.words.length + ' palabras' : '—'}</b>`
  s.appendChild(kv)
  const s2 = sect(body, 'Formato')
  const cur = Object.entries(RATIOS).find(([, v]) => v[0] === p.canvas.width && v[1] === p.canvas.height)?.[0] || 'custom'
  select(s2, 'Relación de aspecto', [...Object.keys(RATIOS).map(k => [k, k]), ...(cur === 'custom' ? [['custom', `${p.canvas.width}×${p.canvas.height}`]] : [])], () => cur, (v) => { if (RATIOS[v]) { p.canvas.width = RATIOS[v][0]; p.canvas.height = RATIOS[v][1]; setTimeout(layout, 0) } })
  select(s2, 'Cuadros por segundo', [[24, '24 fps'], [25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], () => p.canvas.fps, (v) => { p.canvas.fps = +v })
  color(s2, 'Color de fondo', () => p.canvas.background, (v) => { p.canvas.background = v; markDirty() })
  const tip = document.createElement('p'); tip.className = 'muted small'
  tip.innerHTML = 'Selecciona un clip en la línea de tiempo o en el video para ver sus opciones.<br><br><b>Atajos:</b> Espacio reproducir · S dividir · Supr eliminar · Ctrl+Z deshacer · Ctrl+D duplicar · ←/→ cuadro a cuadro'
  body.appendChild(tip)
}

// ---- básico (video, foto o texto)
function pBasic (body, c) {
  const isT = c.text !== undefined
  const s = sect(body, 'Transformar')
  slider(s, 'Escala', () => c.scale ?? 1, (v) => { c.scale = v }, { min: 0.05, max: 5, step: 0.01, show: pct, parse: parsePct })
  if (isT) {
    slider(s, 'Posición X', () => c.x ?? 0.5, (v) => { c.x = v }, { min: -0.5, max: 1.5, step: 0.001, show: (v) => Math.round(v * 100) + ' %', parse: parsePct })
    slider(s, 'Posición Y', () => c.y ?? 0.5, (v) => { c.y = v }, { min: -0.5, max: 1.5, step: 0.001, show: (v) => Math.round(v * 100) + ' %', parse: parsePct })
  } else {
    slider(s, 'Posición X', () => c.x ?? 0, (v) => { c.x = v }, { min: -1.5, max: 1.5, step: 0.001, show: (v) => Math.round(v * 100) + ' %', parse: parsePct })
    slider(s, 'Posición Y', () => c.y ?? 0, (v) => { c.y = v }, { min: -1.5, max: 1.5, step: 0.001, show: (v) => Math.round(v * 100) + ' %', parse: parsePct })
  }
  slider(s, 'Rotación', () => c.rotation ?? 0, (v) => { c.rotation = v }, { min: -180, max: 180, step: 0.5, show: (v) => Math.round(v) + '°' })
  if (!isT) slider(s, 'Opacidad', () => c.opacity ?? 1, (v) => { c.opacity = v }, { min: 0, max: 1, step: 0.01, show: pct, parse: parsePct })
  if (!isT) {
    const s2 = sect(body, 'Encuadre')
    buttons(s2, [
      [`${c.fit !== 'cover' ? '● ' : ''}Encajar`, () => edit(() => { c.fit = 'contain' })],
      [`${c.fit === 'cover' ? '● ' : ''}Rellenar`, () => edit(() => { c.fit = 'cover' })],
      ['↔ Voltear', () => edit(() => { c.flipH = !c.flipH })], ['↕ Voltear', () => edit(() => { c.flipV = !c.flipV })]
    ])
  }
  buttons(body, [['↺ Restablecer transformación', () => edit(() => Object.assign(c, isT ? { x: 0.5, y: 0.5, scale: 1, rotation: 0 } : { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false })), 'ghost']])
  const tip = document.createElement('p'); tip.className = 'muted small'; tip.textContent = 'También puedes mover, agrandar y girar directamente en el video. Doble clic en un control lo devuelve a su valor inicial.'
  body.appendChild(tip)
}

// ---- color
function pColor (body, c) {
  c.color = c.color || {}
  const s = sect(body, 'Ajustes de color')
  slider(s, 'Brillo', () => c.color.brightness ?? 0, (v) => { c.color.brightness = v }, { min: -0.5, max: 0.5, step: 0.01, show: (v) => Math.round(v * 200) })
  slider(s, 'Contraste', () => c.color.contrast ?? 1, (v) => { c.color.contrast = v }, { min: 0.3, max: 2, step: 0.01, show: (v) => Math.round((v - 1) * 100) })
  slider(s, 'Saturación', () => c.color.saturation ?? 1, (v) => { c.color.saturation = v }, { min: 0, max: 2.5, step: 0.01, show: (v) => Math.round((v - 1) * 100) })
  slider(s, 'Temperatura', () => c.color.temperature ?? 0, (v) => { c.color.temperature = v }, { min: -1, max: 1, step: 0.01, show: (v) => Math.round(v * 100) })
  slider(s, 'Tono', () => c.color.hue ?? 0, (v) => { c.color.hue = v }, { min: -180, max: 180, step: 1, show: (v) => Math.round(v) + '°' })
  select(s, 'Filtro', FILTERS.map(f => [f[0], f[1]]), () => c.filter || 'none', (v) => { c.filter = v })
  buttons(body, [['↺ Restablecer color', () => edit(() => { c.color = { brightness: 0, contrast: 1, saturation: 1, hue: 0, temperature: 0 }; c.filter = 'none' }), 'ghost'],
    ['Aplicar a todos los clips', () => edit(() => { for (const t of state.project.tracks) for (const x of t.clips) if (['video', 'image'].includes(clipKind(x))) { x.color = clone(c.color); x.filter = c.filter } })]])
}

// ---- velocidad
function pSpeed (body, c) {
  const s = sect(body, 'Velocidad')
  const setSpeed = (v) => { const src = c.dur * (c.speed || 1); c.speed = +v.toFixed(3); c.dur = +(src / c.speed).toFixed(4) }
  slider(s, 'Velocidad', () => c.speed || 1, setSpeed, { min: 0.1, max: 10, step: 0.05, show: (v) => v.toFixed(2) + 'x' })
  buttons(s, [0.5, 1, 1.5, 2, 3].map(v => [`${v}x`, () => edit(() => setSpeed(v)), (c.speed || 1) === v ? 'on' : '']))
  const p = document.createElement('p'); p.className = 'muted small'
  p.textContent = `Duración en la línea de tiempo: ${fmt(c.dur)}. Cambiar la velocidad alarga o acorta el clip; el audio conserva su tono.`
  body.appendChild(p)
}

// ---- audio
function pAudio (body, c) {
  const s = sect(body, 'Audio')
  slider(s, 'Volumen', () => c.volume ?? 1, (v) => { c.volume = v }, { min: 0, max: 2, step: 0.01, show: pct, parse: parsePct })
  if (c.muted !== undefined) check(s, 'Silenciar este clip', () => c.muted, (v) => { c.muted = v })
  slider(s, 'Aparecer', () => c.fadeIn || 0, (v) => { c.fadeIn = v }, { min: 0, max: Math.min(10, c.dur / 2), step: 0.05, show: (v) => v.toFixed(1) + ' s' })
  slider(s, 'Desaparecer', () => c.fadeOut || 0, (v) => { c.fadeOut = v }, { min: 0, max: Math.min(10, c.dur / 2), step: 0.05, show: (v) => v.toFixed(1) + ' s' })
  const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'En la vista previa el volumen máximo es 100 %; la exportación sí aplica hasta 200 %.'
  body.appendChild(p)
}

// ---- animación
function pAnim (body, c) {
  const isT = c.text !== undefined; const list = isT ? TEXT_ANIMS : ANIMS
  for (const [which, name] of [['animIn', 'Entrada'], ['animOut', 'Salida']]) {
    const s = sect(body, name)
    c[which] = c[which] || { type: 'none', dur: 0.5 }
    select(s, 'Tipo', (which === 'animOut' && isT ? list.filter(a => a[0] !== 'typewriter') : list).map(a => [a[0], a[1]]), () => c[which].type, (v) => { c[which].type = v })
    slider(s, 'Duración', () => c[which].dur || 0.5, (v) => { c[which].dur = v }, { min: 0.1, max: Math.min(3, c.dur), step: 0.05, show: (v) => v.toFixed(2) + ' s' })
  }
  buttons(body, [['▶ Ver entrada', () => { seek(c.start); import('./preview.js').then(p => p.play()) }], ['▶ Ver salida', () => { seek(Math.max(c.start, clipEnd(c) - (c.animOut?.dur || 0.5) - 0.3)); import('./preview.js').then(p => p.play()) }]])
}

// ---- texto
function pText (body, c) {
  const st = c.style
  const s = sect(body, 'Contenido')
  const ta = document.createElement('textarea'); ta.value = c.text
  ta.addEventListener('input', () => { beginLive(); c.text = ta.value; live() }); ta.addEventListener('change', () => endLive())
  s.appendChild(ta)
  const s2 = sect(body, 'Estilo')
  select(s2, 'Fuente', [...new Set([...state.fonts.map(f => f.family), st.font])].map(f => [f, f]), () => st.font, (v) => { st.font = v })
  slider(s2, 'Tamaño', () => st.size, (v) => { st.size = v }, { min: 20, max: 400, step: 1, show: (v) => Math.round(v) })
  color(s2, 'Color', () => st.color, (v) => { st.color = v })
  slider(s2, 'Espaciado', () => st.spacing || 0, (v) => { st.spacing = v }, { min: -10, max: 40, step: 0.5, show: (v) => v.toFixed(1) })
  check(s2, 'Fondo (caja)', () => st.box, (v) => { st.box = v })
  if (st.box) color(s2, 'Color de la caja', () => st.box_color || '#000000', (v) => { st.box_color = v })
  else {
    slider(s2, 'Borde', () => st.outline || 0, (v) => { st.outline = v }, { min: 0, max: 20, step: 0.5, show: (v) => v.toFixed(1) })
    color(s2, 'Color del borde', () => st.outline_color || '#000000', (v) => { st.outline_color = v })
    slider(s2, 'Sombra', () => st.shadow || 0, (v) => { st.shadow = v }, { min: 0, max: 20, step: 0.5, show: (v) => v.toFixed(1) })
    color(s2, 'Color de la sombra', () => st.shadow_color || '#000000', (v) => { st.shadow_color = v })
  }
  const s3 = sect(body, 'Estilos rápidos')
  const g = document.createElement('div'); g.className = 'row gap wrap'
  for (const [k, pr] of Object.entries(TEXT_PRESETS)) { const b = document.createElement('button'); b.className = 'btn tiny'; b.textContent = pr.name; b.onclick = () => edit(() => { c.style = clone(pr.style) }); g.appendChild(b) }
  s3.appendChild(g)
}

// ---- subtítulos: texto de la línea
let wordSel = -1
function pSubText (body) {
  const sub = state.project.subtitles; const li = state.sel.line; const idxs = state.lines[li]
  if (!idxs) { body.innerHTML = '<p class="empty-props">Línea no encontrada.</p>'; return }
  if (!idxs.includes(wordSel)) wordSel = idxs[0]
  const kw = new Set(sub.keywords)
  const s = sect(body, `Línea ${li + 1} de ${state.lines.length}`, `<span><button class="btn tiny" id="lnPrev">◀</button> <button class="btn tiny" id="lnNext">▶</button></span>`)
  const words = document.createElement('div'); words.className = 'words'
  words.innerHTML = idxs.map(i => { const w = sub.words[i]; return `<span class="w${i === wordSel ? ' sel' : ''}${kw.has(norm(w.text)) ? ' kw' : ''}${w.br ? ' br' : ''}${w.join ? ' join' : ''}" data-i="${Number(i)}">${esc(w.text)}</span>` }).join('')
  words.onclick = (e) => { const el = e.target.closest('.w'); if (!el) return; wordSel = +el.dataset.i; seek(sub.words[wordSel].start + 0.01); renderProps() }
  s.appendChild(words)
  $('#lnPrev', s).onclick = () => goLine(li - 1); $('#lnNext', s).onclick = () => goLine(li + 1)
  const w = sub.words[wordSel]
  const insp = document.createElement('div'); insp.className = 'insp'
  insp.innerHTML = `<input type="text" id="wText" value="${esc(w.text)}">
    <div class="times">Inicio <input type="number" id="wStart" step="0.01" value="${(+w.start || 0).toFixed(2)}"> Final <input type="number" id="wEnd" step="0.01" value="${(+w.end || 0).toFixed(2)}">
    <button class="btn tiny" id="wNow" title="Inicio = cabezal">⏱</button></div>
    <div class="row gap wrap">
      <button class="btn tiny${w.br ? ' on' : ''}" id="wBr">⏎ Partir después</button>
      <button class="btn tiny${w.join ? ' on' : ''}" id="wJoin">⇥ Unir con la siguiente</button>
      <button class="btn tiny${kw.has(norm(w.text)) ? ' on' : ''}" id="wKey">★ Palabra clave</button>
      <button class="btn tiny" id="wAdd">＋ Insertar</button>
      <button class="btn tiny danger" id="wDel">🗑 Eliminar</button></div>`
  body.appendChild(insp)
  const tx = $('#wText', insp)
  tx.onkeydown = (e) => { if (e.key === 'Enter') tx.blur() }
  tx.onchange = () => edit(() => {
    const parts = tx.value.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) { sub.words.splice(wordSel, 1); return }
    if (parts.length === 1) { w.text = parts[0]; return }
    const span = (w.end - w.start) / parts.length
    const news = parts.map((p, k) => ({ text: p, start: +(w.start + span * k).toFixed(3), end: +(w.start + span * (k + 1)).toFixed(3) }))
    Object.assign(news[news.length - 1], { br: w.br, join: w.join }); if (w.box) news[0].box = w.box
    sub.words.splice(wordSel, 1, ...news)
  })
  const setT = (k, v) => edit(() => { if (!isFinite(v)) return; if (k === 'start') w.start = Math.min(Math.max(0, v), w.end - 0.03); else w.end = Math.max(v, w.start + 0.03) })
  $('#wStart', insp).onchange = (e) => setT('start', parseFloat(e.target.value))
  $('#wEnd', insp).onchange = (e) => setT('end', parseFloat(e.target.value))
  $('#wNow', insp).onclick = () => setT('start', state.time)
  $('#wBr', insp).onclick = () => edit(() => { w.br = !w.br; if (w.br) delete w.join })
  $('#wJoin', insp).onclick = () => edit(() => { w.join = !w.join; if (w.join) delete w.br })
  $('#wKey', insp).onclick = () => edit(() => { const k = norm(w.text); const i = sub.keywords.indexOf(k); if (i >= 0) sub.keywords.splice(i, 1); else sub.keywords.push(k) })
  $('#wAdd', insp).onclick = () => edit(() => { const n = sub.words[wordSel + 1]; const st = w.end; const en = n ? Math.max(st + 0.05, Math.min(n.start, st + 0.3)) : st + 0.3; sub.words.splice(wordSel + 1, 0, { text: 'nueva', start: +st.toFixed(3), end: +en.toFixed(3) }); wordSel++ })
  $('#wDel', insp).onclick = () => edit(() => { sub.words.splice(wordSel, 1) })
  const p = document.createElement('p'); p.className = 'muted small'
  p.textContent = 'Escribir varias palabras en el cuadro las divide repartiendo el tiempo. Para mover, agrandar o girar el subtítulo, haz clic sobre él en el video.'
  body.appendChild(p)
}
function goLine (li) { if (li < 0 || li >= state.lines.length) return; state.sel = { kind: 'subline', line: li }; wordSel = state.lines[li][0]; seek(state.project.subtitles.words[wordSel].start + 0.01); emit('select') }

// ---- subtítulos: estilo (plantilla)
function pSubStyle (body) {
  const sub = state.project.subtitles; const t = sub.template; const a = t.animation
  const s = sect(body, 'Animación')
  select(s, 'Tipo', ANIMS_SUB, () => a, (v) => { t.animation = v; if (['rainbow', 'one_word'].includes(v) && !t.palette) t.palette = ['#FF4D4D', '#FFE600', '#4DFF88', '#4DC3FF', '#C04DFF']; if (v === 'one_word') t.max_words = 1 })
  if (['pop', 'rainbow'].includes(a)) slider(s, 'Tamaño del pop', () => t.pop_scale ?? 120, (v) => { t.pop_scale = Math.round(v) }, { min: 100, max: 170, step: 1, show: (v) => Math.round(v) + ' %' })
  if (['pop', 'rainbow', 'bounce', 'blur_in', 'one_word'].includes(a)) slider(s, 'Velocidad', () => t.pop_ms ?? 80, (v) => { t.pop_ms = Math.round(v) }, { min: 30, max: 350, step: 5, show: (v) => Math.round(v) + ' ms' })
  const s2 = sect(body, 'Texto')
  select(s2, 'Fuente', [...new Set([...state.fonts.map(f => f.family), t.font])].map(f => [f, f]), () => t.font, (v) => { t.font = v })
  slider(s2, 'Tamaño', () => t.size, (v) => { t.size = Math.round(v) }, { min: 30, max: 240, step: 1, show: (v) => Math.round(v) })
  check(s2, 'MAYÚSCULAS', () => t.uppercase, (v) => { t.uppercase = v })
  check(s2, 'Quitar puntuación', () => t.strip_punctuation !== false, (v) => { t.strip_punctuation = v })
  const s3 = sect(body, 'Colores')
  color(s3, a === 'karaoke' ? 'Relleno' : 'Texto', () => t.color, (v) => { t.color = v })
  if (a === 'karaoke') color(s3, 'Sin rellenar', () => t.base_color || '#FFFFFF', (v) => { t.base_color = v })
  if (['pop', 'box', 'bounce', 'blur_in'].includes(a)) color(s3, a === 'box' ? 'Caja' : 'Palabra activa', () => t.highlight || '#FFE600', (v) => { t.highlight = v })
  if (a === 'box') color(s3, 'Texto en la caja', () => t.active_text || '#FFFFFF', (v) => { t.active_text = v })
  if (['rainbow', 'one_word'].includes(a)) (t.palette || []).forEach((c, i) => color(s3, `Paleta ${i + 1}`, () => t.palette[i], (v) => { t.palette[i] = v }))
  color(s3, 'Borde', () => t.outline_color || '#000000', (v) => { t.outline_color = v })
  slider(s3, 'Grosor borde', () => t.outline ?? 4, (v) => { t.outline = v }, { min: 0, max: 16, step: 0.5, show: (v) => v.toFixed(1) })
  if (a === 'box') slider(s3, 'Tamaño caja', () => t.box_outline ?? 16, (v) => { t.box_outline = Math.round(v) }, { min: 4, max: 40, step: 1, show: (v) => Math.round(v) })
  slider(s3, 'Sombra', () => t.shadow ?? 0, (v) => { t.shadow = v }, { min: 0, max: 12, step: 0.5, show: (v) => v.toFixed(1) })
  const s4 = sect(body, 'Líneas y posición')
  if (a !== 'one_word') {
    slider(s4, 'Palabras/línea', () => t.max_words ?? 3, (v) => { t.max_words = Math.round(v) }, { min: 1, max: 10, step: 1, show: (v) => Math.round(v) })
    slider(s4, 'Caracteres máx.', () => t.max_chars ?? 20, (v) => { t.max_chars = Math.round(v) }, { min: 6, max: 50, step: 1, show: (v) => Math.round(v) })
  }
  select(s4, 'Posición', [['lower', 'Abajo'], ['center', 'Centro'], ['upper', 'Arriba']], () => t.position || 'lower', (v) => { t.position = v; delete t.pos_x; delete t.pos_y })
  if ((t.position || 'lower') !== 'center' && t.pos_x == null) slider(s4, 'Distancia borde', () => t.margin_v ?? 400, (v) => { t.margin_v = Math.round(v) }, { min: 0, max: 1000, step: 5, show: (v) => Math.round(v) })
  buttons(body, [['💾 Guardar como plantilla', saveTemplateAsNew], ...(state.templates.custom[sub.templateId] ? [['Actualizar mi plantilla', updateTemplate]] : []),
    ['↺ Restablecer', () => { const src = state.templates.builtin[sub.templateId] || state.templates.custom[sub.templateId]; if (src) edit(() => { sub.template = clone(src) }) }, 'ghost']])
}
async function saveTemplateAsNew () {
  const sub = state.project.subtitles
  const name = await modal({ title: 'Guardar plantilla', body: 'Nombre de la plantilla:', input: sub.template.name ? `${sub.template.name} (mía)` : 'Mi plantilla', buttons: [{ label: 'Cancelar', value: null, cls: 'ghost' }, { label: 'Guardar', value: true, cls: 'accent' }] })
  if (!name) return
  const id = 'mia_' + name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now().toString(36).slice(-4)
  const t = { ...clone(sub.template), name }
  for (const k of ['pos_x', 'pos_y', 'scale', 'rotation', 'flip_x', 'flip_y']) delete t[k]
  await api.post('/api/templates/save', { id, template: t })
  state.templates = await api.get('/api/templates')
  edit(() => { sub.templateId = id })
  toast('Plantilla guardada.', 'ok')
}
async function updateTemplate () {
  const sub = state.project.subtitles; const t = { ...clone(sub.template) }
  for (const k of ['pos_x', 'pos_y', 'scale', 'rotation', 'flip_x', 'flip_y']) delete t[k]
  await api.post('/api/templates/save', { id: sub.templateId, template: t }); state.templates = await api.get('/api/templates'); toast('Plantilla actualizada.', 'ok')
}
