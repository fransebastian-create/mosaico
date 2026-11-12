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
    const fs = [...new Set((it.texts || []).map(L => fontOf(L.font)))];
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
    ctx.fillStyle = L.color || '#ffffff';
    drawLines(ctx, m, L.align, false);
    ctx.restore();
  }
  // Dibuja todos los textos de una publicación en un lienzo de ow×oh (4:5 o miniatura 3:4).
  function draw(ctx, it, ow, oh) {
    if (!it || !it.texts || !it.texts.length) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const x0 = (ow - oh * ASPECT) / 2;
    for (const L of it.texts) drawText(ctx, L, x0, oh);
    ctx.restore();
  }

  // ---------------- edición ----------------
  const DEFAULT = {
    text: 'Tu texto', font: 'inter', size: 0.07, x: 0.5, y: 0.5, rot: 0,
    color: '#ffffff', opacity: 1, align: 'center', caseMode: 'none', letter: 0, line: 1.2,
    shadow: { on: true, color: '#000000', opacity: 0.35, blur: 0.4, dist: 0.25, angle: 90 },
    stroke: { on: false, color: '#000000', width: 0.3 },
    bg: { on: false, color: '#000000', opacity: 0.55, pad: 0.5, radius: 0.3 },
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  let sel = null;            // id del texto seleccionado
  let lastFont = (() => { try { return localStorage.getItem('mosaico.lastFont') || 'inter'; } catch { return 'inter'; } })();
  const cur = () => S.current && sel ? (S.current.texts || []).find(L => L.id === sel) || null : null;
  function changed() { if (!S.current) return; A.saveItem(S.current); A.requestRender(); }

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
    syncPanel(); A.requestRender();
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
  function restack(dir) {
    const it = S.current, L = cur(); if (!L) return;
    const a = it.texts, i = a.indexOf(L), j = clamp(i + dir, 0, a.length - 1);
    if (i === j) return;
    a.splice(i, 1); a.splice(j, 0, L); changed();
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
  }

  // ---- gestos ----
  function hitTest(px, py, rect) {
    const its = (S.current && S.current.texts) || [];
    const H = rect.height, pad = (matchMedia('(pointer: coarse)').matches ? 18 : 8) / H;
    for (let i = its.length - 1; i >= 0; i--) {
      const L = its[i]; if (!L._box) continue;
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
      L.size = clamp(L.size * after.d / before.d, 0.012, 0.6);
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
        if (lastTap.id === L.id && now - lastTap.t < 350) focusText();
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
    hg.L.size = clamp(hg.size0 * d / hg.d0, 0.012, 0.6);
    hg.L.rot = snapRot(normRot(hg.rot0 + normRot(a - hg.a0)));
    changed(); syncPanelValues();
  });
  const endHandle = e => { if (hg && hg.id === e.pointerId) { hg = null; frame.classList.remove('dragging'); } };
  handle.addEventListener('pointerup', endHandle);
  handle.addEventListener('pointercancel', endHandle);

  // rueda / trackpad: si hay un texto elegido, agranda el texto en vez de la foto
  function wheel(e) {
    const L = cur(); if (!L) return false;
    e.preventDefault();
    L.size = clamp(L.size * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0.012, 0.6);
    changed(); syncPanelValues();
    return true;
  }
  let mg = null;
  function macGesture(type, e) {
    const L = cur(); if (!L && !mg) return false;
    e.preventDefault();
    if (type === 'start') mg = { scale: 1, rotation: 0, L, tw: { acc: 0, on: false, start: L.rot || 0 } };
    else if (type === 'change' && mg) {
      mg.L.size = clamp(mg.L.size * e.scale / mg.scale, 0.012, 0.6); mg.scale = e.scale;
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
    select(L.id); focusText();
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
    const step = e.shiftKey ? 0.02 : 0.004;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !mod) { L.x = clamp(L.x + mv[0] / ASPECT, 0, 1); L.y = clamp(L.y + mv[1], 0, 1); changed(); e.preventDefault(); return true; }
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
      <button class="chip" data-t="front" title="Traer adelante">Adelante</button>
      <button class="chip" data-t="back" title="Mandar atrás">Atrás</button>
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

  function slider(parent, { label, min, max, step = 1, get, set, fmt = v => v }) {
    const row = document.createElement('div');
    row.className = 'slider';
    row.innerHTML = `<label><span>${label}</span><output></output></label><input type="range" min="${min}" max="${max}" step="${step}">`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { const L = cur(); if (!L) return; set(L, +inp.value); out.textContent = fmt(+inp.value); changed(); });
    refreshers.push(L => { const v = get(L); inp.value = v; out.textContent = fmt(v); });
    parent.append(row);
    return row;
  }
  function colorInput(parent, { label, get, set }) {
    const l = document.createElement('label'); l.className = 'tp-color';
    l.innerHTML = `<span>${label}</span><input type="color">`;
    const inp = l.querySelector('input');
    inp.addEventListener('input', () => { const L = cur(); if (!L) return; set(L, inp.value); changed(); });
    refreshers.push(L => { inp.value = get(L); });
    parent.append(l);
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

  slider($('#tSizeRot'), { label: 'Tamaño', min: 12, max: 400, get: L => Math.round(L.size * 1000), set: (L, v) => { L.size = v / 1000; }, fmt: v => (v / 10).toFixed(1) });
  slider($('#tSizeRot'), { label: 'Giro', min: -180, max: 180, step: 0.5, get: L => L.rot || 0, set: (L, v) => { L.rot = snapRot(v); }, fmt: v => (Math.abs(v) < 0.05 ? '0' : v > 0 ? '+' + v : v) + '°' });
  slider($('#tLook'), { label: 'Opacidad', min: 5, max: 100, get: L => Math.round((L.opacity ?? 1) * 100), set: (L, v) => { L.opacity = v / 100; }, fmt: pct });
  slider($('#tLook'), { label: 'Interletrado', min: -100, max: 400, step: 5, get: L => L.letter || 0, set: (L, v) => { L.letter = v; }, fmt: v => (v > 0 ? '+' : '') + v });
  slider($('#tLook'), { label: 'Interlineado', min: 70, max: 250, step: 5, get: L => Math.round((L.line || 1.2) * 100), set: (L, v) => { L.line = v / 100; }, fmt: v => (v / 100).toFixed(2) });
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
      + `<label class="sw pick" title="Otro color"><input type="color" value="${now || '#ffffff'}"></label>`;
  }
  colorsEl.addEventListener('click', e => {
    const b = e.target.closest('button.sw'); const L = cur(); if (!b || !L) return;
    L.color = b.dataset.c; changed(); renderSwatches();
  });
  colorsEl.addEventListener('input', e => { const L = cur(); if (!L || e.target.type !== 'color') return; L.color = e.target.value; changed(); });
  colorsEl.addEventListener('change', e => {   // al soltar el selector, el color queda en la paleta compartida
    if (e.target.type !== 'color') return;
    const c = e.target.value.toLowerCase();
    if (!BASE_COLORS.includes(c)) { lib.palette = [c, ...lib.palette.filter(x => x !== c)].slice(0, 12); libChanged(); }
  });
  refreshers.push(() => renderSwatches());
  // estilos guardados
  const STYLE_KEYS = ['font', 'size', 'color', 'opacity', 'align', 'caseMode', 'letter', 'line', 'shadow', 'stroke', 'bg'];
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
    ({ done: deselect, dup: duplicate, front: () => restack(1), back: () => restack(-1), del: removeSel })[b.dataset.t]();
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
    refresh() { if (sel && !cur()) select(null); else { syncPanel(); } },
    hasSelection: () => !!cur(),
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
