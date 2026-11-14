'use strict';
// =====================================================================
// Mosaico · Textos sobre la publicación
//
// Cada publicación tiene una lista `texts` de capas de texto. Las medidas son relativas al cuadro 4:5
// (x, y = centro en fracción del ancho/alto; size = alto de letra en fracción del alto del cuadro),
// así el texto queda igual en la vista previa, la miniatura y la exportación a 1080×1350.
// El texto se dibuja DESPUÉS del color: no lo afectan los ajustes ni el recorte de la foto.
//
// También maneja las tipografías propias (subidas desde la app) y la "biblioteca" compartida:
// estilos guardados y colores, que se sincronizan con Drive.
// =====================================================================
window.createMosaicoText = function createMosaicoText(A) {
  const { S, ASPECT, frame, clamp, rad, snapRot, normRot, uid, toast, DB } = A;
  const $ = s => document.querySelector(s);

  // ---------------- tipografías ----------------
  const BUILTIN = [
    { id: 'inter', name: 'Inter', family: 'Inter', weight: 400 },
    { id: 'inter-b', name: 'Inter negrita', family: 'Inter', weight: 700 },
    { id: 'playfair', name: 'Playfair Display', family: 'Playfair Display', weight: 400 },
    { id: 'playfair-i', name: 'Playfair cursiva', family: 'Playfair Display', weight: 400, style: 'italic' },
    { id: 'caveat', name: 'Caveat (a mano)', family: 'Caveat', weight: 500 },
  ];
  const custom = new Map();   // id → {id, name, family, weight, blob, driveId, ext, ready: Promise}
  const fontOf = id => custom.get(id) || BUILTIN.find(f => f.id === id) || BUILTIN[0];
  const fontList = () => [...BUILTIN, ...[...custom.values()].sort((a, b) => a.name.localeCompare(b.name))];
  const fontCSS = (f, px) => `${f.style === 'italic' ? 'italic ' : ''}${f.weight || 400} ${Math.max(1, px).toFixed(2)}px "${f.family}", -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const asked = new Set();
  // Pide la tipografía al navegador; cuando llega, se redibuja todo.
  function ensureFont(f) {
    const key = fontCSS(f, 40);
    if (asked.has(key)) return;
    asked.add(key);
    const p = f.ready ? f.ready.then(() => document.fonts.load(key)) : document.fonts.load(key);
    p.then(() => A.redrawAll()).catch(() => { });
  }
  async function fontsReady(it) {
    await imagesReady(it);
    const fs = [...new Set((it.texts || []).filter(L => L.type !== 'image').map(L => fontOf(L.font)))];
    await Promise.all(fs.map(f => (f.ready || Promise.resolve()).then(() => document.fonts.load(fontCSS(f, 40))).catch(() => { })));
  }
  async function registerFont(rec) {
    const f = { id: rec.id, name: rec.name, family: 'mf-' + rec.id, weight: 400, blob: rec.blob, driveId: rec.driveId || null, ext: rec.ext || 'ttf' };
    f.ready = (async () => {
      const face = new FontFace(f.family, await rec.blob.arrayBuffer());
      await face.load();
      document.fonts.add(face);
    })();
    custom.set(f.id, f);
    f.ready.then(() => A.redrawAll()).catch(e => { console.warn('tipografía inválida', rec.name, e); });
    return f;
  }
  const cleanName = n => n.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b(regular|normal)\b/ig, '').replace(/\s+/g, ' ').trim() || 'Tipografía';
  async function addFontFiles(files) {
    let last = null;
    for (const file of files) {
      const ext = (file.name.match(/\.(ttf|otf|woff2?|ttc)$/i) || [])[1];
      if (!ext) { toast(`"${file.name}" no parece una tipografía (.ttf, .otf, .woff)`, false, 6000); continue; }
      const rec = { id: uid(), name: cleanName(file.name), ext: ext.toLowerCase(), blob: new Blob([await file.arrayBuffer()], { type: file.type || 'font/' + ext.toLowerCase() }) };
      const f = await registerFont(rec);
      try { await f.ready; } catch { custom.delete(f.id); toast(`No se pudo leer "${file.name}"`, false, 6000); continue; }
      await DB.put('fonts', { id: rec.id, name: rec.name, ext: rec.ext, blob: rec.blob, driveId: null });
      last = f;
      toast(`Tipografía "${rec.name}" agregada`);
    }
    if (last) A.kickSync();
    return last;
  }
  async function removeFont(id) {
    const f = custom.get(id); if (!f) return;
    if (!confirm(`¿Quitar la tipografía "${f.name}"? Los textos que la usan pasan a Inter.`)) return;
    custom.delete(id);
    await DB.run(['fonts'], 'readwrite', t => { t.objectStore('fonts').delete(id); });
    if (f.driveId) A.trashFile(f.driveId);
    lib.deletedFonts = [...new Set([...lib.deletedFonts, id])];
    libChanged();
    A.redrawAll(); syncPanel();
  }

  // ---------------- biblioteca compartida (estilos y colores) ----------------
  let lib = { styles: [], deletedStyles: [], deletedFonts: [], palette: [], dirty: false, gen: 0 };
  const saveLib = () => DB.put('meta', lib, 'library').catch(console.error);
  function libChanged() { lib.dirty = true; lib.gen++; saveLib(); A.kickSync(); renderStyles(); renderSwatches(); }
  function mergeLibrary(remote, local) {
    remote = remote || {};
    const delS = new Set([...(remote.deletedStyles || []), ...(local.deletedStyles || [])]);
    const delF = new Set([...(remote.deletedFonts || []), ...(local.deletedFonts || [])]);
    const byId = new Map();
    for (const s of remote.styles || []) byId.set(s.id, s);
    for (const s of local.styles || []) if (local.dirty || !byId.has(s.id)) byId.set(s.id, s);
    const styles = [...byId.values()].filter(s => !delS.has(s.id));
    const palette = (local.dirty ? local.palette : remote.palette) || [];
    return { styles, deletedStyles: [...delS], deletedFonts: [...delF], palette: palette.slice(0, 12) };
  }
  function applyLibrary(merged, clearDirtyIfGen) {
    const keepDirty = clearDirtyIfGen === undefined ? lib.dirty : lib.gen !== clearDirtyIfGen;
    lib = { ...lib, ...merged, dirty: keepDirty && lib.dirty };
    for (const id of lib.deletedFonts) if (custom.has(id)) {
      custom.delete(id); DB.run(['fonts'], 'readwrite', t => { t.objectStore('fonts').delete(id); }).catch(() => { });
    }
    saveLib(); renderStyles(); renderSwatches(); syncPanel(); A.redrawAll();
  }

  // ---------------- texto: mayúsculas y dibujo ----------------
  function applyCase(s, mode) {
    if (mode === 'upper') return s.toLocaleUpperCase('es');
    if (mode === 'lower') return s.toLocaleLowerCase('es');
    if (mode === 'title') return s.toLocaleLowerCase('es').replace(/(^|[\s\-"“'(¿¡/])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('es'));
    return s;
  }
  const hexA = (hex, a) => {
    const h = (hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  function layout(ctx, L, H) {
    const f = fontOf(L.font);
    const fontPx = L.size * H;
    ctx.font = fontCSS(f, fontPx);
    const lines = applyCase(L.text || ' ', L.caseMode).split('\n');
    const track = (L.letter || 0) / 1000 * fontPx;
    const widths = lines.map(s => ctx.measureText(s).width + track * Math.max(0, [...s].length - 1));
    const maxW = Math.max(fontPx * 0.3, ...widths);
    const lineH = fontPx * (L.line || 1.2);
    const h = (lines.length - 1) * lineH + fontPx * 1.1;
    return { f, fontPx, lines, widths, maxW, lineH, h, track };
  }
  function drawLines(ctx, m, align, stroke) {
    const n = m.lines.length;
    m.lines.forEach((s, i) => {
      const y = (i - (n - 1) / 2) * m.lineH;
      const w = m.widths[i];
      let x = align === 'left' ? -m.maxW / 2 : align === 'right' ? m.maxW / 2 - w : -w / 2;   // borde izquierdo de la línea
      if (!m.track) {
        ctx.textAlign = 'left';
        stroke ? ctx.strokeText(s, x, y) : ctx.fillText(s, x, y);
        return;
      }
      ctx.textAlign = 'left';
      for (const ch of s) {
        stroke ? ctx.strokeText(ch, x, y) : ctx.fillText(ch, x, y);
        x += ctx.measureText(ch).width + m.track;
      }
    });
  }
  function setShadow(ctx, L, fontPx) {
    const sh = L.shadow;
    if (!sh || !sh.on) { ctx.shadowColor = 'transparent'; return; }
    const a = rad(sh.angle ?? 90), d = (sh.dist ?? 0.3) * fontPx * 0.25;
    ctx.shadowColor = hexA(sh.color || '#000000', clamp(sh.opacity ?? 0.4, 0, 1));
    ctx.shadowBlur = (sh.blur ?? 0.4) * fontPx * 0.6;
    ctx.shadowOffsetX = Math.cos(a) * d;
    ctx.shadowOffsetY = Math.sin(a) * d;
  }
  // Dibuja un texto en un contexto donde el cuadro 4:5 tiene alto H y empieza en x0.
  function drawText(ctx, L, x0, H) {
    const W = H * ASPECT;
    const m = layout(ctx, L, H);
    ensureFont(m.f);
    L._box = { w: m.maxW / H, h: m.h / H };
    ctx.save();
    ctx.translate(x0 + L.x * W, L.y * H);
    ctx.rotate(rad(L.rot || 0));
    ctx.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
    ctx.globalCompositeOperation = BLENDS[L.blend] ? L.blend : 'source-over';
    ctx.textBaseline = 'middle';
    ctx.font = fontCSS(m.f, m.fontPx);
    if (L.bg && L.bg.on) {
      const px = m.fontPx * (0.25 + (L.bg.pad ?? 0.5) * 0.6), py = m.fontPx * (0.12 + (L.bg.pad ?? 0.5) * 0.35);
      const bw = m.maxW + px * 2, bh = m.h + py * 2;
      const r = Math.min(bh / 2, (L.bg.radius ?? 0.3) * m.fontPx);
      ctx.fillStyle = hexA(L.bg.color || '#000000', clamp(L.bg.opacity ?? 0.6, 0, 1));
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-bw / 2, -bh / 2, bw, bh, r); else ctx.rect(-bw / 2, -bh / 2, bw, bh);
      ctx.fill();
      L._box = { w: bw / H, h: bh / H };
    }
    setShadow(ctx, L, m.fontPx);
    if (L.stroke && L.stroke.on) {
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.lineWidth = (L.stroke.width ?? 0.3) * m.fontPx * 0.25;
      ctx.strokeStyle = L.stroke.color || '#000000';
      drawLines(ctx, m, L.align, true);
      ctx.shadowColor = 'transparent';
    }
    const wt = clamp(L.weight || 0, -100, 100);
    ctx.fillStyle = L.color || '#ffffff';
    if (wt > 0) {
      // más gruesa: un contorno del mismo color alrededor de cada letra
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.lineWidth = wt / 100 * m.fontPx * 0.06;
      ctx.strokeStyle = ctx.fillStyle;
      drawLines(ctx, m, L.align, true);
      ctx.shadowColor = 'transparent';
      drawLines(ctx, m, L.align, false);
    } else if (wt < 0) {
      // más fina: se dibuja aparte (con el doble de resolución y alineada a los píxeles, para que no se vea borrosa)
      // y se le "come" un borde parejo a cada letra
      const k = 2, ew = (-wt / 100) * m.fontPx * 0.035;
      const pad = Math.ceil(m.fontPx * 0.6 + ew);
      const bw = Math.ceil(m.maxW + Math.abs(m.track) * 2) + pad * 2, bh = Math.ceil(m.h) + pad * 2;
      const T0 = ctx.getTransform();
      const straight = Math.abs(T0.b) < 1e-6 && Math.abs(T0.c) < 1e-6 && T0.a > 0 && T0.d > 0;
      // posición (en coordenadas de la capa) donde va la esquina del dibujo aparte, sobre un píxel entero
      const px = straight ? (Math.round(T0.e - bw / 2 * T0.a) - T0.e) / T0.a : -bw / 2;
      const py = straight ? (Math.round(T0.f - bh / 2 * T0.d) - T0.f) / T0.d : -bh / 2;
      const oc = thinCanvas || (thinCanvas = document.createElement('canvas'));
      if (oc.width < bw * k || oc.height < bh * k) { oc.width = Math.max(oc.width, bw * k); oc.height = Math.max(oc.height, bh * k); }
      const o = oc.getContext('2d');
      o.setTransform(1, 0, 0, 1, 0, 0); o.globalCompositeOperation = 'source-over'; o.clearRect(0, 0, oc.width, oc.height);
      o.setTransform(k, 0, 0, k, -px * k, -py * k);
      o.font = ctx.font; o.textBaseline = 'middle'; o.fillStyle = ctx.fillStyle;
      drawLines(o, m, L.align, false);
      o.globalCompositeOperation = 'destination-out';
      o.lineJoin = 'round'; o.lineWidth = ew; o.strokeStyle = '#000';
      drawLines(o, m, L.align, true);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(oc, 0, 0, bw * k, bh * k, px, py, bw, bh);
    } else drawLines(ctx, m, L.align, false);
    ctx.restore();
  }
  let thinCanvas = null;
  // ---------------- capas de imagen (PNG, logos, firmas…) ----------------
  // La imagen se guarda una sola vez en el dispositivo ("L:<id>") y en la nube (archivos/); la capa sólo la nombra.
  const imgTries = new Map();
  const imgs = new Map();   // id de imagen -> { state: 'loading' | 'ok' | 'err', img, w, h, t, p }
  function imageOf(L) {
    let e = imgs.get(L.img);
    if (e && (e.state !== 'err' || Date.now() - e.t < 12000)) return e;
    e = { state: 'loading' }; imgs.set(L.img, e);
    e.p = (async () => {
      const rec = await DB.get('blobs', 'L:' + L.img).catch(() => null);
      let blob = rec && rec.orig;
      if (!blob && L.fileId) {
        blob = await A.fetchFile(L.fileId);
        await DB.put('blobs', { id: 'L:' + L.img, orig: blob, fileId: L.fileId }).catch(() => { });
      }
      if (!blob) throw new Error('no está la imagen de la capa');
      const img = await A.loadImage(blob);
      Object.assign(e, { img, w: img.naturalWidth, h: img.naturalHeight, state: 'ok' });
      A.redrawAll();
    })().catch(err => {
      console.warn(err); Object.assign(e, { state: 'err', t: Date.now() });
      const n = (imgTries.get(L.img) || 0) + 1; imgTries.set(L.img, n);
      if (n <= 5) setTimeout(() => A.redrawAll(), 12500 * n);   // p. ej. la nube todavía no estaba lista: probar de nuevo
    });
    return e;
  }
  async function imagesReady(it) {
    const ls = (it.texts || []).filter(L => L.type === 'image' && !L.hidden);
    await Promise.all(ls.map(L => { const e = imageOf(L); return e.p ? Promise.race([e.p, new Promise(r => setTimeout(r, 30000))]) : null; }));
  }
  function drawImageLayer(ctx, L, x0, H) {
    const W = H * ASPECT, e = imageOf(L);
    const ar = L.ar || (e.w ? e.w / e.h : 1), h = L.size * H, w = h * ar;
    L._box = { w: w / H, h: L.size };
    if (L.hidden || e.state !== 'ok') return;
    ctx.save();
    ctx.translate(x0 + L.x * W, L.y * H);
    ctx.rotate(rad(L.rot || 0));
    ctx.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
    ctx.globalCompositeOperation = BLENDS[L.blend] ? L.blend : 'source-over';
    setShadow(ctx, L, h * 0.35);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(e.img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  async function addImageFiles(files, it = S.current) {
    if (!it) return;
    let last = null;
    for (const f of files) {
      try {
        toast('Cargando la imagen…', true);
        const { blob, w, h } = await A.prepLayerImage(f);
        const imgId = uid();
        await DB.put('blobs', { id: 'L:' + imgId, orig: blob });
        const ar = w / h;
        const L = {
          id: uid(), type: 'image', img: imgId, ar, name: (f.name || 'Imagen').replace(/\.[^.]+$/, '').slice(0, 32),
          x: 0.5, y: 0.5, rot: 0, opacity: 1, size: Math.min(0.5, 0.8 * ASPECT / ar),
        };
        it.texts = it.texts || [];
        while (it.texts.some(o => Math.abs(o.x - L.x) < 0.01 && Math.abs(o.y - L.y) < 0.01)) L.y = Math.min(0.9, L.y + 0.08);
        it.texts.push(L); last = L;
        toast('Imagen agregada como capa');
      } catch (e) { console.error(e); toast(`No se pudo leer ${f.name || 'la imagen'}: ${e.message || e}`, false, 7000); }
    }
    if (last && S.current === it) { select(last.id); changed(); }
    else if (last) { A.saveItem(it); A.redrawAll(); }
  }
  const imgInput = document.createElement('input');
  imgInput.type = 'file'; imgInput.accept = 'image/*,.heic,.heif,.png,.svg'; imgInput.multiple = true; imgInput.hidden = true;
  document.body.append(imgInput);
  imgInput.addEventListener('change', () => { const fs = [...imgInput.files]; imgInput.value = ''; if (fs.length) addImageFiles(fs); });
  const isImg = L => !!L && L.type === 'image';
  const maxSize = L => (isImg(L) ? 3 : 0.6);

  // Modos de fusión (como en Photoshop). La clave es el nombre que entiende el navegador.
  const BLENDS = { 'source-over': 'Normal', multiply: 'Multiplicar', screen: 'Trama', overlay: 'Superponer', 'soft-light': 'Luz suave', 'hard-light': 'Luz fuerte', darken: 'Oscurecer', lighten: 'Aclarar', difference: 'Diferencia' };
  // Dibuja todas las capas de una publicación en un lienzo de ow×oh (4:5 o miniatura 3:4).
  function draw(ctx, it, ow, oh) {
    if (!it || !it.texts || !it.texts.length) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const x0 = (ow - oh * ASPECT) / 2;
    for (const L of it.texts) {
      if (L.type === 'image') { drawImageLayer(ctx, L, x0, oh); continue; }
      if (L.hidden) { if (!L._box) { const m = layout(ctx, L, oh); L._box = { w: m.maxW / oh, h: m.h / oh }; } continue; }
      drawText(ctx, L, x0, oh);
    }
    ctx.restore();
  }

  // ---------------- edición ----------------
  const DEFAULT = {
    text: 'Tu texto', font: 'inter', size: 0.07, x: 0.5, y: 0.5, rot: 0,
    color: '#ffffff', opacity: 1, align: 'center', caseMode: 'none', letter: 0, line: 1.2, weight: 0,
    shadow: { on: true, color: '#000000', opacity: 0.35, blur: 0.4, dist: 0.25, angle: 90 },
    stroke: { on: false, color: '#000000', width: 0.3 },
    bg: { on: false, color: '#000000', opacity: 0.55, pad: 0.5, radius: 0.3 },
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  let sel = null;            // id del texto seleccionado
  let lastFont = (() => { try { return localStorage.getItem('mosaico.lastFont') || 'inter'; } catch { return 'inter'; } })();
  const cur = () => S.current && sel ? (S.current.texts || []).find(L => L.id === sel) || null : null;
  function changed() { if (!S.current) return; A.saveItem(S.current); A.requestRender(); renderLayersSoon(); }

  function add() {
    const it = S.current; if (!it) return;
    it.texts = it.texts || [];
    const L = { ...clone(DEFAULT), id: uid(), font: fontOf(lastFont).id };
    // que no quede encima de otro texto recién puesto
    while (it.texts.some(o => Math.abs(o.x - L.x) < 0.01 && Math.abs(o.y - L.y) < 0.01)) L.y = Math.min(0.9, L.y + 0.08);
    it.texts.push(L);
    select(L.id);
    changed();
    setTimeout(() => { const ta = $('#tText'); ta.focus(); ta.select(); }, 30);
  }
  function select(id) {
    sel = id;
    document.body.classList.toggle('text-mode', !!id);
    panel.classList.toggle('img-mode', isImg(cur()));
    syncPanel(); A.requestRender(); renderLayers();
    if (!id) hideBox();
  }
  function deselect() { if (sel) { const ta = $('#tText'); if (document.activeElement === ta) ta.blur(); select(null); } }
  function removeSel() {
    const it = S.current, L = cur(); if (!L) return;
    it.texts = it.texts.filter(o => o !== L);
    select(null); changed();
  }
  function duplicate() {
    const it = S.current, L = cur(); if (!L) return;
    const D = { ...clone(L), id: uid(), x: clamp(L.x + 0.04, 0, 1), y: clamp(L.y + 0.04, 0, 1) };
    delete D._box;
    it.texts.push(D); select(D.id); changed();
  }
  // ---- recuadro de selección y guías ----
  const layer = document.createElement('div'); layer.className = 'tlayer';
  layer.innerHTML = '<div class="tsnap v"></div><div class="tsnap h"></div><div class="tbox" hidden><div class="thandle" title="Arrastrá para agrandar y girar"></div></div>';
  frame.append(layer);
  const box = layer.querySelector('.tbox'), handle = layer.querySelector('.thandle');
  const snapV = layer.querySelector('.tsnap.v'), snapH = layer.querySelector('.tsnap.h');
  function hideBox() { box.hidden = true; snapV.classList.remove('on'); snapH.classList.remove('on'); }
  function afterPreview() {
    const L = cur();
    if (!L || !L._box) { box.hidden = true; return; }
    const Hc = frame.clientHeight, Wc = Hc * ASPECT, pad = 6;
    box.hidden = false;
    box.style.left = L.x * Wc + 'px';
    box.style.top = L.y * Hc + 'px';
    box.style.width = L._box.w * Hc + pad * 2 + 'px';
    box.style.height = L._box.h * Hc + pad * 2 + 'px';
    box.style.transform = `translate(-50%, -50%) rotate(${L.rot || 0}deg)`;
    box.classList.toggle('locked', !!L.locked); box.classList.toggle('off', !!L.hidden);
  }

  // ---- gestos ----
  function hitTest(px, py, rect) {
    const its = (S.current && S.current.texts) || [];
    const H = rect.height, pad = (matchMedia('(pointer: coarse)').matches ? 18 : 8) / H;
    for (let i = its.length - 1; i >= 0; i--) {
      const L = its[i]; if (!L._box || L.hidden || L.locked) continue;
      const dx = (px / rect.width - L.x) * ASPECT, dy = py / H - L.y;
      const a = -rad(L.rot || 0), lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= L._box.w / 2 + pad && Math.abs(ly) <= L._box.h / 2 + pad) return L;
    }
    return null;
  }
  const SNAP = 0.012;
  function placeWithSnap(L, rx, ry) {
    const sx = Math.abs(rx - 0.5) < SNAP, sy = Math.abs(ry - 0.5) < SNAP;
    L.x = clamp(sx ? 0.5 : rx, 0, 1); L.y = clamp(sy ? 0.5 : ry, 0, 1);
    snapV.classList.toggle('on', sx); snapH.classList.toggle('on', sy);
  }
  let g = null;              // gesto en curso sobre un texto
  let tapCandidate = null;   // toque en un lugar vacío (para deseleccionar)
  let lastTap = { t: 0, id: null };
  const gp = ps => {
    const v = [...ps.values()];
    const x = v.reduce((a, p) => a + p.x, 0) / v.length, y = v.reduce((a, p) => a + p.y, 0) / v.length;
    const two = v.length >= 2;
    return { x, y, d: two ? Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y) : 0, ang: two ? Math.atan2(v[1].y - v[0].y, v[1].x - v[0].x) * 180 / Math.PI : 0 };
  };
  function pointerDown(e, appBusy) {
    if (!S.current) return false;
    if (g) {   // segundo dedo durante un gesto de texto: pellizcar / girar el texto
      g.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { frame.setPointerCapture(e.pointerId); } catch { }
      g.twist = { acc: 0, on: false, start: g.L.rot || 0 };
      return true;
    }
    if (appBusy) return false;
    const rect = frame.getBoundingClientRect();
    const L = hitTest(e.clientX - rect.left, e.clientY - rect.top, rect);
    if (!L) { tapCandidate = sel ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null; return false; }
    if (sel !== L.id) select(L.id);
    try { frame.setPointerCapture(e.pointerId); } catch { }
    g = { L, ptrs: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]), raw: { x: L.x, y: L.y }, moved: 0, twist: null };
    frame.classList.add('dragging');
    return true;
  }
  function pointerMove(e) {
    if (tapCandidate && tapCandidate.id === e.pointerId && Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y) > 6) tapCandidate = null;
    if (!g || !g.ptrs.has(e.pointerId)) return false;
    const rect = frame.getBoundingClientRect();
    const before = gp(g.ptrs);
    g.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = gp(g.ptrs);
    const L = g.L;
    g.moved += Math.hypot(after.x - before.x, after.y - before.y);
    g.raw.x += (after.x - before.x) / rect.width;
    g.raw.y += (after.y - before.y) / rect.height;
    placeWithSnap(L, g.raw.x, g.raw.y);
    if (g.ptrs.size >= 2 && before.d > 0) {
      L.size = clamp(L.size * after.d / before.d, 0.012, maxSize(L));
      const tw = g.twist;
      if (tw) {
        tw.acc += normRot(after.ang - before.ang);
        if (tw.on || Math.abs(tw.acc) >= 5) { tw.on = true; L.rot = snapRot(normRot(tw.start + tw.acc)); }
      }
    }
    changed(); syncPanelValues();
    return true;
  }
  function pointerUp(e) {
    if (tapCandidate && tapCandidate.id === e.pointerId) { tapCandidate = null; deselect(); }
    if (!g || !g.ptrs.has(e.pointerId)) return false;
    g.ptrs.delete(e.pointerId);
    if (g.ptrs.size === 1) { const p = [...g.ptrs.values()][0]; g.twist = null; }
    if (!g.ptrs.size) {
      const L = g.L, wasTap = g.moved < 4;
      g = null;
      frame.classList.remove('dragging');
      snapV.classList.remove('on'); snapH.classList.remove('on');
      if (wasTap) {   // doble toque sobre el texto: editar
        const now = Date.now();
        if (lastTap.id === L.id && now - lastTap.t < 350 && !isImg(L)) focusText();
        lastTap = { t: now, id: L.id };
      }
    }
    return true;
  }
  function focusText() { const ta = $('#tText'); ta.focus(); ta.select(); }
  // agarrar la esquina: agrandar y girar con un dedo
  let hg = null;
  handle.addEventListener('pointerdown', e => {
    const L = cur(); if (!L) return;
    e.stopPropagation(); e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { }
    const rect = frame.getBoundingClientRect();
    const cx = rect.left + L.x * rect.width, cy = rect.top + L.y * rect.height;
    hg = { id: e.pointerId, cx, cy, d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, a0: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI, size0: L.size, rot0: L.rot || 0, L };
    frame.classList.add('dragging');
  });
  handle.addEventListener('pointermove', e => {
    if (!hg || hg.id !== e.pointerId) return;
    e.stopPropagation();
    const d = Math.hypot(e.clientX - hg.cx, e.clientY - hg.cy), a = Math.atan2(e.clientY - hg.cy, e.clientX - hg.cx) * 180 / Math.PI;
    hg.L.size = clamp(hg.size0 * d / hg.d0, 0.012, maxSize(hg.L));
    hg.L.rot = snapRot(normRot(hg.rot0 + normRot(a - hg.a0)));
    changed(); syncPanelValues();
  });
  const endHandle = e => { if (hg && hg.id === e.pointerId) { hg = null; frame.classList.remove('dragging'); } };
  handle.addEventListener('pointerup', endHandle);
  handle.addEventListener('pointercancel', endHandle);

  // rueda / trackpad: si hay un texto elegido, agranda el texto en vez de la foto
  function wheel(e) {
    const L = cur(); if (!L || L.locked) return false;
    e.preventDefault();
    L.size = clamp(L.size * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0.012, maxSize(L));
    changed(); syncPanelValues();
    return true;
  }
  let mg = null;
  function macGesture(type, e) {
    const L = cur(); if ((!L || L.locked) && !mg) return false;
    e.preventDefault();
    if (type === 'start') mg = { scale: 1, rotation: 0, L, tw: { acc: 0, on: false, start: L.rot || 0 } };
    else if (type === 'change' && mg) {
      mg.L.size = clamp(mg.L.size * e.scale / mg.scale, 0.012, maxSize(mg.L)); mg.scale = e.scale;
      mg.tw.acc += e.rotation - mg.rotation; mg.rotation = e.rotation;
      if (mg.tw.on || Math.abs(mg.tw.acc) >= 5) { mg.tw.on = true; mg.L.rot = snapRot(normRot(mg.tw.start + mg.tw.acc)); }
      changed(); syncPanelValues();
    } else mg = null;
    return true;
  }
  function dblclick(e) {
    const rect = frame.getBoundingClientRect();
    const L = hitTest(e.clientX - rect.left, e.clientY - rect.top, rect);
    if (!L) return false;
    select(L.id); if (!isImg(L)) focusText();
    return true;
  }
  function keydown(e) {
    const L = cur(); if (!L) return false;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || (tag === 'input' && e.target.type !== 'range') || tag === 'select') {
      if (e.key === 'Escape') { e.target.blur(); return true; }
      return false;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' || e.key === 'Enter') { deselect(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { removeSel(); e.preventDefault(); return true; }
    if (mod && e.key.toLowerCase() === 'd') { duplicate(); e.preventDefault(); return true; }
    const step = e.shiftKey ? 0.01 : 0.001;   // flechitas: de a ~1 píxel de la imagen final (con Mayúscula, de a 10)
    if (mod && e.key.toLowerCase() === 'v' && S.lastCopied === 'layer' && layerClip) { pasteLayer(); e.preventDefault(); return true; }
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mod && e.key.toLowerCase() === 'c' && !getSelection().toString()) { copyLayer(L); e.preventDefault(); return true; }
    if (mv && !mod && !L.locked) { L.x = clamp(L.x + mv[0] / ASPECT, 0, 1); L.y = clamp(L.y + mv[1], 0, 1); changed(); e.preventDefault(); return true; }
    return false;
  }

  // ---------------- panel de texto ----------------
  const panel = $('#textPanel');
  const refreshers = [];
  const ALIGN_ICON = {
    left: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h7"/></svg>',
    center: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.5h8M2 10h12M4.5 13.5h7"/></svg>',
    right: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M7 13.5h7"/></svg>',
  };
  panel.innerHTML = `
    <div class="row tp-head">
      <button class="chip" data-t="done">‹ Listo</button>
      <button class="chip" data-t="dup">Duplicar</button>
      <button class="chip" data-t="copy" title="Copiar esta capa para pegarla en otra publicación">Copiar capa</button>
      <button class="chip danger" data-t="del">Borrar</button>
    </div>
    <textarea id="tText" rows="2" placeholder="Escribí acá" autocapitalize="sentences" spellcheck="true"></textarea>
    <div class="tp-field"><span>Tipografía</span>
      <div class="tp-font"><select id="tFont" aria-label="Tipografía"></select>
        <button class="chip" id="tFontAdd" title="Subir una tipografía (.ttf, .otf, .woff)">+ Subir</button>
        <button class="chip danger" id="tFontDel" title="Quitar esta tipografía" hidden>Quitar</button></div>
      <input type="file" id="tFontFile" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2,application/x-font-ttf,application/font-woff" multiple hidden>
    </div>
    <div class="tp-field"><span>Mayúsculas</span>
      <div class="seg" id="tCase">
        <button data-v="none">Normal</button><button data-v="upper">MAYÚS</button><button data-v="lower">minús</button><button data-v="title">Iniciales</button>
      </div></div>
    <div class="tp-field"><span>Alineación</span>
      <div class="seg icons" id="tAlign">
        <button data-v="left" title="Izquierda">${ALIGN_ICON.left}</button><button data-v="center" title="Centro">${ALIGN_ICON.center}</button><button data-v="right" title="Derecha">${ALIGN_ICON.right}</button>
      </div></div>
    <div id="tSizeRot"></div>
    <div class="tp-field"><span>Color</span><div class="swatches" id="tColors"></div></div>
    <div id="tLook"></div>
    <div class="tp-sec" id="tShadow"></div>
    <div class="tp-sec" id="tStroke"></div>
    <div class="tp-sec" id="tBg"></div>
    <div class="tp-field"><span>Estilos guardados</span>
      <div class="styles" id="tStyles"></div>
      <button class="chip" id="tStyleSave">Guardar este estilo</button></div>
    <p class="hint">Arrastrá el texto para moverlo; con dos dedos (o la esquina) lo agrandás y girás. Doble toque para editarlo. Las líneas rosas aparecen al centrarlo.</p>`;

  function slider(parent, { label, min, max, step = 1, get, set, fmt = v => v, cls = '' }) {
    const row = document.createElement('div');
    row.className = 'slider ' + cls;
    row.innerHTML = `<label><span>${label}</span><output></output></label><input type="range" min="${min}" max="${max}" step="${step}">`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { const L = cur(); if (!L) return; set(L, +inp.value); out.textContent = fmt(+inp.value); changed(); });
    refreshers.push(L => { const v = get(L); inp.value = v; out.textContent = fmt(v); });
    A.onDoubleTap(row, () => {   // volver al valor de fábrica
      const L = cur(); if (!L) return;
      const v = get(clone(DEFAULT)); set(L, v); inp.value = v; out.textContent = fmt(v); changed();
    });
    parent.append(row);
    return row;
  }
  // ---- selector de color: se arrastra el dedo por el cuadro y la barra, y el texto cambia en vivo ----
  const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  function hsv2hex(h, sat, v) {
    const f = n => { const k = (n + h / 60) % 6; return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1)); };
    return toHex(f(5) * 255, f(3) * 255, f(1) * 255);
  }
  function hex2hsv(hex) {
    const n = parseInt((hex || '#ffffff').slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: mx ? d / mx : 0, v: mx };
  }
  // ---- gotero ----
  // En Chrome/Edge de compu toma cualquier color de la pantalla. En Safari y en el celular,
  // se toca (o se arrastra el dedo) sobre la foto o sobre las miniaturas de la grilla.
  const DROPPER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 4.6a2.4 2.4 0 0 0-3.4 0l-2.3 2.3-1-1-1.6 1.6 1 1L5 15.6V19h3.4l7.1-7.1 1 1 1.6-1.6-1-1 2.3-2.3a2.4 2.4 0 0 0 0-3.4z"/></svg>';
  let dropping = null;
  function canvasAt(x, y) {
    for (const n of document.elementsFromPoint(x, y)) {
      if (n instanceof HTMLCanvasElement) return n;
      if (n.closest && n.closest('.cpick, .tools .row, header')) return null;
    }
    return null;
  }
  function sampleAt(x, y) {
    const c = canvasAt(x, y); if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    const px = clamp(Math.floor((x - r.left) / r.width * c.width), 0, c.width - 1), py = clamp(Math.floor((y - r.top) / r.height * c.height), 0, c.height - 1);
    try { const ctx = c.getContext('2d'); if (!ctx) return null; const d = ctx.getImageData(px, py, 1, 1).data; return d[3] ? toHex(d[0], d[1], d[2]) : null; } catch { return null; }
  }
  async function pickFromScreen(live, done) {
    if (dropping) dropping.end();
    if (window.EyeDropper) {
      try { const r = await new EyeDropper().open(); live(r.sRGBHex); done(r.sRGBHex); } catch { }
      return;
    }
    A.toast('Gotero: tocá (o arrastrá) sobre la foto o la grilla', true);
    document.body.classList.add('eyedrop');
    let active = false, last = null;
    const stop = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const down = e => {
      const hex = sampleAt(e.clientX, e.clientY);
      if (!hex) { if (!(e.target.closest && e.target.closest('.cp-drop'))) end(); return; }
      stop(e); active = true; last = hex; live(hex);
    };
    const move = e => { if (!active) return; stop(e); const hex = sampleAt(e.clientX, e.clientY); if (hex && hex !== last) { last = hex; live(hex); } };
    const up = e => {
      if (!active) return; stop(e);
      const blockClick = ev => { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); };
      window.addEventListener('click', blockClick, true);
      setTimeout(() => window.removeEventListener('click', blockClick, true), 400);
      done(last); end(); A.toast('Color tomado');
    };
    const key = e => { if (e.key === 'Escape') { end(); A.toast('Gotero cancelado'); } };
    const opts = { capture: true, passive: false };
    function end() {
      window.removeEventListener('pointerdown', down, opts); window.removeEventListener('pointermove', move, opts);
      window.removeEventListener('pointerup', up, opts); window.removeEventListener('pointercancel', up, opts);
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('eyedrop'); dropping = null;
    }
    setTimeout(() => {   // después del toque que abrió el gotero
      window.addEventListener('pointerdown', down, opts); window.addEventListener('pointermove', move, opts);
      window.addEventListener('pointerup', up, opts); window.addEventListener('pointercancel', up, opts);
      window.addEventListener('keydown', key, true);
    }, 0);
    dropping = { end };
  }
  function makePicker({ get, set, commit, onOpen, target = cur, onChange = changed }) {
    const el = document.createElement('div'); el.className = 'cpick'; el.hidden = true;
    el.innerHTML = `<div class="cp-sv"><div class="cp-dot"></div></div><div class="cp-hue"><div class="cp-hdot"></div></div>
      <div class="cp-row"><span class="cp-prev"></span><input class="cp-hex" maxlength="7" spellcheck="false" aria-label="Código de color"><button class="chip cp-drop" title="Gotero: tomar un color de la pantalla" aria-label="Gotero">${DROPPER_ICON}</button><button class="chip cp-ok">Listo</button></div>`;
    const sv = el.querySelector('.cp-sv'), dot = el.querySelector('.cp-dot'), hue = el.querySelector('.cp-hue'), hdot = el.querySelector('.cp-hdot');
    const prev = el.querySelector('.cp-prev'), hexIn = el.querySelector('.cp-hex');
    let hsv = { h: 0, s: 0, v: 1 };
    function paint() {
      sv.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
      dot.style.left = hsv.s * 100 + '%'; dot.style.top = (1 - hsv.v) * 100 + '%';
      hdot.style.left = hsv.h / 360 * 100 + '%';
      const hex = hsv2hex(hsv.h, hsv.s, hsv.v);
      prev.style.background = hex;
      if (document.activeElement !== hexIn) hexIn.value = hex;
      return hex;
    }
    function apply() { const L = target(); if (!L) return; set(L, paint()); onChange(L); }
    function drag(target, onPos) {
      target.addEventListener('pointerdown', e => {
        e.preventDefault();
        try { target.setPointerCapture(e.pointerId); } catch { }
        const move = ev => { const r = target.getBoundingClientRect(); onPos(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); apply(); };
        const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); commit && commit(paint()); };
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
        move(e);
      });
    }
    drag(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; });
    drag(hue, x => { hsv.h = x * 359.9; if (hsv.s < 0.05) hsv.s = 1; if (hsv.v < 0.05) hsv.v = 1; });
    hexIn.addEventListener('input', () => {
      if (!/^#[0-9a-f]{6}$/i.test(hexIn.value)) return;
      hsv = hex2hsv(hexIn.value); apply();
    });
    hexIn.addEventListener('change', () => commit && commit(paint()));
    el.querySelector('.cp-ok').addEventListener('click', () => { el.hidden = true; });
    el.querySelector('.cp-drop').addEventListener('click', () => {
      if (!target()) return;
      pickFromScreen(hex => { hsv = hex2hsv(hex); apply(); }, () => commit && commit(paint()));
    });
    return {
      el,
      toggle() { el.hidden = !el.hidden; if (!el.hidden) { onOpen && onOpen(); this.refresh(); } },
      refresh() { const L = target(); if (!L || el.hidden) return; const now = hex2hsv(get(L)); if (hsv2hex(hsv.h, hsv.s, hsv.v) !== get(L).toLowerCase()) hsv = now; paint(); },
    };
  }
  function colorInput(parent, { label, get, set }) {
    const row = document.createElement('div'); row.className = 'tp-color';
    row.innerHTML = `<span>${label}</span><button class="cbtn" title="Elegir color"></button>`;
    const btn = row.querySelector('.cbtn');
    const pk = makePicker({ get, set });
    btn.addEventListener('click', () => pk.toggle());
    refreshers.push(L => { btn.style.background = get(L); pk.refresh(); });
    parent.append(row, pk.el);
  }
  function section(el, { label, key, build }) {
    el.innerHTML = `<button class="chip tp-toggle">${label}</button><div class="tp-body"></div>`;
    const btn = el.querySelector('.tp-toggle'), body = el.querySelector('.tp-body');
    btn.addEventListener('click', () => {
      const L = cur(); if (!L) return;
      L[key] = { ...clone(DEFAULT[key]), ...(L[key] || {}), on: !(L[key] && L[key].on) };
      changed(); syncPanel();
    });
    refreshers.push(L => { const on = !!(L[key] && L[key].on); btn.classList.toggle('on', on); body.hidden = !on; });
    build(body);
  }
  const sub = (key, prop, dflt) => ({ get: L => (L[key] && L[key][prop] != null ? L[key][prop] : dflt), set: (L, v) => { L[key] = { ...clone(DEFAULT[key]), ...(L[key] || {}) }; L[key][prop] = v; } });
  const pct = v => Math.round(v) + '%';

  // Tamaño: la barra no es pareja, así en los tamaños chicos y medianos (los que más se usan) se mueve más fino.
  const SZ0 = 12, SZ1 = 450, szFromPos = p => SZ0 + (SZ1 - SZ0) * (p / 1000) ** 2, posFromSz = z => Math.round(Math.sqrt(clamp((z - SZ0) / (SZ1 - SZ0), 0, 1)) * 1000);
  slider($('#tSizeRot'), { label: 'Tamaño', min: 0, max: 1000, get: L => posFromSz(L.size * 1000), set: (L, v) => { L.size = szFromPos(v) / 1000; }, fmt: v => (szFromPos(v) / 10).toFixed(1), cls: 'txt-only' });
  const IZ0 = 12, IZ1 = 3000, izFromPos = p => IZ0 + (IZ1 - IZ0) * (p / 1000) ** 2, posFromIz = z => Math.round(Math.sqrt(clamp((z - IZ0) / (IZ1 - IZ0), 0, 1)) * 1000);
  slider($('#tSizeRot'), { label: 'Tamaño', min: 0, max: 1000, get: L => posFromIz(L.size * 1000), set: (L, v) => { L.size = izFromPos(v) / 1000; }, fmt: v => Math.round(izFromPos(v) / 10) + '%', cls: 'img-only' });
  slider($('#tSizeRot'), { label: 'Giro', min: -180, max: 180, step: 0.5, get: L => L.rot || 0, set: (L, v) => { L.rot = snapRot(v); }, fmt: v => (Math.abs(v) < 0.05 ? '0' : v > 0 ? '+' + v : v) + '°' });
  slider($('#tLook'), { label: 'Grosor', min: -100, max: 100, get: L => L.weight || 0, set: (L, v) => { L.weight = v; }, fmt: v => (v > 0 ? '+' : '') + v, cls: 'txt-only' });
  slider($('#tLook'), { label: 'Opacidad', min: 5, max: 100, get: L => Math.round((L.opacity ?? 1) * 100), set: (L, v) => { L.opacity = v / 100; }, fmt: pct });
  {
    const row = document.createElement('label'); row.className = 'tp-color tp-blend';
    row.innerHTML = `<span>Fusión</span><select aria-label="Modo de fusión">${Object.entries(BLENDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`;
    const sl = row.querySelector('select');
    sl.addEventListener('change', () => { const L = cur(); if (!L) return; L.blend = sl.value; changed(); });
    refreshers.push(L => { sl.value = BLENDS[L.blend] ? L.blend : 'source-over'; });
    $('#tLook').append(row);
  }
  slider($('#tLook'), { label: 'Interletrado', min: -100, max: 300, step: 1, get: L => L.letter || 0, set: (L, v) => { L.letter = v; }, fmt: v => (v > 0 ? '+' : '') + v, cls: 'txt-only' });
  slider($('#tLook'), { label: 'Interlineado', min: 70, max: 250, step: 1, get: L => Math.round((L.line || 1.2) * 100), set: (L, v) => { L.line = v / 100; }, fmt: v => (v / 100).toFixed(2), cls: 'txt-only' });
  section($('#tShadow'), {
    label: 'Sombra', key: 'shadow', build: b => {
      const s = sub.bind(null, 'shadow');
      slider(b, { label: 'Intensidad', min: 0, max: 100, ...wrap(s('opacity', 0.35), 100), fmt: pct });
      slider(b, { label: 'Suavidad', min: 0, max: 100, ...wrap(s('blur', 0.4), 100), fmt: pct });
      slider(b, { label: 'Distancia', min: 0, max: 100, ...wrap(s('dist', 0.25), 100), fmt: pct });
      slider(b, { label: 'Dirección', min: 0, max: 355, step: 5, ...s('angle', 90), fmt: v => v + '°' });
      colorInput(b, { label: 'Color de la sombra', ...s('color', '#000000') });
    },
  });
  section($('#tStroke'), {
    label: 'Contorno', key: 'stroke', build: b => {
      const s = sub.bind(null, 'stroke');
      slider(b, { label: 'Grosor', min: 2, max: 100, ...wrap(s('width', 0.3), 100), fmt: pct });
      colorInput(b, { label: 'Color del contorno', ...s('color', '#000000') });
    },
  });
  section($('#tBg'), {
    label: 'Fondo (etiqueta)', key: 'bg', build: b => {
      const s = sub.bind(null, 'bg');
      slider(b, { label: 'Opacidad del fondo', min: 5, max: 100, ...wrap(s('opacity', 0.55), 100), fmt: pct });
      slider(b, { label: 'Margen', min: 0, max: 100, ...wrap(s('pad', 0.5), 100), fmt: pct });
      slider(b, { label: 'Redondeo', min: 0, max: 100, ...wrap(s('radius', 0.3), 100), fmt: pct });
      colorInput(b, { label: 'Color del fondo', ...s('color', '#000000') });
    },
  });
  function wrap(gs, k) { return { get: L => Math.round(gs.get(L) * k), set: (L, v) => gs.set(L, v / k) }; }

  // textos
  const ta = $('#tText');
  ta.addEventListener('input', () => { const L = cur(); if (!L) return; L.text = ta.value; changed(); });
  refreshers.push(L => { if (document.activeElement !== ta) ta.value = L.text || ''; });
  // tipografía
  const fontSel = $('#tFont');
  function renderFonts() {
    fontSel.innerHTML = fontList().map(f => `<option value="${f.id}">${escHtml(f.name)}${custom.has(f.id) ? ' ★' : ''}</option>`).join('');
  }
  fontSel.addEventListener('change', () => {
    const L = cur(); if (!L) return;
    L.font = fontSel.value; lastFont = L.font;
    try { localStorage.setItem('mosaico.lastFont', lastFont); } catch { }
    changed(); syncPanel();
  });
  refreshers.push(L => {
    if (fontSel.options.length !== fontList().length) renderFonts();
    fontSel.value = fontOf(L.font).id;
    $('#tFontDel').hidden = !custom.has(fontSel.value);
  });
  $('#tFontAdd').addEventListener('click', () => $('#tFontFile').click());
  $('#tFontFile').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    const f = await addFontFiles(files);
    renderFonts();
    const L = cur();
    if (f && L) { L.font = f.id; lastFont = f.id; changed(); }
    syncPanel();
  });
  $('#tFontDel').addEventListener('click', () => removeFont(fontSel.value));
  // mayúsculas y alineación
  function seg(id, key) {
    const el = $(id);
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); const L = cur(); if (!b || !L) return;
      L[key] = b.dataset.v; changed(); syncPanel();
    });
    refreshers.push(L => el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (L[key] || DEFAULT[key]))));
  }
  seg('#tCase', 'caseMode'); seg('#tAlign', 'align');
  // colores
  const BASE_COLORS = ['#ffffff', '#000000', '#f3ede2', '#2b2a28'];
  const colorsEl = $('#tColors');
  function renderSwatches() {
    const L = cur(), now = L ? (L.color || '#ffffff').toLowerCase() : '';
    const list = [...new Set([...BASE_COLORS, ...lib.palette.map(c => c.toLowerCase())])];
    colorsEl.innerHTML = list.map(c => `<button class="sw${c === now ? ' on' : ''}" data-c="${c}" style="--c:${c}" title="${c}"></button>`).join('')
      + `<button class="sw pick" title="Elegir otro color (arrastrá para ver en vivo)"></button>`;
  }
  let pickAdded = null;   // color agregado a la paleta en esta apertura del selector (se reemplaza, no se acumula)
  const textPicker = makePicker({
    get: L => L.color || '#ffffff',
    set: (L, c) => { L.color = c; },
    onOpen: () => { pickAdded = null; },
    commit: c => {   // al soltar, el color queda en la paleta compartida
      c = c.toLowerCase();
      if (!BASE_COLORS.includes(c)) { lib.palette = [c, ...lib.palette.filter(x => x !== c && x !== pickAdded)].slice(0, 12); pickAdded = c; libChanged(); }
      else renderSwatches();
    },
  });
  colorsEl.after(textPicker.el);
  refreshers.push(() => textPicker.refresh());
  colorsEl.addEventListener('click', e => {
    const b = e.target.closest('button.sw'); const L = cur(); if (!b || !L) return;
    if (b.classList.contains('pick')) { textPicker.toggle(); return; }
    L.color = b.dataset.c; changed(); renderSwatches(); textPicker.refresh();
  });
  refreshers.push(() => renderSwatches());
  // estilos guardados
  const STYLE_KEYS = ['font', 'size', 'weight', 'color', 'opacity', 'align', 'caseMode', 'letter', 'line', 'shadow', 'stroke', 'bg'];
  const stylesEl = $('#tStyles');
  function renderStyles() {
    stylesEl.innerHTML = lib.styles.length
      ? lib.styles.map(s => `<span class="stylechip"><button class="chip" data-apply="${s.id}">${escHtml(s.name)}</button><button class="x" data-del="${s.id}" title="Borrar estilo">×</button></span>`).join('')
      : '<span class="muted small">Todavía no hay estilos. Armá uno y tocá "Guardar este estilo".</span>';
  }
  stylesEl.addEventListener('click', e => {
    const a = e.target.closest('[data-apply]'), d = e.target.closest('[data-del]');
    if (a) {
      const L = cur(), s = lib.styles.find(x => x.id === a.dataset.apply); if (!L || !s) return;
      Object.assign(L, clone(s.props)); changed(); syncPanel();
    } else if (d) {
      const s = lib.styles.find(x => x.id === d.dataset.del); if (!s) return;
      if (!confirm(`¿Borrar el estilo "${s.name}"?`)) return;
      lib.styles = lib.styles.filter(x => x !== s);
      lib.deletedStyles = [...new Set([...lib.deletedStyles, s.id])];
      libChanged();
    }
  });
  $('#tStyleSave').addEventListener('click', () => {
    const L = cur(); if (!L) return;
    const name = (prompt('Nombre del estilo (por ejemplo "Título" o "Firma")', '') || '').trim();
    if (!name) return;
    const props = {}; for (const k of STYLE_KEYS) if (L[k] !== undefined) props[k] = clone(L[k]);
    lib.styles.push({ id: uid(), name, props });
    libChanged(); toast(`Estilo "${name}" guardado`);
  });
  // botones de arriba
  panel.querySelector('.tp-head').addEventListener('click', e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    ({ done: deselect, dup: duplicate, copy: () => copyLayer(cur()), del: removeSel })[b.dataset.t]();
  });

  function syncPanel() {
    const L = cur();
    if (!L) return;
    for (const r of refreshers) r(L);
  }
  // sólo los valores que cambian con gestos (más liviano)
  let svRaf = 0;
  function syncPanelValues() { if (svRaf) return; svRaf = requestAnimationFrame(() => { svRaf = 0; syncPanel(); }); }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------- panel de capas ----------------
  const lp = $('#layersPanel');
  const IC = {
    eye: '<svg viewBox="0 0 20 20"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.6"/></svg>',
    eyeOff: '<svg viewBox="0 0 20 20"><path d="M3 3l14 14M8.2 4.3A8 8 0 0 1 10 4c5 0 8.5 6 8.5 6a14 14 0 0 1-2.6 3.2M5 6.2A14 14 0 0 0 1.5 10S5 16 10 16a7.6 7.6 0 0 0 3.2-.7"/></svg>',
    lock: '<svg viewBox="0 0 20 20"><rect x="4" y="9" width="12" height="8" rx="1.6"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>',
    unlock: '<svg viewBox="0 0 20 20"><rect x="4" y="9" width="12" height="8" rx="1.6"/><path d="M7 9V6.5a3 3 0 0 1 5.8-1"/></svg>',
    copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M13 7V4.6A1.6 1.6 0 0 0 11.4 3H4.6A1.6 1.6 0 0 0 3 4.6v6.8A1.6 1.6 0 0 0 4.6 13H7"/></svg>',
    img: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="1.6"/><circle cx="7.5" cy="8.3" r="1.4"/><path d="M3.5 14.5l4.3-3.8 3 2.6 2.2-1.9 3.6 3.1"/></svg>',
    grip: '<svg viewBox="0 0 20 20"><path d="M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01"/></svg>',
  };
  const layerName = L => L.name || (isImg(L) ? 'Imagen' : (L.text || '').split('\n')[0].trim().slice(0, 32) || 'Texto');
  let layerClip = (() => { try { return JSON.parse(localStorage.getItem('mosaico.layerClip')); } catch { return null; } })();
  function copyLayer(L) {
    if (!L) return;
    const { _box, id, ...rest } = clone(L);
    layerClip = rest;
    try { localStorage.setItem('mosaico.layerClip', JSON.stringify(layerClip)); } catch { }
    S.lastCopied = 'layer';
    toast(`Capa “${layerName(L)}” copiada: pegala en otra publicación`);
    renderLayers();
  }
  function pasteLayerInto(it) {
    if (!layerClip || !it) return null;
    const L = { ...clone(layerClip), id: uid() };
    it.texts = it.texts || [];
    it.texts.push(L);
    return L;
  }
  function pasteLayer() {
    const it = S.current; if (!it || !layerClip) return;
    const L = pasteLayerInto(it);
    select(L.id); changed();
    toast('Capa pegada');
  }
  let lpRaf = 0;
  function renderLayersSoon() { if (lpRaf) return; lpRaf = requestAnimationFrame(() => { lpRaf = 0; renderLayers(); }); }
  function renderLayers() {
    const it = S.current;
    if (!it) { lp.innerHTML = ''; return; }
    const ts = it.texts || [];
    const rows = ts.slice().reverse().map(L => `
      <div class="lp-row${L.id === sel ? ' on' : ''}${L.hidden ? ' hid' : ''}" data-id="${L.id}">
        <span class="lp-grip" title="Arrastrá para cambiar el orden">${IC.grip}</span>
        <button class="lp-ic" data-l="eye" title="${L.hidden ? 'Mostrar' : 'Ocultar'}">${L.hidden ? IC.eyeOff : IC.eye}</button>
        <button class="lp-name" data-l="sel" title="Tocá para elegirla · doble toque para renombrar"><span class="lp-type">${isImg(L) ? IC.img : 'T'}</span>${escHtml(layerName(L))}</button>
        <button class="lp-ic${L.locked ? ' act' : ''}" data-l="lock" title="${L.locked ? 'Desbloquear' : 'Bloquear (no se mueve sin querer)'}">${L.locked ? IC.lock : IC.unlock}</button>
        <button class="lp-ic" data-l="copy" title="Copiar esta capa">${IC.copy}</button>
      </div>`).join('');
    const bgLabel = it.kind === 'blank' ? 'Fondo · color' : it.kind === 'video' ? 'Fondo · video' : 'Fondo · foto';
    lp.innerHTML = `
      <div class="lp-head"><span>Capas</span>
        <div class="lp-actions">
          <button class="chip accent" data-l="addtext" id="addTextBtn" title="Agregar un texto">+ Texto</button>
          <button class="chip accent" data-l="addimg" id="addImgBtn" title="Agregar una imagen (PNG, logo, firma…) como capa">+ Imagen</button>
          ${layerClip ? `<button class="chip" data-l="paste" title="Pegar la capa copiada">Pegar capa</button><button class="chip" data-l="pastemany" title="Pegar la capa copiada en varias publicaciones">Pegar en…</button>` : ''}
        </div></div>
      <div class="lp-list">${rows}</div>
      <div class="lp-row lp-bg${sel ? '' : ' on'}" data-l="bg"><span class="lp-grip"></span><span class="lp-ic"></span><span class="lp-name">${bgLabel}</span></div>
      ${ts.length ? '' : '<p class="muted-s">Sumá capas con <b>+ Texto</b> o <b>+ Imagen</b>. Después las ordenás arrastrando ⋮⋮, las ocultás con el ojo o las bloqueás con el candado.</p>'}`;
    const list = lp.querySelector('.lp-list');
    if (window.Sortable && ts.length > 1) Sortable.create(list, {
      handle: '.lp-grip', animation: 140,
      onEnd() {
        const ids = [...list.children].map(r => r.dataset.id).reverse();   // la lista se ve de arriba (frente) hacia abajo
        it.texts = ids.map(id => ts.find(L => L.id === id)).filter(Boolean);
        changed(); renderLayers();
      },
    });
  }
  let lastNameTap = { id: null, t: 0 };
  function renameLayer(L) {
    const n = prompt('Nombre de la capa', layerName(L));
    if (n == null) return;
    L.name = n.trim() || undefined; changed(); renderLayers();
  }
  lp.addEventListener('click', e => {
    const b = e.target.closest('[data-l]'); if (!b || !S.current) return;
    const row = b.closest('.lp-row'), L = row && row.dataset.id ? (S.current.texts || []).find(x => x.id === row.dataset.id) : null;
    const act = b.dataset.l;
    if (act === 'addtext') return add();
    if (act === 'addimg') return imgInput.click();
    if (act === 'paste') return pasteLayer();
    if (act === 'pastemany') return A.startSelect('layer');
    if (act === 'bg') return deselect();
    if (!L) return;
    if (act === 'sel') {
      const now = Date.now();
      if (lastNameTap.id === L.id && now - lastNameTap.t < 380) { lastNameTap = { id: null, t: 0 }; return renameLayer(L); }
      lastNameTap = { id: L.id, t: now };
      if (sel !== L.id) select(L.id);
      return;
    }
    if (act === 'eye') { L.hidden = !L.hidden; changed(); renderLayers(); return; }
    if (act === 'lock') { L.locked = !L.locked; changed(); renderLayers(); A.requestRender(); return; }
    if (act === 'copy') return copyLayer(L);
  });

  // ---------------- inicio ----------------
  async function init() {
    try {
      const saved = await DB.get('meta', 'library');
      if (saved) lib = { ...lib, ...saved };
      const recs = await DB.getAll('fonts');
      for (const r of recs) if (!lib.deletedFonts.includes(r.id)) registerFont(r);
    } catch (e) { console.error(e); }
    renderFonts(); renderStyles(); renderSwatches();
    BUILTIN.forEach(ensureFont);
  }

  return {
    init, draw, fontsReady, afterPreview, add, deselect, select,
    pointerDown, pointerMove, pointerUp, wheel, macGesture, dblclick, keydown,
    onItemChanged() { if (sel) select(null); },
    refresh() { if (sel && !cur()) select(null); else { syncPanel(); } renderLayers(); },
    renderLayers, pasteLayerInto, addImageFiles, hasLayerClip: () => !!layerClip, pasteLayer,
    hasSelection: () => !!cur(),
    // selector de color y paleta compartida, para otros controles (p. ej. el fondo de una publicación vacía)
    colorPicker: opts => makePicker(opts),
    palette: () => lib.palette.slice(),
    addToPalette(c) { c = (c || '').toLowerCase(); if (!/^#[0-9a-f]{6}$/.test(c) || BASE_COLORS.includes(c)) return; lib.palette = [c, ...lib.palette.filter(x => x !== c)].slice(0, 12); libChanged(); },
    // para la nube
    library: {
      get: () => ({ styles: lib.styles, deletedStyles: lib.deletedStyles, deletedFonts: lib.deletedFonts, palette: lib.palette, dirty: lib.dirty, gen: lib.gen }),
      merge: mergeLibrary,
      apply: applyLibrary,
    },
    fonts: {
      pending: () => [...custom.values()].filter(f => !f.driveId && f.blob),
      isKnown: id => custom.has(id) || lib.deletedFonts.includes(id),
      async setDriveId(id, driveId) {
        const f = custom.get(id); if (!f) return;
        f.driveId = driveId;
        await DB.put('fonts', { id, name: f.name, ext: f.ext, blob: f.blob, driveId });
      },
      async addRemote({ id, name, ext, driveId }, blob) {
        if (custom.has(id) || lib.deletedFonts.includes(id)) return;
        await DB.put('fonts', { id, name, ext, blob, driveId }).catch(() => { });
        await registerFont({ id, name, ext, blob, driveId });
        renderFonts(); syncPanel();
      },
    },
    _applyCase: applyCase,
  };
};
