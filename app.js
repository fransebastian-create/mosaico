'use strict';
(() => {
  // ================= Constantes =================
  const VERSION = 'v1.6';
  const ASPECT = 4 / 5;        // publicación (ancho / alto)
  const GRID_ASPECT = 3 / 4;   // miniatura del perfil
  const OUT_W = 1080, OUT_H = 1350;
  const MAX_SRC = 4096;        // lado máximo que guardamos del original
  const THUMB_SRC = 1080;      // lado máximo de la versión liviana
  const MAX_ZOOM = 5;

  const ADJ = [
    { key: 'exposure', label: 'Exposición' },
    { key: 'contrast', label: 'Contraste' },
    { key: 'highlights', label: 'Luces' },
    { key: 'shadows', label: 'Sombras' },
    { key: 'temp', label: 'Temperatura' },
    { key: 'tint', label: 'Tinte' },
    { key: 'saturation', label: 'Saturación' },
    { key: 'vibrance', label: 'Intensidad' },
    { key: 'fade', label: 'Desvanecer', min: 0 },
  ];
  const zeroAdj = () => Object.fromEntries(ADJ.map(a => [a.key, 0]));

  const $ = s => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isNarrow = () => matchMedia('(max-width: 899px)').matches;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  // Doble clic (compu) o doble toque (celular, donde el navegador no avisa doble clic en los controles).
  function onDoubleTap(el, fn) {
    let last = null;
    const skip = e => e.target.closest && e.target.closest('.nudge');   // los botones − / + no cuentan como doble toque
    el.addEventListener('dblclick', e => { if (skip(e)) return; e.preventDefault(); fn(); last = null; });
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || skip(e)) return;
      const now = Date.now();
      if (last && now - last.t < 380 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) { last = null; fn(); }
      else last = { t: now, x: e.clientX, y: e.clientY };
    });
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ================= Proyectos en este dispositivo =================
  // Cada proyecto tiene su propia memoria local (base de datos aparte), así las grillas no se mezclan.
  // La pestaña recuerda su proyecto en la dirección (?p=…), así se pueden tener dos abiertos a la vez.
  const WS = (() => {
    const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
    const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { } };
    let list = get('mosaico.workspaces');
    if (!Array.isArray(list) || !list.length) {
      // primera vez con proyectos: lo que ya había pasa a ser el proyecto principal
      const old = get('mosaico.project');
      list = [{ id: 'principal', name: (old && old.name) || 'Mi grilla', db: 'mosaico' }];
      if (old) { set('mosaico.project.principal', old); set('mosaico.project', null); }
      set('mosaico.workspaces', list);
    }
    // proyectos que se pidió quitar mientras estaban abiertos
    for (const db of get('mosaico.pendingDelete') || []) { try { indexedDB.deleteDatabase(db); } catch { } }
    set('mosaico.pendingDelete', null);
    const urlP = new URLSearchParams(location.search).get('p');
    const cur = list.find(w => w.id === urlP) || list.find(w => w.id === get('mosaico.current')) || list[0];
    set('mosaico.current', cur.id);
    if (urlP !== cur.id) { const u = new URL(location.href); u.searchParams.set('p', cur.id); history.replaceState(null, '', u); }
    return {
      list, cur, get, set,
      save() { set('mosaico.workspaces', list); },
      project: w => get('mosaico.project.' + w.id),
      url: id => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('p', id); return u.href; },
      go(id) { set('mosaico.current', id); location.href = this.url(id); },
      create(name) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = { id, name, db: 'mosaico-' + id };
        list.push(w); this.save();
        return w;
      },
    };
  })();

  // ================= Almacenamiento local (IndexedDB) =================
  const DB = {
    _p: null,
    open() {
      return this._p ||= new Promise((res, rej) => {
        const r = indexedDB.open(WS.cur.db, 3);
        r.onblocked = () => toast('Cerrá las otras pestañas de Mosaico y recargá esta (hay una versión nueva).', true);
        r.onupgradeneeded = () => {
          const d = r.result;
          const mk = (n, o) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); };
          mk('items', { keyPath: 'id' });
          mk('blobs', { keyPath: 'id' });   // fotograma/foto + miniatura (se reescribe seguido, es liviano)
          mk('videos', { keyPath: 'id' });  // video original (se escribe una sola vez)
          mk('meta');
          mk('fonts', { keyPath: 'id' });   // tipografías propias
        };
        r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); };
        r.onerror = () => rej(r.error);
      });
    },
    async run(stores, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = t.onabort = () => rej(t.error);
      });
    },
    getAll(store) { return this.run([store], 'readonly', t => t.objectStore(store).getAll()); },
    get(store, key) { return this.run([store], 'readonly', t => t.objectStore(store).get(key)); },
    put(store, val, key) {
      return this.run([store], 'readwrite', t => { key === undefined ? t.objectStore(store).put(val) : t.objectStore(store).put(val, key); });
    },
    remove(id) {
      return this.run(['items', 'blobs', 'videos'], 'readwrite', t => {
        t.objectStore('items').delete(id); t.objectStore('blobs').delete(id); t.objectStore('videos').delete(id);
      });
    },
  };

  const S = {
    items: new Map(),
    order: [],
    current: null,
    full: null,              // {id, img, w, h} imagen completa de la foto abierta
    showOriginalGrid: false,
    gridAspect: GRID_ASPECT,
    clip: null,              // ajustes copiados
    selecting: false,
    selected: new Set(),
    holdBefore: false,
    deleted: new Set(),      // publicaciones eliminadas (para que no reaparezcan desde la nube)
    orderDirty: false,
  };

  const cleanTexts = ts => (ts || []).map(({ _box, ...L }) => L);
  const meta = it => ({ id: it.id, name: it.name, w: it.w, h: it.h, crop: it.crop, adj: it.adj, texts: cleanTexts(it.texts), bg: it.bg, kind: it.kind || 'image', duration: it.duration, t: it.t, parent: it.parent, slides: it.slides, sync: it.sync || null });
  let Sync = null;   // sincronización con Google Drive (drive.js)
  const saveTimers = new Map();
  function saveItem(it) {
    it._gen = (it._gen || 0) + 1;
    if (it.sync) it.sync.dirty = true;
    clearTimeout(saveTimers.get(it.id));
    saveTimers.set(it.id, setTimeout(() => DB.put('items', meta(it)).catch(reportError), 300));
    if (Sync) Sync.kick();
  }
  const persistItem = it => DB.put('items', meta(it)).catch(reportError);
  function persistOrder() {
    DB.put('meta', S.order, 'order').catch(reportError);
    DB.put('meta', [...S.deleted], 'deleted').catch(reportError);
    DB.put('meta', !!S.orderDirty, 'orderDirty').catch(reportError);
  }
  function saveOrder() { S.orderDirty = true; persistOrder(); if (Sync) Sync.kick(); }
  function reportError(e) { console.error(e); toast('Algo falló al guardar: ' + (e && e.message || e)); }

  // ================= Utilidades de imagen =================
  function loadImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('formato no soportado')); };
      img.src = url;
    });
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  // Publicación vacía: el "fondo" es una imagen chiquita de un color liso (se estira sin perder nada).
  const BLANK_BG = '#efe9df';
  function solidImage(color) {
    const c = canvas(40, 50), x = c.getContext('2d');
    x.fillStyle = color || BLANK_BG; x.fillRect(0, 0, 40, 50);
    c.naturalWidth = 40; c.naturalHeight = 50;
    return c;
  }
  function toBlob(c, type = 'image/jpeg', q = 0.95) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('no se pudo generar la imagen')), type, q));
  }
  // Achica en pasos de a la mitad para mantener la nitidez.
  function downscale(src, sw, sh, maxSide) {
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const tw = Math.round(sw * s), th = Math.round(sh * s);
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const c = canvas(Math.round(cw / 2), Math.round(ch / 2));
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, c.width, c.height);
      if (cur !== src) cur.width = 0;
      cur = c; cw = c.width; ch = c.height;
    }
    const out = canvas(tw, th);
    const x = out.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, tw, th);
    if (cur !== src) cur.width = 0;
    return out;
  }

  // ================= HEIC (fotos de iPhone) =================
  // Safari las lee directo; en Chrome/Android se convierten con un decodificador que se carga sólo si hace falta.
  const isHeic = f => /image\/hei[cf]/i.test(f.type || '') || /\.hei[cf]$/i.test(f.name || '');
  let heicLib;
  function loadHeicLib() {
    return heicLib ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      s.onload = () => window.heic2any ? res(window.heic2any) : rej(new Error('conversor HEIC no disponible'));
      s.onerror = () => { heicLib = null; rej(new Error('no se pudo cargar el conversor HEIC (¿sin internet?)')); };
      document.head.append(s);
    });
  }
  async function heicToJpeg(f) {
    const conv = await loadHeicLib();
    let out = await conv({ blob: f, toType: 'image/jpeg', quality: 0.96 });
    if (Array.isArray(out)) out = out[0];   // fotos "en ráfaga" traen varias imágenes
    return out;
  }

  // ================= Videos =================
  const isVideoFile = f => (f.type || '').startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(f.name || '');
  function openVideo(blob) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      const url = URL.createObjectURL(blob);
      v._url = url;
      const fail = () => { URL.revokeObjectURL(url); rej(new Error('este navegador no puede leer este video (los .mov del iPhone suelen ser HEVC: probá abrir la app en Safari)')); };
      v.onerror = fail;
      v.onloadedmetadata = async () => {
        // iPhone a veces no decodifica fotogramas hasta que se reproduce un instante
        try { await v.play(); v.pause(); } catch { }
        if (!v.videoWidth) return fail();
        res(v);
      };
      v.src = url; v.load();
    });
  }
  function closeVideo(v) {
    if (!v) return;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch { }
    URL.revokeObjectURL(v._url);
  }
  function seekVideo(v, t) {
    return new Promise(res => {
      let done = false;
      const fin = () => {
        if (done) return; done = true;
        v.removeEventListener('seeked', fin);
        // esperar a que el fotograma esté pintado
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => res());
        else requestAnimationFrame(() => res());
        setTimeout(res, 250);
      };
      v.addEventListener('seeked', fin);
      setTimeout(fin, 3000);
      v.currentTime = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.01));
    });
  }
  async function grabFrame(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = Math.min(1, MAX_SRC / Math.max(vw, vh));
    const c = canvas(Math.round(vw * s), Math.round(vh * s));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(v, 0, 0, c.width, c.height);
    const orig = await toBlob(c, 'image/jpeg', 0.95);
    const tc = downscale(c, c.width, c.height, THUMB_SRC);
    const thumb = await toBlob(tc, 'image/jpeg', 0.9);
    const out = { orig, thumb, w: c.width, h: c.height };
    tc.width = 0; c.width = 0;
    return out;
  }
  const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;

  // ================= Geometría del recorte =================
  // crop = {z, cx, cy, rot}: zoom (1 = la foto cubre justo el marco), centro normalizado (0..1)
  // y giro en grados (positivo = horario). El marco 4:5 siempre queda cubierto por la foto.
  const rad = d => d * Math.PI / 180;
  const normRot = r => ((((r + 180) % 360) + 360) % 360) - 180;
  const base90 = r => Math.round(r / 90) * 90;
  const snapRot = r => { const n = base90(r); return Math.abs(r - n) < 3 ? n : r; };
  // ancho del marco (en px de la imagen) con zoom 1: el rectángulo 4:5 más grande que entra girado
  function baseF(w, h, rot) {
    const a = rad(rot || 0), c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const f = Math.min(w / (c + s / ASPECT), h / (s + c / ASPECT));
    return (rot || 0) % 360 ? f * 0.998 : f;   // margen mínimo para que no asomen bordes
  }
  function frameSize(w, h, crop) {
    const fw = baseF(w, h, crop.rot) / crop.z;
    return { fw, fh: fw / ASPECT };
  }
  function clampCrop(it) {
    const c = it.crop;
    c.rot = normRot(c.rot || 0);
    c.z = clamp(c.z, 1, MAX_ZOOM);
    const { fw, fh } = frameSize(it.w, it.h, c);
    const a = rad(c.rot), co = Math.abs(Math.cos(a)), si = Math.abs(Math.sin(a));
    const ex = (fw * co + fh * si) / 2, ey = (fw * si + fh * co) / 2;
    c.cx = clamp(c.cx, ex / it.w, 1 - ex / it.w);
    c.cy = clamp(c.cy, ey / it.h, 1 - ey / it.h);
  }

  // Para girar sin perder nitidez, primero se achica la imagen en pasos de calidad (y se guarda).
  const preCache = new WeakMap();
  function prescaled(src, sw, sh, k, hq) {
    if (k >= 0.5) return { img: src, sw, sh };
    const ps = Math.min(1, Math.pow(2, Math.floor(Math.log2(2 * k))));
    const isVideo = typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement;
    if (isVideo && !hq) return { img: src, sw, sh };
    let m = !isVideo && preCache.get(src);
    if (m && m.has(ps)) return m.get(ps);
    const c = downscale(src, sw, sh, Math.round(Math.max(sw, sh) * ps));
    const entry = { img: c, sw: c.width, sh: c.height };
    if (!isVideo) {
      if (!m) { m = new Map(); preCache.set(src, m); }
      if (m.size >= 3) { const [k0, e0] = m.entries().next().value; e0.img.width = 0; m.delete(k0); }
      m.set(ps, entry);
    }
    return entry;
  }
  // Dibuja el recorte (girado o no) en un contexto de ow×oh. Sirve para 4:5 y para la miniatura 3:4.
  function drawCropped(x, src, sw, sh, crop, ow, oh, hq) {
    const rot = crop.rot || 0;
    const fh = baseF(sw, sh, rot) / crop.z / ASPECT;   // alto del marco en px de la fuente
    const k = oh / fh;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    if (!rot) {
      const fw = ow / k;
      const sx = clamp(crop.cx * sw - fw / 2, 0, sw - fw), sy = clamp(crop.cy * sh - fh / 2, 0, sh - fh);
      x.drawImage(src, sx, sy, fw, fh, 0, 0, ow, oh);
      return;
    }
    const p = prescaled(src, sw, sh, k, hq);
    const r = p.sw / sw;
    x.fillStyle = '#000'; x.fillRect(0, 0, ow, oh);
    x.translate(ow / 2, oh / 2);
    x.rotate(rad(rot));
    x.scale(k / r, k / r);
    x.translate(-crop.cx * p.sw, -crop.cy * p.sh);
    x.drawImage(p.img, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ================= Motor de color (WebGL) =================
  // Versión sin GPU (misma matemática, más lenta): se usa sólo si no hay WebGL.
  const cpuRenderer = () => {
    const c2 = canvas(1, 1), x2 = c2.getContext('2d', { willReadFrequently: true });
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2);
    const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    function render(src, sw, sh, crop, adj, ow, oh, aspect = ASPECT, hq = false) {
      if (c2.width !== ow || c2.height !== oh) { c2.width = ow; c2.height = oh; }
      drawCropped(x2, src, sw, sh, crop, ow, oh, hq);
      if (!adj || ADJ.every(a => !adj[a.key])) return c2;
      const u = k => (adj[k] || 0) / 100;
      const ex = Math.pow(2, u('exposure') * 1.5), con = 1 + u('contrast') * 0.5;
      const hi = u('highlights'), sh_ = u('shadows'), tp = u('temp'), tn = u('tint');
      const sat = 1 + u('saturation'), vib = u('vibrance'), fd = u('fade');
      const wr = 1 + 0.2 * tp, wg = 1 - 0.15 * tn, wb = 1 - 0.2 * tp, g = 1 / 2.2;
      const im = x2.getImageData(0, 0, ow, oh), d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        let R_ = lin[d[i]], G = lin[d[i + 1]], B = lin[d[i + 2]];
        const y0 = 0.2126 * R_ + 0.7152 * G + 0.0722 * B;
        R_ *= wr; G *= wg; B *= wb;
        const k = ex * y0 / Math.max(0.2126 * R_ + 0.7152 * G + 0.0722 * B, 1e-5);
        R_ = Math.pow(R_ * k, g); G = Math.pow(G * k, g); B = Math.pow(B * k, g);
        let y = 0.2126 * R_ + 0.7152 * G + 0.0722 * B;
        const dd = sh_ * 0.3 * (1 - ss(0, 0.6, y)) + hi * 0.3 * ss(0.4, 1, y);
        R_ = (R_ + dd - 0.5) * con + 0.5; G = (G + dd - 0.5) * con + 0.5; B = (B + dd - 0.5) * con + 0.5;
        y = 0.2126 * R_ + 0.7152 * G + 0.0722 * B;
        R_ = y + (R_ - y) * sat; G = y + (G - y) * sat; B = y + (B - y) * sat;
        const s = clamp(Math.max(R_, G, B) - Math.min(R_, G, B), 0, 1), v = 1 + vib * (1 - s);
        R_ = y + (R_ - y) * v; G = y + (G - y) * v; B = y + (B - y) * v;
        d[i] = (R_ * (1 - 0.15 * fd) + 0.15 * fd) * 255;
        d[i + 1] = (G * (1 - 0.15 * fd) + 0.15 * fd) * 255;
        d[i + 2] = (B * (1 - 0.15 * fd) + 0.15 * fd) * 255;
      }
      x2.putImageData(im, 0, 0);
      return c2;
    }
    return { render };
  };

  const R = (() => {
    const glc = canvas(1, 1);
    const gl = glc.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return cpuRenderer();
    const vs = `attribute vec2 p; varying vec2 v;
      void main(){ v = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
    const fs = `precision highp float;
      varying vec2 v; uniform sampler2D t;
      uniform float u_exposure,u_contrast,u_highlights,u_shadows,u_temp,u_tint,u_saturation,u_vibrance,u_fade;
      float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
      void main(){
        vec3 c = texture2D(t, v).rgb;
        // balance de blancos y exposición en luz lineal
        vec3 l = pow(c, vec3(2.2));
        float y0 = luma(l);
        l *= vec3(1.0 + 0.2*u_temp, 1.0 - 0.15*u_tint, 1.0 - 0.2*u_temp);
        l *= y0 / max(luma(l), 1e-5);
        l *= exp2(u_exposure * 1.5);
        c = pow(max(l, 0.0), vec3(1.0/2.2));
        // luces y sombras
        float y = luma(c);
        c += u_shadows * 0.3 * (1.0 - smoothstep(0.0, 0.6, y)) + u_highlights * 0.3 * smoothstep(0.4, 1.0, y);
        // contraste
        c = (c - 0.5) * (1.0 + u_contrast * 0.5) + 0.5;
        // saturación e intensidad
        y = luma(c);
        c = mix(vec3(y), c, 1.0 + u_saturation);
        float s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
        c = mix(vec3(y), c, 1.0 + u_vibrance * (1.0 - clamp(s, 0.0, 1.0)));
        // desvanecer (negros lavados)
        c = c * (1.0 - 0.15*u_fade) + 0.15*u_fade;
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const U = {};
    for (const a of ADJ) U[a.key] = gl.getUniformLocation(prog, 'u_' + a.key);

    const c2 = canvas(1, 1), x2 = c2.getContext('2d');
    // 1) recorta y escala con calidad alta en 2D, 2) aplica el color en la GPU
    function render(src, sw, sh_, crop, adj, ow, oh, aspect = ASPECT, hq = false) {
      if (c2.width !== ow || c2.height !== oh) { c2.width = ow; c2.height = oh; }
      x2.setTransform(1, 0, 0, 1, 0, 0);
      x2.clearRect(0, 0, ow, oh);
      drawCropped(x2, src, sw, sh_, crop, ow, oh, hq);
      if (glc.width !== ow || glc.height !== oh) { glc.width = ow; glc.height = oh; }
      gl.viewport(0, 0, ow, oh);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, c2);
      for (const a of ADJ) gl.uniform1f(U[a.key], (adj ? adj[a.key] : 0) / 100);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return glc;
    }
    return { render };
  })();

  // ================= Elementos =================
  const gridEl = $('#grid'), emptyEl = $('#empty'), countEl = $('#count');
  const frame = $('#frame'), pv = $('#preview'), pctx = pv.getContext('2d'), stage = $('#stage');
  const zoomInput = $('#zoomInput'), zoomOut = $('#zoomOut');
  const pasteBtn = $('#pasteBtn'), pasteManyBtn = $('#pasteManyBtn');

  // ---- textos ----
  const T = window.createMosaicoText({
    S, ASPECT, frame, clamp, rad, snapRot, normRot, uid, toast: (...a) => toast(...a), DB, onDoubleTap,
    saveItem: it => saveItem(it), requestRender: () => requestRender(),
    redrawAll: () => { for (const it of S.items.values()) drawThumb(it); requestRender(); },
    kickSync: () => Sync && Sync.kick(), trashFile: id => Sync && Sync.trashFile(id),
    startSelect: mode => startSelect(mode),
    loadImage: b => loadImage(b), prepLayerImage: f => prepLayerImage(f),
    fetchFile: id => (Sync ? Sync.fetchFile(id) : Promise.reject(new Error('la imagen está en la nube y no hay conexión'))),
  });
  // Imagen para una capa: se achica a 2160 px como mucho y conserva la transparencia (PNG).
  async function prepLayerImage(f) {
    if (isVideoFile(f)) throw new Error('los videos no pueden ser capas');
    let src = f, img;
    try { img = await loadImage(f); }
    catch (e) { if (!isHeic(f)) throw e; toast('Convirtiendo foto HEIC…', true); src = await heicToJpeg(f); img = await loadImage(src); }
    let w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
    const type = src.type || '';
    const alpha = !/jpe?g|hei[cf]/i.test(type);
    if (Math.max(w, h) > 2160 || /svg/i.test(type) || !/^image\/(png|jpe?g|webp)$/i.test(type)) {
      const k = Math.min(1, 2160 / Math.max(w, h));
      const c = canvas(Math.round(w * k), Math.round(h * k));
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
      const blob = await toBlob(c, alpha ? 'image/png' : 'image/jpeg', 0.92);
      w = c.width; h = c.height; c.width = 0;
      return { blob, w, h };
    }
    return { blob: new Blob([await src.arrayBuffer()], { type }), w, h };
  }

  let toastTimer;
  function toast(msg, sticky = false, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ================= Carruseles =================
  // Cada diapositiva es una publicación más (con su foto, color y capas). La primera manda: es la que
  // ocupa el lugar en la grilla y guarda el orden de las demás (slides); las otras apuntan a ella (parent).
  const CAROUSEL_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 19.5v.5a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1h.5"/></svg>';
  const isChild = it => !!(it && it.parent && it.parent !== it.id && S.items.has(it.parent) && !S.items.get(it.parent).parent);
  const leaderOf = it => (isChild(it) ? S.items.get(it.parent) : it);
  function slidesOf(lead) {
    if (!lead || isChild(lead)) return lead ? [lead] : [];
    const kids = [];
    for (const x of S.items.values()) if (x.parent === lead.id && x !== lead) kids.push(x);
    if (!kids.length) return [lead];
    const ord = (lead.slides || []).filter(id => kids.some(k => k.id === id));
    for (const k of kids) if (!ord.includes(k.id)) ord.push(k.id);
    return [lead, ...ord.map(id => S.items.get(id))];
  }
  // En la grilla van sólo las primeras diapositivas (y cualquier publicación que haya quedado suelta).
  function normalizeOrder() {
    const seen = new Set();
    S.order = S.order.filter(id => { const it = S.items.get(id); if (!it || isChild(it) || seen.has(id)) return false; seen.add(id); return true; });
    for (const it of S.items.values()) if (!isChild(it) && !seen.has(it.id)) { S.order.push(it.id); seen.add(it.id); }
  }
  // Deja el carrusel con estas diapositivas, en este orden, en el lugar que ocupaba oldLeadId.
  function setSlides(ids, oldLeadId) {
    const items = ids.map(id => S.items.get(id)).filter(Boolean);
    if (!items.length) return null;
    const lead = items[0], touched = new Set();
    const setF = (it, k, v) => {
      if (JSON.stringify(it[k]) === JSON.stringify(v)) return;
      if (v === undefined) delete it[k]; else it[k] = v;
      touched.add(it);
    };
    setF(lead, 'parent', undefined);
    setF(lead, 'slides', items.length > 1 ? items.slice(1).map(x => x.id) : undefined);
    for (const it of items.slice(1)) { setF(it, 'parent', lead.id); setF(it, 'slides', undefined); }
    const gone = new Set([...items.map(x => x.id), oldLeadId]);
    let pos = 0;
    for (const id of S.order) { if (id === oldLeadId) break; if (!gone.has(id)) pos++; }
    if (!S.order.includes(oldLeadId)) pos = 0;
    S.order = S.order.filter(id => !gone.has(id));
    S.order.splice(pos, 0, lead.id);
    touched.forEach(saveItem);
    saveOrder();
    return lead;
  }

  // ================= Grilla =================
  function cellFor(it) {
    if (!it.cell) {
      const d = document.createElement('div');
      d.className = 'cell'; d.dataset.id = it.id;
      const c = document.createElement('canvas');
      const chk = document.createElement('span'); chk.className = 'check';
      d.append(c, chk);
      if (it.kind === 'video') {
        const vb = document.createElement('span'); vb.className = 'vbadge'; vb.textContent = '▶';
        d.append(vb);
      }
      const cb = document.createElement('span'); cb.className = 'cbadge'; cb.innerHTML = CAROUSEL_ICON;
      d.append(cb);
      d.addEventListener('click', () => onCellClick(it));
      it.canvas = c; it.cell = d;
    }
    it.cell.classList.toggle('current', !!S.current && leaderOf(S.current) === it);
    it.cell.classList.toggle('carousel', slidesOf(it).length > 1);
    it.cell.classList.toggle('selected', S.selected.has(it.id));
    return it.cell;
  }
  // Si el video de esta publicación está abierto, se dibuja directo desde el video.
  function videoSource(it) {
    if (S.video && S.video.id === it.id && S.video.v.videoWidth) {
      const v = S.video.v;
      return { img: v, w: v.videoWidth, h: v.videoHeight };
    }
    return null;
  }
  function drawThumb(it) {
    if (!it.thumb || !R || (!it.canvas && !it.stripCanvas)) return;
    if (!it.canvas) it.canvas = canvas(1, 1);   // diapositiva de un carrusel: sólo se ve en la tira
    const cw = 360, ch = Math.round(cw / S.gridAspect);
    const vs = videoSource(it);
    const src = vs || { img: it.thumb, w: it.thumb.naturalWidth, h: it.thumb.naturalHeight };
    const adj = S.showOriginalGrid ? null : it.adj;
    const out = it === S.current ? renderBase('thumb', it, src, adj, cw, ch, S.gridAspect) : R.render(src.img, src.w, src.h, it.crop, adj, cw, ch, S.gridAspect);
    const c = it.canvas;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const cx = c.getContext('2d');
    cx.drawImage(out, 0, 0);
    T.draw(cx, it, cw, ch);
    const sc = it.stripCanvas;
    if (sc) {
      const sw = 96, sh = Math.round(sw / S.gridAspect);
      if (sc.width !== sw || sc.height !== sh) { sc.width = sw; sc.height = sh; }
      const sx = sc.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, sw, sh);
    }
  }
  function renderGrid() {
    normalizeOrder();
    gridEl.classList.toggle('a45', S.gridAspect === ASPECT);
    gridEl.replaceChildren(...S.order.map(id => cellFor(S.items.get(id))));
    emptyEl.hidden = S.order.length > 0;
    const n = S.order.length;
    countEl.textContent = (n ? `${n} ${n === 1 ? 'publicación' : 'publicaciones'} · ` : '') + VERSION;
    $('#downloadAll').disabled = !n;
    S.order.forEach(id => drawThumb(S.items.get(id)));
    updateTitle();
  }
  function onCellClick(it) {
    if (S.selecting && S.pasteMode === 'carousel' && S.selectFor === it) { toast('Ese es el carrusel que estás armando'); return; }
    if (S.selecting) {
      S.selected.has(it.id) ? S.selected.delete(it.id) : S.selected.add(it.id);
      it.cell.classList.toggle('selected', S.selected.has(it.id));
      updateSelectBar();
      return;
    }
    openEditor(it.id);
  }

  const sortable = window.Sortable ? Sortable.create(gridEl, {
    animation: 160, delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6,
    onStart() { S.dragging = true; },
    onEnd() {
      S.dragging = false;
      S.order = [...gridEl.children].map(c => c.dataset.id);
      saveOrder(); updateTitle();
    },
  }) : null;

  $('#viewToggle').addEventListener('click', e => {
    S.gridAspect = S.gridAspect === GRID_ASPECT ? ASPECT : GRID_ASPECT;
    e.currentTarget.textContent = S.gridAspect === GRID_ASPECT ? '3:4' : '4:5';
    try { localStorage.setItem('mosaico.gridAspect', S.gridAspect === ASPECT ? '45' : '34'); } catch { }
    renderGrid();
  });
  $('#origToggle').addEventListener('click', e => {
    S.showOriginalGrid = !S.showOriginalGrid;
    e.currentTarget.classList.toggle('on', S.showOriginalGrid);
    S.order.forEach(id => drawThumb(S.items.get(id)));
  });

  // ================= Importar =================
  $('#fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });

  async function importFiles(fileList, opts = {}) {
    const all = [...fileList];
    const files = all.filter(f => f.type.startsWith('image/') || isVideoFile(f) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (!files.length) {
      if (all.length) toast(`Formato no reconocido: ${all.map(f => `${f.name} (${f.type || 'sin tipo'})`).join(', ')}`, false, 10000);
      return;
    }
    const newIds = [], errors = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      toast(`Importando ${i + 1} de ${files.length}…`, true);
      if (isVideoFile(f)) {
        let v;
        try {
          const vblob = f.slice(0, f.size, f.type || 'video/quicktime');
          v = await openVideo(vblob);
          const t = Math.min(0.5, (v.duration || 0) / 2);
          await seekVideo(v, t);
          const fr = await grabFrame(v);
          const id = uid();
          const it = { id, name: f.name || 'video.mov', w: fr.w, h: fr.h, crop: { z: 1, cx: 0.5, cy: 0.5, rot: 0 }, adj: zeroAdj(), kind: 'video', duration: v.duration, t };
          await DB.put('videos', { id, video: vblob });
          await DB.put('blobs', { id, orig: fr.orig, thumb: fr.thumb });
          await DB.put('items', meta(it));
          it.thumb = await loadImage(fr.thumb);
          S.items.set(id, it); newIds.push(id);
        } catch (e) { console.error(e); errors.push(`${f.name}: ${e && e.message || e}`); }
        closeVideo(v);
        continue;
      }
      try {
        const { orig, thumbBlob, w, h } = await readImageFile(f, `Convirtiendo foto HEIC ${i + 1} de ${files.length}…`);
        const id = uid();
        const it = { id, name: f.name || 'foto.jpg', w, h, crop: { z: 1, cx: 0.5, cy: 0.5, rot: 0 }, adj: zeroAdj() };
        await DB.put('blobs', { id, orig, thumb: thumbBlob });
        await DB.put('items', meta(it));
        it.thumb = await loadImage(thumbBlob);
        S.items.set(id, it); newIds.push(id);
      } catch (e) {
        console.error(e); errors.push(`${f.name}: ${e && e.message || e}`);
      }
    }
    const into = opts.into && S.items.get(opts.into.id);
    if (into && newIds.length) {
      setSlides([...slidesOf(into).map(x => x.id), ...newIds], into.id);
    } else S.order = [...newIds, ...S.order];
    saveOrder(); renderGrid();
    if (into) {
      const n = slidesOf(leaderOf(into)).length;
      toast(errors.length ? `Se sumaron ${newIds.length}. No se pudo leer: ${errors.join(' · ')}` : `Carrusel: ${n} diapositivas${n > 20 ? ' (Instagram admite hasta 20)' : ''}`, false, errors.length ? 12000 : 3000);
      if (newIds.length) openEditor(newIds[0]);
      return;
    }
    if (errors.length) {
      toast(`Se agregaron ${newIds.length}. No se pudo leer: ${errors.join(' · ')}`, false, 12000);
    } else {
      toast(`Se ${newIds.length === 1 ? 'agregó 1 archivo' : 'agregaron ' + newIds.length + ' archivos'}`);
    }
    if (newIds.length && !isNarrow()) openEditor(newIds[0]);
  }

  async function readImageFile(f, heicMsg) {
    let src = f, img;
    try { img = await loadImage(f); }
    catch (e) {
      if (!isHeic(f)) throw e;
      toast(heicMsg || 'Convirtiendo foto HEIC…', true);
      src = await heicToJpeg(f);
      img = await loadImage(src);
    }
    let w = img.naturalWidth, h = img.naturalHeight;
    let orig = new Blob([await src.arrayBuffer()], { type: src.type || 'image/jpeg' });
    if (Math.max(w, h) > MAX_SRC) {
      const c = downscale(img, w, h, MAX_SRC);
      orig = await toBlob(c, 'image/jpeg', 0.95);
      w = c.width; h = c.height; c.width = 0;
    }
    const tc = downscale(img, img.naturalWidth, img.naturalHeight, THUMB_SRC);
    const thumbBlob = await toBlob(tc, 'image/jpeg', 0.9); tc.width = 0;
    return { orig, thumbBlob, w, h };
  }

  // ---- publicación vacía ----
  async function createBlank(opts = {}) {
    const id = uid();
    const into = opts.into && S.items.get(opts.into.id);
    const bg = into && into.kind === 'blank' ? into.bg : BLANK_BG;   // en un carrusel, sigue con el mismo fondo
    const it = { id, name: 'Publicación vacía', w: 1080, h: 1350, crop: { z: 1, cx: 0.5, cy: 0.5, rot: 0 }, adj: zeroAdj(), kind: 'blank', bg, texts: [] };
    it.thumb = solidImage(it.bg);
    await DB.put('items', meta(it)).catch(reportError);
    S.items.set(id, it);
    if (into) setSlides([...slidesOf(into).map(x => x.id), id], into.id);
    else S.order.unshift(id);
    saveOrder(); renderGrid();
    await openEditor(id);
    saveItem(it);
  }
  // ---- poner o cambiar la foto de una publicación (los textos y el color quedan) ----
  const photoInput = document.createElement('input');
  photoInput.type = 'file'; photoInput.accept = 'image/*,.heic,.heif'; photoInput.hidden = true;
  document.body.append(photoInput);
  photoInput.addEventListener('change', () => {
    const f = photoInput.files[0]; photoInput.value = '';
    if (f && S.current) setPhoto(S.current, f);
  });
  async function setPhoto(it, f) {
    if (isVideoFile(f)) { toast('Un video no puede ser la foto: soltalo en “Sumar al carrusel” o usá + Agregar', false, 5000); return; }
    try {
      toast('Cargando la foto…', true);
      const { orig, thumbBlob, w, h } = await readImageFile(f);
      await DB.put('blobs', { id: it.id, orig, thumb: thumbBlob });
      Object.assign(it, { kind: 'image', w, h, name: f.name || 'foto.jpg', crop: { z: 1, cx: 0.5, cy: 0.5, rot: 0 } });
      // el color de fondo queda guardado debajo: con "Quitar foto" vuelve
      if (it.sync && it.sync.media && it.sync.media.orig) it.sync.mediaDirty = true;   // ya había foto en la nube: se reemplaza
      it.thumb = await loadImage(thumbBlob);
      S.full = null;
      saveItem(it);
      await openEditor(it.id);
      drawThumb(it);
      toast('Foto lista');
    } catch (e) { console.error(e); toast('No se pudo leer la foto: ' + (e.message || e), false, 7000); }
  }
  $('#photoBtn').addEventListener('click', () => photoInput.click());
  // ---- quitar la foto de fondo: vuelve el fondo de color (las capas y el color quedan) ----
  async function removePhoto(it) {
    if (!it || it.kind !== 'image') return;
    if (!confirm('¿Quitar la foto de fondo? Vuelve el fondo de color; los textos y las imágenes de las capas quedan.')) return;
    it.kind = 'blank'; it.bg = it.bg || BLANK_BG; it.w = 1080; it.h = 1350;
    it.crop = { z: 1, cx: 0.5, cy: 0.5, rot: 0 };
    it.thumb = solidImage(it.bg);
    S.full = null;
    await DB.run(['blobs'], 'readwrite', t => { t.objectStore('blobs').delete(it.id); }).catch(reportError);
    saveItem(it);
    await openEditor(it.id);
    drawThumb(it);
    toast('Listo: fondo de color. Elegí el color abajo, en Fondo');
  }
  $('#removePhotoBtn').addEventListener('click', () => removePhoto(S.current));

  // ---- fondo de la publicación vacía ----
  const BG_BASE = ['#ffffff', BLANK_BG, '#d9cbb8', '#2b2a28', '#000000'];
  const bgColorsEl = $('#bgColors');
  function setBlankBg(it, c) {
    it.bg = c; it.thumb = solidImage(c);
    if (S.current === it) S.full = { id: it.id, img: it.thumb, w: 40, h: 50 };
    requestRender(); saveItem(it);
  }
  const bgPicker = T.colorPicker({
    target: () => S.current && S.current.kind === 'blank' ? S.current : null,
    get: it => it.bg || BLANK_BG,
    set: (it, c) => setBlankBg(it, c),
    onChange: () => { },
    commit: c => { T.addToPalette(c); renderBgSwatches(); },
  });
  bgColorsEl.after(bgPicker.el);
  function renderBgSwatches() {
    const it = S.current; if (!it || it.kind !== 'blank') return;
    const now = (it.bg || BLANK_BG).toLowerCase();
    const list = [...new Set([...BG_BASE, ...T.palette()])];
    bgColorsEl.innerHTML = list.map(c => `<button class="sw${c === now ? ' on' : ''}" data-c="${c}" style="--c:${c}" title="${c}"></button>`).join('')
      + `<button class="sw pick" title="Elegir otro color (arrastrá para ver en vivo)"></button>`;
  }
  bgColorsEl.addEventListener('click', e => {
    const b = e.target.closest('button.sw'), it = S.current; if (!b || !it || it.kind !== 'blank') return;
    if (b.classList.contains('pick')) { bgPicker.toggle(); return; }
    setBlankBg(it, b.dataset.c); renderBgSwatches(); bgPicker.refresh();
  });

  // ---- menú + Agregar ----
  $('#addBtn').addEventListener('click', () => { $('#addSheet').hidden = false; });
  $('#addSheet').addEventListener('click', e => {
    const b = e.target.closest('button'), sh = $('#addSheet');
    if (!b && e.target !== sh) return;
    sh.hidden = true;
    if (!b) return;
    if (b.dataset.add === 'files') $('#fileInput').click();
    else if (b.dataset.add === 'blank') createBlank();
  });

  // arrastrar archivos desde la compu
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  // Con una publicación abierta, el editor muestra dos zonas: poner como foto o sumar al carrusel.
  // Soltar en la grilla (o en cualquier otro lado) crea publicaciones nuevas, como siempre.
  const dropZones = $('#dropZones');
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    const z = e.target.closest && e.target.closest('[data-drop]');
    dropZones.querySelectorAll('.dz').forEach(d => d.classList.toggle('hot', d === z));
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
    const files = [...e.dataTransfer.files];
    const z = e.target.closest && e.target.closest('[data-drop]');
    dropZones.querySelectorAll('.dz').forEach(d => d.classList.remove('hot'));
    const it = S.current;
    if (z && it) {
      if (z.dataset.drop === 'layer') {
        const imgsF = files.filter(x => !isVideoFile(x));
        if (!imgsF.length) { toast('Los videos no pueden ser capas: soltalos en “Sumar al carrusel”', false, 5000); return; }
        T.addImageFiles(imgsF, it);
      } else if (z.dataset.drop === 'photo') {
        const f = files.find(x => !isVideoFile(x)) || files[0];
        if (files.length > 1) toast('Se usa la primera foto; para sumar varias, soltalas en “Sumar al carrusel”', false, 5000);
        setPhoto(it, f);
      } else importFiles(files, { into: leaderOf(it) });
      return;
    }
    importFiles(files);
  });

  // ================= Archivos pesados (locales o desde la nube) =================
  async function getOrigBlob(it) {
    const b = await DB.get('blobs', it.id);
    if (b && b.orig) return b.orig;
    if (!Sync) throw new Error('falta el archivo original');
    toast('Bajando el original de la nube…', true);
    const blob = await Sync.fetchMedia(it, 'orig');
    await DB.put('blobs', { id: it.id, orig: blob, thumb: b ? b.thumb : blob });
    toast('Original listo');
    return blob;
  }
  async function getVideoBlob(it) {
    let rec = await DB.get('videos', it.id);
    if (!rec) {
      // videos subidos con una versión anterior: mover el video a su lugar nuevo (una sola vez)
      const old = await DB.get('blobs', it.id);
      if (old && old.video) {
        rec = { id: it.id, video: old.video };
        await DB.put('videos', rec);
        await DB.put('blobs', { id: it.id, orig: old.orig, thumb: old.thumb });
      }
    }
    if (rec) return rec.video;
    if (!Sync) return null;
    toast('Bajando el video de la nube (puede tardar)…', true);
    const v = await Sync.fetchMedia(it, 'video');
    await DB.put('videos', { id: it.id, video: v });
    toast('Video listo');
    return v;
  }

  // ================= Editor =================
  async function openEditor(id) {
    const it = S.items.get(id);
    if (!it) return;
    // si veníamos de un video con un fotograma sin guardar, guardarlo antes de soltarlo
    if (S.video && S.video.id !== id) {
      const prev = S.video; S.video = null;
      flushFrame(prev).finally(() => closeVideo(prev.v));
    }
    for (const x of S.items.values()) if (x.cell) x.cell.classList.remove('current');
    if (S.current !== it) T.onItemChanged();
    S.current = it;
    T.renderLayers();
    const lead = leaderOf(it);
    lead.cell && lead.cell.classList.add('current');
    renderStrip();
    document.body.classList.add('has-current', 'editing');
    syncControls(); updateTitle(); fitFrame(); requestRender();
    const isVid = it.kind === 'video';
    $('#frameRow').hidden = !isVid;
    if (isVid) {
      frameInput.value = it.duration ? Math.round((it.t || 0) / it.duration * 1000) : 0;
      frameOut.textContent = fmtTime(it.t || 0);
    }
    const blank = it.kind === 'blank';
    document.body.classList.toggle('is-blank', blank);
    $('#photoBtn').hidden = isVid;
    $('#photoBtn').textContent = blank ? '+ Poner foto' : 'Cambiar foto';
    $('#removePhotoBtn').hidden = it.kind !== 'image';
    if (blank) {
      S.full = { id, img: it.thumb, w: 40, h: 50 };
      renderBgSwatches(); bgPicker.refresh();
      requestRender();
      return;
    }
    try {
      if (!S.full || S.full.id !== id) {
        S.full = null;
        const orig = await getOrigBlob(it);
        if (S.current !== it) return;
        const img = await loadImage(orig);
        if (S.current !== it) return;
        S.full = { id, img, w: img.naturalWidth, h: img.naturalHeight };
        requestRender();
      }
      if (isVid && !S.video) {
        const vblob = await getVideoBlob(it);
        if (S.current !== it || !vblob) return;
        const v = await openVideo(vblob);
        if (S.current !== it) { closeVideo(v); return; }
        await seekVideo(v, it.t || 0);
        if (S.current !== it) { closeVideo(v); return; }
        S.video = { id, v, it, dirty: false };
        requestRender();
      }
    } catch (e) { console.error(e); toast((isVid ? 'No se pudo abrir el video: ' : 'No se pudo abrir el original: ') + (e.message || e), false, 8000); }
  }

  // ---- elegir fotograma de portada ----
  // Mientras el video está abierto, la vista y la miniatura salen directo del video.
  // El fotograma se guarda (liviano, sin tocar el video) cuando dejás de mover la barra.
  const frameInput = $('#frameInput'), frameOut = $('#frameOut');
  let seeking = false, pendingT = null, commitTimer, frameGen = 0;
  async function scrubTo(t) {
    pendingT = t;
    if (seeking) return;
    seeking = true;
    try {
      while (pendingT !== null && S.video) {
        const tt = pendingT; pendingT = null;
        await seekVideo(S.video.v, tt);
        requestRender();
      }
    } finally { seeking = false; }
  }
  function setFrameTime(t) {
    const it = S.current;
    if (!it || it.kind !== 'video' || !S.video || S.video.id !== it.id) return;
    it.t = clamp(t, 0, it.duration || 0);
    frameInput.value = it.duration ? Math.round(it.t / it.duration * 1000) : 0;
    frameOut.textContent = fmtTime(it.t);
    frameGen++;
    S.video.dirty = true;
    saveItem(it);
    scrubTo(it.t);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => commitFrame(S.video), 1200);
  }
  async function commitFrame(vs) {
    if (!vs || !vs.dirty) return;
    const gen = frameGen;
    while (seeking && S.video === vs) await new Promise(r => setTimeout(r, 50));
    if (gen !== frameGen && S.video === vs) return;     // se volvió a mover la barra: esperar al próximo
    try {
      const fr = await grabFrame(vs.v);
      if (gen !== frameGen && S.video === vs) return;
      await DB.put('blobs', { id: vs.id, orig: fr.orig, thumb: fr.thumb });
      vs.dirty = false;
      if (vs.it.sync) vs.it.sync.mediaDirty = true;
      saveItem(vs.it);
      vs.it.thumb = await loadImage(fr.thumb);
      const img = await loadImage(fr.orig);
      if (S.full && S.full.id === vs.id) S.full = { id: vs.id, img, w: img.naturalWidth, h: img.naturalHeight };
      if (S.video !== vs) drawThumb(vs.it);
    } catch (e) { console.error(e); }
  }
  function flushFrame(vs) {
    clearTimeout(commitTimer);
    return commitFrame(vs);
  }
  frameInput.addEventListener('input', () => {
    const it = S.current; if (!it) return;
    setFrameTime(frameInput.value / 1000 * (it.duration || 0));
  });
  $('#framePrev').addEventListener('click', () => S.current && setFrameTime((S.current.t || 0) - 1 / 30));
  $('#frameNext').addEventListener('click', () => S.current && setFrameTime((S.current.t || 0) + 1 / 30));
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.video) flushFrame(S.video); });
  function closeEditorMobile() { document.body.classList.remove('editing'); }
  $('#backBtn').addEventListener('click', closeEditorMobile);

  function updateTitle() {
    const it = S.current;
    if (!it) { $('#editorTitle').textContent = ''; return; }
    const lead = leaderOf(it), list = slidesOf(lead);
    $('#editorTitle').textContent = `Publicación ${S.order.indexOf(lead.id) + 1} de ${S.order.length}`
      + (list.length > 1 ? ` · diapositiva ${list.indexOf(it) + 1} de ${list.length}` : '')
      + (it.kind === 'video' ? ' · portada de video' : '');
  }

  function fitFrame() {
    const cs = getComputedStyle(stage);
    const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    const fw = Math.floor(Math.min(aw, ah * ASPECT));
    frame.style.width = fw + 'px';
    frame.style.height = Math.round(fw / ASPECT) + 'px';
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(Math.min(fw * dpr, OUT_W));
    pv.width = bw; pv.height = Math.round(bw / ASPECT);
    requestRender();
  }
  new ResizeObserver(fitFrame).observe(stage);

  let raf = 0;
  function requestRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      drawPreview();
      if (S.current) drawThumb(S.current);
    });
  }
  function source(it) {
    const vs = videoSource(it);
    if (vs) return vs;
    if (S.full && S.full.id === it.id) return S.full;
    return { img: it.thumb, w: it.thumb.naturalWidth, h: it.thumb.naturalHeight, light: true };
  }
  // La foto ya coloreada queda guardada: si sólo cambian las capas (mover un texto), no se vuelve a procesar.
  const baseCache = new Map();
  function renderBase(slot, it, s, adj, ow, oh, aspect) {
    const isVid = typeof HTMLVideoElement !== 'undefined' && s.img instanceof HTMLVideoElement;
    const key = isVid ? null : [it.id, ow, oh, aspect, JSON.stringify(it.crop), adj ? JSON.stringify(adj) : '-', s.w, s.h].join('|');
    let e = baseCache.get(slot);
    if (key && e && e.key === key && e.img === s.img) return e.c;
    const out = R.render(s.img, s.w, s.h, it.crop, adj, ow, oh, aspect);
    if (!e) { e = { c: canvas(ow, oh) }; baseCache.set(slot, e); }
    if (e.c.width !== ow || e.c.height !== oh) { e.c.width = ow; e.c.height = oh; }
    e.c.getContext('2d').drawImage(out, 0, 0);
    e.key = key; e.img = s.img;
    return e.c;
  }
  function drawPreview() {
    const it = S.current;
    if (!it || !it.thumb || !R) return;
    const s = source(it);
    const out = renderBase('preview', it, s, S.holdBefore ? null : it.adj, pv.width, pv.height, ASPECT);
    pctx.drawImage(out, 0, 0);
    T.draw(pctx, it, pv.width, pv.height);
    T.afterPreview();
    const fw = baseF(it.w, it.h, it.crop.rot) / it.crop.z;
    $('#lowres').hidden = fw >= OUT_W * 0.75;
  }

  // ---- mover, hacer zoom y girar el recorte ----
  // Convierte un punto de la pantalla (relativo al marco) a píxeles de la imagen.
  function screenToImage(px, py, rect, crop, w, h) {
    const { fh } = frameSize(w, h, crop);
    const s = fh / rect.height, a = rad(crop.rot || 0), c = Math.cos(a), si = Math.sin(a);
    const dx = (px - rect.width / 2) * s, dy = (py - rect.height / 2) * s;
    return { x: crop.cx * w + c * dx + si * dy, y: crop.cy * h - si * dx + c * dy };
  }
  // Cambia zoom/giro manteniendo fijo el punto de la foto que está bajo los dedos (px, py).
  function anchored(px, py, rect, mutate) {
    const it = S.current, c = it.crop;
    const P = screenToImage(px, py, rect, c, it.w, it.h);
    mutate(c);
    c.rot = normRot(c.rot || 0);
    c.z = clamp(c.z, 1, MAX_ZOOM);
    const { fh } = frameSize(it.w, it.h, c);
    const s = fh / rect.height, a = rad(c.rot), co = Math.cos(a), si = Math.sin(a);
    const dx = (px - rect.width / 2) * s, dy = (py - rect.height / 2) * s;
    c.cx = (P.x - (co * dx + si * dy)) / it.w;
    c.cy = (P.y - (-si * dx + co * dy)) / it.h;
    clampCrop(it);
  }
  function panBy(dx, dy, rect) {
    const it = S.current, c = it.crop;
    const { fh } = frameSize(it.w, it.h, c);
    const s = fh / rect.height, a = rad(c.rot || 0), co = Math.cos(a), si = Math.sin(a);
    c.cx -= (co * dx + si * dy) * s / it.w;
    c.cy -= (-si * dx + co * dy) * s / it.h;
    clampCrop(it);
  }
  const zoomAt = (px, py, factor, rect) => anchored(px, py, rect, c => { c.z *= factor; });
  const rotateTo = (px, py, rot, rect) => anchored(px, py, rect, c => { c.rot = rot; });
  function cropChanged() { syncCropUI(); requestRender(); saveItem(S.current); }

  // Giro con gesto: hay que girar más de unos grados para que empiece (así el zoom no gira sin querer),
  // y se "imanta" a 0°, 90°, 180°…
  const ROT_START = 5;
  function makeTwist() { return { acc: 0, on: false, start: S.current.crop.rot || 0 }; }
  function twistBy(tw, d, px, py, rect) {
    tw.acc += d;
    if (!tw.on && Math.abs(tw.acc) < ROT_START) return;
    tw.on = true;
    // una vez activado, la foto sigue exactamente el giro de los dedos desde que empezó el gesto
    rotateTo(px, py, snapRot(tw.start + tw.acc), rect);
  }

  const ptrs = new Map();
  let twist = null;
  function gesturePoint() {
    const ps = [...ptrs.values()];
    const x = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const y = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    const two = ps.length >= 2;
    const d = two ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
    const ang = two ? Math.atan2(ps[1].y - ps[0].y, ps[1].x - ps[0].x) * 180 / Math.PI : 0;
    return { x, y, d, ang };
  }
  frame.addEventListener('pointerdown', e => {
    if (!S.current) return;
    if (T.pointerDown(e, ptrs.size > 0)) return;
    try { frame.setPointerCapture(e.pointerId); } catch { }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) twist = makeTwist();
    frame.classList.add('dragging');
  });
  frame.addEventListener('pointermove', e => {
    if (T.pointerMove(e)) return;
    if (!ptrs.has(e.pointerId) || !S.current) return;
    const before = gesturePoint();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = gesturePoint();
    const rect = frame.getBoundingClientRect();
    const px = after.x - rect.left, py = after.y - rect.top;
    panBy(after.x - before.x, after.y - before.y, rect);
    if (ptrs.size >= 2 && before.d > 0) {
      zoomAt(px, py, after.d / before.d, rect);
      if (twist) twistBy(twist, normRot(after.ang - before.ang), px, py, rect);
    }
    cropChanged();
  });
  const endPtr = e => {
    if (T.pointerUp(e)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) twist = null;
    if (!ptrs.size) frame.classList.remove('dragging');
  };
  frame.addEventListener('pointerup', endPtr);
  frame.addEventListener('pointercancel', endPtr);

  // Trackpad de la Mac en Safari: pellizcar y girar con dos dedos.
  let macGesture = null;
  if (!navigator.maxTouchPoints) {
    frame.addEventListener('gesturestart', e => {
      e.preventDefault();
      if (!S.current || T.macGesture('start', e)) return;
      macGesture = { scale: 1, rotation: 0, tw: makeTwist() };
      frame.classList.add('dragging');
    });
    frame.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (T.macGesture('change', e)) return;
      if (!S.current || !macGesture) return;
      const rect = frame.getBoundingClientRect();
      const px = clamp(e.clientX - rect.left, 0, rect.width), py = clamp(e.clientY - rect.top, 0, rect.height);
      zoomAt(px, py, e.scale / macGesture.scale, rect);
      macGesture.scale = e.scale;
      twistBy(macGesture.tw, e.rotation - macGesture.rotation, px, py, rect);
      macGesture.rotation = e.rotation;
      cropChanged();
    });
    frame.addEventListener('gestureend', e => {
      e.preventDefault();
      T.macGesture('end', e);
      macGesture = null;
      frame.classList.remove('dragging');
    });
  }

  frame.addEventListener('wheel', e => {
    if (!S.current || macGesture) return;
    if (T.wheel(e)) return;
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, f, rect);
    cropChanged();
  }, { passive: false });
  frame.addEventListener('dblclick', e => {
    if (!S.current || T.dblclick(e)) return;
    // recentrar y quitar el zoom (mantiene el giro de 90° si lo hay)
    S.current.crop = { z: 1, cx: 0.5, cy: 0.5, rot: base90(S.current.crop.rot || 0) };
    clampCrop(S.current);
    cropChanged();
  });
  const frameCenter = () => { const r = frame.getBoundingClientRect(); return [r.width / 2, r.height / 2, r]; };
  zoomInput.addEventListener('input', () => {
    if (!S.current) return;
    const [cx, cy, rect] = frameCenter();
    zoomAt(cx, cy, (zoomInput.value / 100) / S.current.crop.z, rect);
    cropChanged();
  });

  // ---- girar 90° y enderezar ----
  const rotInput = $('#rotInput'), rotOut = $('#rotOut');
  let gridTimer;
  function flashGrid() {
    frame.classList.add('dragging');
    clearTimeout(gridTimer);
    gridTimer = setTimeout(() => { if (!ptrs.size && !macGesture) frame.classList.remove('dragging'); }, 700);
  }
  function setRotation(rot) {
    if (!S.current) return;
    const [cx, cy, rect] = frameCenter();
    rotateTo(cx, cy, rot, rect);
    flashGrid();
    cropChanged();
  }
  rotInput.addEventListener('input', () => {
    if (!S.current) return;
    setRotation(base90(S.current.crop.rot || 0) + (+rotInput.value));
  });
  onDoubleTap($('#rotOut').closest('.slider'), () => S.current && setRotation(base90(S.current.crop.rot || 0)));
  onDoubleTap(zoomInput.closest('.slider'), () => {
    if (!S.current) return;
    const [cx, cy, rect] = frameCenter();
    zoomAt(cx, cy, 1 / S.current.crop.z, rect); cropChanged();
  });
  $('#rotL').addEventListener('click', () => S.current && setRotation((S.current.crop.rot || 0) - 90));
  $('#rotR').addEventListener('click', () => S.current && setRotation((S.current.crop.rot || 0) + 90));

  const fmtDeg = d => (Math.abs(d) < 0.05 ? '0' : (d > 0 ? '+' : '') + d.toFixed(1)) + '°';
  function syncCropUI() {
    if (!S.current) return;
    const c = S.current.crop;
    const z = Math.round(c.z * 100);
    zoomInput.value = z; zoomOut.textContent = z + '%';
    const rot = c.rot || 0, b = normRot(base90(rot)), fine = rot - base90(rot);
    rotInput.value = fine.toFixed(1);
    rotOut.textContent = fmtDeg(fine) + (b ? `  ·  girada ${b > 0 ? b : 360 + b}°` : '');
  }

  // ---- ajustes de color ----
  const sliderUI = {};
  const fmt = v => v > 0 ? '+' + v : String(v);
  for (const a of ADJ) {
    const row = document.createElement('div');
    row.className = 'slider ' + a.key;
    row.innerHTML = `<label><span>${a.label}</span><output>0</output></label>
      <input type="range" min="${a.min ?? -100}" max="100" step="1" value="0" aria-label="${a.label}">`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => {
      if (!S.current) return;
      S.current.adj[a.key] = +inp.value;
      out.textContent = fmt(+inp.value);
      requestRender(); saveItem(S.current);
    });
    const reset = () => { inp.value = 0; inp.dispatchEvent(new Event('input')); };
    onDoubleTap(row, reset);
    sliderUI[a.key] = { inp, out };
    $('#sliders').append(row);
  }
  // Botones − / + junto al número de cada ajuste, para mover de a un paso (mantener apretado repite).
  function addNudges(root) {
    root.querySelectorAll('.slider').forEach(row => {
      const inp = row.querySelector(':scope > input[type=range]'), lab = row.querySelector(':scope > label'), out = lab && lab.querySelector('output');
      if (!inp || !out) return;
      const head = document.createElement('div'); head.className = 'lbl';   // no <label>: si no, tocar el nombre apretaría el botón
      head.append(...lab.childNodes); lab.replaceWith(head);
      const wrap = document.createElement('span'); wrap.className = 'nudge';
      const mk = (d, txt) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'nb'; b.textContent = txt;
        b.setAttribute('aria-label', d > 0 ? 'Subir un paso' : 'Bajar un paso');
        let t = 0;
        const step = () => { const v = inp.value; d > 0 ? inp.stepUp() : inp.stepDown(); if (inp.value !== v) inp.dispatchEvent(new Event('input', { bubbles: true })); };
        const stopRep = () => { clearTimeout(t); t = 0; };
        b.addEventListener('pointerdown', e => {
          e.preventDefault(); step(); stopRep();
          const rep = () => { step(); t = setTimeout(rep, 55); };
          t = setTimeout(rep, 420);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stopRep));
        b.addEventListener('click', e => { if (e.detail === 0) step(); });   // teclado
        b.addEventListener('contextmenu', e => e.preventDefault());
        return b;
      };
      out.replaceWith(wrap);
      wrap.append(mk(-1, '−'), out, mk(1, '+'));
    });
  }
  addNudges($('#sliders')); addNudges($('#textPanel'));
  function syncControls() {
    const it = S.current; if (!it) return;
    for (const a of ADJ) {
      sliderUI[a.key].inp.value = it.adj[a.key];
      sliderUI[a.key].out.textContent = fmt(it.adj[a.key]);
    }
    syncCropUI();
  }

  // antes / después (mantener apretado)
  const beforeBtn = $('#beforeBtn');
  const setBefore = v => { if (S.holdBefore === v) return; S.holdBefore = v; beforeBtn.classList.toggle('on', v); requestRender(); };
  beforeBtn.addEventListener('pointerdown', e => { e.preventDefault(); setBefore(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => beforeBtn.addEventListener(t, () => setBefore(false)));
  beforeBtn.addEventListener('contextmenu', e => e.preventDefault());

  // copiar / pegar
  // Ajustes de color (filtros): se copian y pegan aparte de las capas.
  function copyAdj() {
    if (!S.current) return;
    S.clip = { ...S.current.adj };
    S.lastCopied = 'color';
    pasteBtn.disabled = pasteManyBtn.disabled = false;
    toast('Ajustes de color copiados');
  }
  function pasteAdj() {
    if (!S.current || !S.clip) return;
    S.current.adj = { ...S.clip };
    syncControls(); requestRender(); saveItem(S.current);
    toast('Ajustes de color pegados');
  }
  $('#copyBtn').addEventListener('click', copyAdj);
  pasteBtn.addEventListener('click', pasteAdj);
  $('#resetBtn').addEventListener('click', () => {
    if (!S.current) return;
    S.current.adj = zeroAdj();
    S.current.crop = { z: 1, cx: 0.5, cy: 0.5, rot: 0 };
    syncControls(); requestRender(); saveItem(S.current);
  });

  // pegar en varias
  // "Pegar en…": elegir publicaciones de la grilla para pegar el color o la capa copiada.
  function startSelect(mode = 'color') {
    if (mode === 'color' ? !S.clip : mode === 'layer' ? !T.hasLayerClip() : !S.current) return;
    S.pasteMode = mode;
    S.selectFor = mode === 'carousel' ? leaderOf(S.current) : null;
    $('#selectApply').textContent = mode === 'layer' ? 'Pegar capa' : mode === 'carousel' ? 'Sumar al carrusel' : 'Pegar color';
    S.selecting = true; S.selected.clear();
    document.body.classList.add('selecting');
    closeEditorMobile();
    $('#selectBar').hidden = false;
    sortable && sortable.option('disabled', true);
    S.order.forEach(id => S.items.get(id).cell.classList.remove('selected'));
    updateSelectBar();
  }
  function endSelect() {
    S.selecting = false; S.selected.clear();
    document.body.classList.remove('selecting');
    $('#selectBar').hidden = true;
    sortable && sortable.option('disabled', false);
    S.order.forEach(id => S.items.get(id).cell.classList.remove('selected'));
  }
  function updateSelectBar() {
    const n = S.selected.size;
    $('#selectCount').textContent = n ? `${n} seleccionada${n > 1 ? 's' : ''}` : S.pasteMode === 'carousel' ? 'Tocá las publicaciones a sumar' : 'Tocá las fotos';
    $('#selectApply').disabled = !n;
  }
  pasteManyBtn.addEventListener('click', () => startSelect('color'));
  $('#selectCancel').addEventListener('click', endSelect);
  $('#selectAll').addEventListener('click', () => {
    S.order.forEach(id => { if (S.pasteMode === 'carousel' && S.selectFor && id === S.selectFor.id) return; S.selected.add(id); S.items.get(id).cell.classList.add('selected'); });
    updateSelectBar();
  });
  $('#selectApply').addEventListener('click', () => {
    const n = S.selected.size;
    if (S.pasteMode === 'carousel') {
      const lead = S.selectFor && S.items.get(S.selectFor.id);
      if (!lead) { endSelect(); return; }
      const add = S.order.filter(id => S.selected.has(id) && id !== lead.id).flatMap(id => slidesOf(S.items.get(id)).map(x => x.id));
      const ids = [...slidesOf(lead).map(x => x.id), ...add];
      endSelect();
      setSlides(ids, lead.id); renderGrid();
      openEditor(S.items.get(add[0]) ? add[0] : lead.id);
      toast(`Carrusel: ${ids.length} diapositivas${ids.length > 20 ? ' (Instagram admite hasta 20)' : ''}`);
      return;
    }
    for (const id of S.selected) {
      const it = S.items.get(id);
      if (S.pasteMode === 'layer') T.pasteLayerInto(it);   // se suma arriba de las capas que ya tiene
      else it.adj = { ...S.clip };
      drawThumb(it); saveItem(it);
    }
    endSelect(); syncControls(); requestRender(); T.renderLayers();
    toast(`${S.pasteMode === 'layer' ? 'Capa pegada' : 'Color pegado'} en ${n} publicaci${n > 1 ? 'ones' : 'ón'}`);
  });

  // eliminar
  $('#deleteBtn').addEventListener('click', async () => {
    const it = S.current; if (!it) return;
    const lead = leaderOf(it), list = slidesOf(lead).map(x => x.id);
    if (list.length > 1) {   // diapositiva de un carrusel: sólo se va esa
      if (!confirm('¿Quitar esta diapositiva del carrusel? (Las demás quedan. El archivo original de tu equipo no se toca.)')) return;
      const k = list.indexOf(it.id), rest = list.filter(id => id !== it.id);
      setSlides(rest, lead.id);
      await dropItem(it);
      renderGrid(); openEditor(rest[Math.min(k, rest.length - 1)]);
      return;
    }
    if (!confirm('¿Sacar esta foto de la grilla? (El archivo original de tu equipo no se toca.)')) return;
    const idx = S.order.indexOf(it.id);
    S.order.splice(idx, 1); S.items.delete(it.id);
    if (S.full && S.full.id === it.id) S.full = null;
    if (S.video && S.video.id === it.id) { clearTimeout(commitTimer); closeVideo(S.video.v); S.video = null; }
    S.current = null;
    document.body.classList.remove('has-current');
    await DB.remove(it.id).catch(reportError);
    S.deleted.add(it.id);
    if (Sync) Sync.trashItem(it);
    saveOrder(); renderGrid();
    const next = S.order[Math.min(idx, S.order.length - 1)];
    if (next && !isNarrow()) openEditor(next); else closeEditorMobile();
  });

  async function dropItem(it) {
    S.items.delete(it.id);
    S.order = S.order.filter(id => id !== it.id);
    if (S.full && S.full.id === it.id) S.full = null;
    if (S.video && S.video.id === it.id) { clearTimeout(commitTimer); closeVideo(S.video.v); S.video = null; }
    if (S.current === it) S.current = null;
    await DB.remove(it.id).catch(reportError);
    S.deleted.add(it.id);
    if (Sync) Sync.trashItem(it);
    saveOrder();
  }

  // ---- tira del carrusel (en el editor) ----
  const stripEl = $('#slideStrip');
  let stripSortable = null;
  function renderStrip() {
    const it = S.current;
    if (!it) { stripEl.hidden = true; return; }
    const lead = leaderOf(it), list = slidesOf(lead), multi = list.length > 1;
    stripEl.hidden = false;
    stripEl.classList.toggle('multi', multi);
    const head = document.createElement('div'); head.className = 'sl-head';
    head.innerHTML = `<span class="sl-title">${CAROUSEL_ICON}${multi ? `Carrusel · ${list.indexOf(it) + 1} de ${list.length}` : 'Carrusel'}</span>`
      + (multi ? `<button class="chip" data-sl="detach" title="Sacar esta diapositiva del carrusel y dejarla como publicación aparte">Separar</button>` : '')
      + `<button class="chip" data-sl="add" title="Sumar diapositivas: fotos, videos, una vacía o publicaciones de la grilla">+ Diapositiva</button>`;
    const nodes = [head];
    if (multi) {
      const ul = document.createElement('div'); ul.className = 'sl-list';
      list.forEach((x, i) => {
        const th = document.createElement('button'); th.className = 'sl-th' + (x === it ? ' on' : ''); th.dataset.id = x.id;
        th.title = `Diapositiva ${i + 1}`;
        if (!x.stripCanvas) { x.stripCanvas = canvas(96, 120); drawThumb(x); }
        const num = document.createElement('span'); num.className = 'sl-n'; num.textContent = i + 1;
        th.append(x.stripCanvas, num);
        if (x.kind === 'video') { const v = document.createElement('span'); v.className = 'sl-v'; v.textContent = '▶'; th.append(v); }
        ul.append(th);
      });
      nodes.push(ul);
      if (window.Sortable) {
        stripSortable && stripSortable.destroy();
        stripSortable = Sortable.create(ul, {
          animation: 150, delay: 180, delayOnTouchOnly: true, touchStartThreshold: 6, direction: 'horizontal',
          onEnd() {
            const ids = [...ul.children].map(c => c.dataset.id);
            if (ids.join() === list.map(x => x.id).join()) return;
            setSlides(ids, lead.id); renderGrid(); renderStrip(); updateTitle();
          },
        });
      }
    } else if (stripSortable) { stripSortable.destroy(); stripSortable = null; }
    stripEl.replaceChildren(...nodes);
  }
  stripEl.addEventListener('click', e => {
    const th = e.target.closest('.sl-th');
    if (th) { if (!S.current || th.dataset.id !== S.current.id) openEditor(th.dataset.id); return; }
    const b = e.target.closest('[data-sl]'); if (!b || !S.current) return;
    if (b.dataset.sl === 'add') $('#slideSheet').hidden = false;
    else if (b.dataset.sl === 'detach') detachSlide(S.current);
  });
  function detachSlide(it) {
    const lead = leaderOf(it), list = slidesOf(lead).map(x => x.id);
    if (list.length < 2) return;
    const rest = list.filter(id => id !== it.id);
    const newLead = setSlides(rest, lead.id);
    delete it.parent; delete it.slides; saveItem(it);
    S.order.splice(S.order.indexOf(newLead.id) + 1, 0, it.id);
    saveOrder(); renderGrid(); openEditor(it.id);
    toast('Ahora es una publicación aparte, al lado del carrusel');
  }
  const slideInput = document.createElement('input');
  slideInput.type = 'file'; slideInput.accept = $('#fileInput').accept; slideInput.multiple = true; slideInput.hidden = true;
  document.body.append(slideInput);
  slideInput.addEventListener('change', () => {
    const fs = [...slideInput.files]; slideInput.value = '';
    if (fs.length && S.current) importFiles(fs, { into: leaderOf(S.current) });
  });
  $('#slideSheet').addEventListener('click', e => {
    const b = e.target.closest('button'), sh = $('#slideSheet');
    if (!b && e.target !== sh) return;
    sh.hidden = true;
    if (!b || !S.current) return;
    const lead = leaderOf(S.current);
    if (b.dataset.sl === 'files') slideInput.click();
    else if (b.dataset.sl === 'blank') createBlank({ into: lead });
    else if (b.dataset.sl === 'grid') { if (S.order.length < 2) toast('No hay otras publicaciones en la grilla'); else startSelect('carousel'); }
  });

  // ================= Exportar / descargar =================
  async function exportItem(it) {
    let s;
    if (videoSource(it)) {
      while (seeking) await new Promise(r => setTimeout(r, 50));
      s = videoSource(it);
    }
    if (s) { /* fotograma actual del video */ }
    else if (it.kind === 'blank') s = { img: solidImage(it.bg), w: 40, h: 50 };
    else if (S.full && S.full.id === it.id) s = S.full;
    else {
      const img = await loadImage(await getOrigBlob(it));
      s = { img, w: img.naturalWidth, h: img.naturalHeight };
    }
    await T.fontsReady(it);
    const out = R.render(s.img, s.w, s.h, it.crop, it.adj, OUT_W, OUT_H, ASPECT, true);
    const c = canvas(OUT_W, OUT_H);
    const cx = c.getContext('2d');
    cx.drawImage(out, 0, 0);
    T.draw(cx, it, OUT_W, OUT_H);
    const blob = await toBlob(c, 'image/jpeg', 0.95);
    c.width = 0;
    return blob;
  }
  const baseName = n => (n || 'foto').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40);

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function deliver(files) {
    // iPhone: hoja de compartir → "Guardar imagen" va directo a Fotos.
    if (isIOS && navigator.canShare && navigator.canShare({ files })) {
      $('#sheetText').textContent = files.length === 1 ? 'Tu foto está lista.' : `Tus ${files.length} fotos están listas.`;
      $('#sheet').hidden = false;
      $('#sheetShare').onclick = async () => {
        try { await navigator.share({ files }); } catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir'); }
        $('#sheet').hidden = true;
      };
      return;
    }
    if (files.length === 1 || isAndroid || !window.JSZip) {
      for (const f of files) { downloadBlob(f, f.name); await new Promise(r => setTimeout(r, 350)); }
      return;
    }
    const zip = new JSZip();
    files.forEach(f => zip.file(f.name, f));
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'mosaico.zip');
  }
  $('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });

  $('#downloadBtn').addEventListener('click', async () => {
    const it = S.current; if (!it) return;
    const list = slidesOf(leaderOf(it));
    try {
      if (list.length > 1) {   // carrusel: todas las diapositivas, numeradas en orden
        const files = [], base = baseName(list[0].name);
        for (let i = 0; i < list.length; i++) {
          toast(`Preparando ${i + 1} de ${list.length}…`, true);
          files.push(new File([await exportItem(list[i])], `${base}-carrusel-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
        }
        toast('Listas — numeradas en el orden del carrusel');
        await deliver(files);
        return;
      }
      toast('Preparando…', true);
      const blob = await exportItem(it);
      toast('Lista');
      const suffix = it.kind === 'video' ? 'portada-1080x1350' : '1080x1350';
      await deliver([new File([blob], `${baseName(it.name)}-${suffix}.jpg`, { type: 'image/jpeg' })]);
    } catch (e) { console.error(e); toast('No se pudo exportar'); }
  });
  $('#downloadAll').addEventListener('click', async () => {
    if (!S.order.length) return;
    // Numeradas en orden de publicación: la última de la grilla es la primera en subirse.
    const ids = [...S.order].reverse();
    const files = [];
    try {
      for (let i = 0; i < ids.length; i++) {
        toast(`Preparando ${i + 1} de ${ids.length}…`, true);
        const list = slidesOf(S.items.get(ids[i])), n = String(i + 1).padStart(2, '0');
        for (let k = 0; k < list.length; k++) {
          const blob = await exportItem(list[k]);
          files.push(new File([blob], list.length > 1 ? `mosaico-${n}-${k + 1}.jpg` : `mosaico-${n}.jpg`, { type: 'image/jpeg' }));
        }
      }
      toast('Listas — numeradas en el orden en que hay que publicarlas');
      await deliver(files);
    } catch (e) { console.error(e); toast('No se pudo exportar'); }
  });

  // ================= Teclado =================
  document.addEventListener('keydown', e => {
    if (T.keydown(e)) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if ((tag === 'input' && e.target.type !== 'range') || tag === 'textarea' || tag === 'select') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c' && !getSelection().toString()) { copyAdj(); e.preventDefault(); }
    else if (mod && e.key.toLowerCase() === 'v' && S.lastCopied === 'layer' && T.hasLayerClip()) { T.pasteLayer(); e.preventDefault(); }
    else if (mod && e.key.toLowerCase() === 'v' && S.clip) { pasteAdj(); e.preventDefault(); }
    else if (e.key === 'Escape' && S.selecting) endSelect();
    else if (!mod && tag !== 'input' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && S.current) {
      const d = e.key === 'ArrowRight' ? 1 : -1, lead = leaderOf(S.current), list = slidesOf(lead);
      const k = list.indexOf(S.current) + d;
      if (list.length > 1 && list[k]) { openEditor(list[k].id); return; }
      const i = S.order.indexOf(lead.id) + d;
      if (S.order[i]) openEditor(S.order[i]);
    }
  });

  // ================= Nube (Google Drive) =================
  let gridSoon = 0;
  function renderGridSoon() {
    if (gridSoon) return;
    gridSoon = requestAnimationFrame(() => { gridSoon = 0; if (S.dragging) return renderGridSoon(); renderGrid(); });
  }
  function removeLocalItem(id) {
    const it = S.items.get(id);
    if (!it) return;
    S.items.delete(id);
    S.order = S.order.filter(x => x !== id);
    if (S.full && S.full.id === id) S.full = null;
    if (S.video && S.video.id === id) { closeVideo(S.video.v); S.video = null; }
    if (S.current === it) {
      S.current = null;
      document.body.classList.remove('has-current');
      closeEditorMobile();
    }
    DB.remove(id).catch(reportError);
    if (S.current) renderStrip();
  }
  // Lo que el módulo de sincronización necesita de la app.
  let storageWarned = false;
  async function saveLocalSafe(fn) {
    let t;
    try { await Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tiempo agotado')), 10000); })]); return true; }
    catch (e) {
      console.warn('no se pudo guardar en el dispositivo', e);
      if (!storageWarned) { storageWarned = true; toast('Este navegador no deja guardar las fotos en el teléfono (¿navegación privada?). Se ven igual, pero hay que bajarlas cada vez.', false, 9000); }
      return false;
    } finally { clearTimeout(t); }
  }
  const appApi = {
    workspaceId: WS.cur.id,
    listItems: () => [...S.items.values()],
    getBlobs: id => DB.get('blobs', id),
    getVideo: async id => { const r = await DB.get('videos', id); return r && r.video; },
    persist: persistItem,
    getOrderState: () => ({ order: [...S.order], deleted: [...S.deleted], dirty: S.orderDirty }),
    applyOrder(order, deleted, keepDirty) {
      for (const id of deleted) S.deleted.add(id);
      for (const id of [...S.items.keys()]) if (S.deleted.has(id)) removeLocalItem(id);
      const next = order.filter(id => S.items.has(id));
      for (const id of S.order) if (S.items.has(id) && !next.includes(id)) next.unshift(id);
      const changed = next.join() !== S.order.join();
      S.order = next;
      normalizeOrder();
      S.orderDirty = !!keepDirty && S.orderDirty;
      persistOrder();
      if (changed) renderGridSoon();
    },
    async addRemoteItem(m, thumbBlob) {
      if (S.items.has(m.id) || S.deleted.has(m.id)) return;
      const it = { ...m, adj: { ...zeroAdj(), ...m.adj }, crop: { rot: 0, ...m.crop } };
      if (m.kind === 'blank') {
        it.thumb = solidImage(m.bg);
        S.items.set(it.id, it);
        if (!S.order.includes(it.id)) S.order.unshift(it.id);
        renderGridSoon();
        await saveLocalSafe(() => DB.put('items', meta(it)));
        return;
      }
      it.thumb = await loadImage(thumbBlob);
      S.items.set(it.id, it);
      if (!S.order.includes(it.id)) S.order.unshift(it.id);
      renderGridSoon();
      // Guardar en el teléfono; si el navegador no deja (p. ej. navegación privada), se sigue igual en memoria.
      await saveLocalSafe(() => DB.put('blobs', { id: m.id, thumb: thumbBlob }));   // el original se baja al abrirla
      await saveLocalSafe(() => DB.put('items', meta(it)));
    },
    async updateRemoteItem(it, m, thumbBlob) {
      const wasT = it.t;
      Object.assign(it, { name: m.name, w: m.w, h: m.h, crop: { rot: 0, ...m.crop }, adj: { ...zeroAdj(), ...m.adj }, texts: m.texts !== undefined ? m.texts : (it.texts || []), kind: m.kind, duration: m.duration, t: m.t, sync: m.sync });
      const famBefore = JSON.stringify([it.parent, it.slides]);
      for (const k of ['parent', 'slides']) { if (m[k] == null) delete it[k]; else it[k] = m[k]; }
      if (JSON.stringify([it.parent, it.slides]) !== famBefore) { renderGridSoon(); if (S.current) { renderStrip(); updateTitle(); } }
      if (m.kind === 'blank') {
        it.bg = m.bg; it.thumb = solidImage(m.bg);
        if (S.full && S.full.id === it.id) S.full = { id: it.id, img: it.thumb, w: 40, h: 50 };
      } else if (m.bg) it.bg = m.bg;
      if (thumbBlob) {
        it.thumb = await loadImage(thumbBlob);
        await saveLocalSafe(() => DB.put('blobs', { id: it.id, thumb: thumbBlob }));   // cambió la portada: el original viejo ya no sirve
        if (S.full && S.full.id === it.id) S.full = null;
      }
      await saveLocalSafe(() => DB.put('items', meta(it)));
      drawThumb(it);
      if (S.current === it) {
        T.refresh();
        syncControls(); updateTitle();
        if (it.kind === 'video' && S.video && S.video.id === it.id && it.t !== wasT) {
          frameInput.value = it.duration ? Math.round(it.t / it.duration * 1000) : 0;
          frameOut.textContent = fmtTime(it.t);
          scrubTo(it.t);
        } else if (thumbBlob && it.kind !== 'video') openEditor(it.id);
        requestRender();
      }
    },
    async onProjectChanged() { renderGridSoon(); },
    // imágenes de las capas: se suben una vez y la capa guarda el archivo de la nube (fileId)
    async layerImage(imgId) { const r = await DB.get('blobs', 'L:' + imgId); return r || null; },
    async setLayerFileId(imgId, fileId) {
      const r = await DB.get('blobs', 'L:' + imgId);
      if (r) await DB.put('blobs', { ...r, fileId }).catch(() => { });
      for (const x of S.items.values()) {
        let ch = false;
        for (const L of x.texts || []) if (L.type === 'image' && L.img === imgId && L.fileId !== fileId) { L.fileId = fileId; ch = true; }
        if (ch && x.sync) persistItem(x);
      }
    },
    library: T.library,
    fonts: T.fonts,
  };

  // ---- panel "Nube" ----
  const cloudBtn = $('#cloudBtn'), cloudLabel = $('#cloudLabel'), cloudSheet = $('#cloudSheet'), cloudBody = $('#cloudBody');
  let foundProjects = null, cloudBusy = '';
  const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function cloudChip(st) {
    cloudBtn.classList.remove('ok', 'warn', 'busy');
    if (!st.configured || (!st.signedIn && !st.expired)) { cloudLabel.textContent = 'Nube'; return; }
    if (st.expired) { cloudLabel.textContent = 'Reconectar'; cloudBtn.classList.add('warn'); return; }
    if (!st.project) { cloudLabel.textContent = 'Elegir proyecto'; cloudBtn.classList.add('warn'); return; }
    if (st.phase === 'syncing') { cloudLabel.textContent = 'Sincronizando…'; cloudBtn.classList.add('busy'); return; }
    if (st.phase === 'error') { cloudLabel.textContent = 'Error'; cloudBtn.classList.add('warn'); return; }
    if (st.phase === 'offline') { cloudLabel.textContent = 'Sin conexión'; cloudBtn.classList.add('warn'); return; }
    cloudLabel.textContent = 'Al día'; cloudBtn.classList.add('ok');
  }
  function renderCloud(st) {
    cloudChip(st);
    if (cloudSheet.hidden) return;
    const n = S.order.length;
    let h = '';
    if (!st.configured) {
      h = `<p>Todavía falta configurar la conexión con Google (el <b>ID de cliente</b>). Mientras tanto la app funciona igual, guardando todo en este dispositivo.</p>`;
    } else if (!st.signedIn) {
      h = st.expired
        ? `<p>La conexión con Google se vence cada una hora. Tus cambios se siguen guardando en este dispositivo y se suben apenas reconectes.</p>
           <button class="btn primary" data-act="signin">Reconectar con Google</button>`
        : `<p>Conectá tu cuenta de Google para guardar el proyecto en tu Drive y editarlo junto con otra persona.</p>
           <button class="btn primary" data-act="signin">Conectar con Google</button>`;
    } else if (!st.project) {
      const findBtn = `<button class="btn${n ? '' : ' primary'}" data-act="find">Abrir un proyecto que ya existe</button>
        <p class="muted small">Tuyo o compartido con vos: ${n ? 'se abre como un proyecto aparte, sin mezclarse con esta grilla.' : 'se baja la grilla a este dispositivo.'}</p>`;
      const createBtn = `<button class="btn${n ? ' primary' : ''}" data-act="create">Crear proyecto nuevo en mi Drive</button>
        <p class="muted small">${n ? `Se suben las ${n} publicaciones de “${escHtml(WS.cur.name)}”.` : `Se crea la carpeta “${escHtml(WS.cur.name)}” en tu Drive.`}</p>`;
      h = `<p class="muted">Cuenta: <b>${escHtml(st.user && st.user.email)}</b></p>` + (n ? createBtn + findBtn : findBtn + createBtn);
      if (foundProjects) {
        h += foundProjects.length
          ? `<div class="plist">${foundProjects.map(p => `<div class="prow"><span><b>${escHtml(p.name)}</b><br><span class="muted small">de ${escHtml(p.owner)}</span></span><button class="btn primary" data-act="open" data-id="${escHtml(p.id)}">Abrir</button></div>`).join('')}</div>`
          : `<p class="muted small">No encontré proyectos. Si te compartieron uno, revisá que te hayan invitado con este email.</p>`;
      }
      h += `<button class="chip" data-act="signout">Cerrar sesión de Google</button>`;
    } else {
      const status = { idle: st.detail || 'Al día', syncing: st.detail || 'Sincronizando…', error: 'Error: ' + st.detail, offline: 'Sin conexión: se sube cuando vuelva internet', expired: 'Conexión vencida' }[st.phase] || '';
      h = `<p>Proyecto <b>${escHtml(st.project.name)}</b>${st.project.owner ? ` <span class="muted">· de ${escHtml(st.project.owner)}</span>` : ''}</p>
        <p class="muted small">Cuenta: ${escHtml(st.user && st.user.email)} · ${escHtml(status)}</p>
        <form class="share" data-act="share"><input type="email" required placeholder="email de la otra persona" autocomplete="email"><button class="btn primary">Compartir</button></form>
        <p class="muted small">Le llega un mail de Google y puede editar. Tiene que entrar a la app, conectar Google y tocar “Abrir un proyecto que ya existe”.</p>
        <div class="row">
          <button class="chip" data-act="sync">Sincronizar ahora</button>
          <a class="chip" href="${escHtml(Sync.folderUrl())}" target="_blank" rel="noopener">Ver carpeta en Drive</a>
        </div>
        <div class="row">
          <button class="chip" data-act="signout">Cerrar sesión de Google</button>
        </div>`;
    }
    if (st.project && st.log && st.log.length) h += `<details class="synclog"><summary>Registro</summary><pre>${escHtml(st.log.join('\n'))}</pre></details>`;
    if (cloudBusy) h = `<p class="muted">${escHtml(cloudBusy)}</p>` + (cloudBusy.startsWith('Esperando a Google')
      ? `<p class="muted small">Se abre una ventana de Google aparte (fijate en el menú Ventana si quedó atrás). Si la cerraste o no aparece:</p><div class="row"><button class="chip" data-act="signin">Volver a intentar</button></div>` : '');
    cloudBody.innerHTML = h;
  }
  async function cloudAction(act, el) {
    const run = async (label, fn) => {
      cloudBusy = label; renderCloud(Sync.state());
      try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), false, 7000); }
      finally { cloudBusy = ''; renderCloud(Sync.state()); }
    };
    if (act === 'signin') return run('Esperando a Google…', () => Sync.signIn());
    if (act === 'signout') { if (confirm('¿Cerrar la sesión de Google en este dispositivo? Lo que ya está en Drive no se toca.')) { Sync.signOut(); foundProjects = null; renderCloud(Sync.state()); } return; }
    if (act === 'create') return run('Creando la carpeta en tu Drive…', () => Sync.createProject(WS.cur.name));
    if (act === 'find') return run('Buscando proyectos…', async () => { foundProjects = await Sync.findProjects(); });
    if (act === 'open') {
      const p = (foundProjects || []).find(x => x.id === el.dataset.id);
      return run('Abriendo el proyecto…', () => openCloudProject(p));
    }
    if (act === 'sync') { Sync.syncNow(); return; }
    if (act === 'openPending') return run('Abriendo “' + el.p.name + '”…', () => Sync.openProject(el.p));
    if (act === 'leave') {
      if (confirm('¿Dejar de sincronizar este proyecto en este dispositivo? No se borra nada.')) { Sync.leaveProject(); foundProjects = null; renderCloud(Sync.state()); }
      return;
    }
  }
  // Abrir un proyecto de Drive sin mezclar grillas: si este proyecto ya tiene fotos, va a uno nuevo.
  async function openCloudProject(p) {
    if (!p) return;
    const here = WS.list.find(w => { const q = w.id === WS.cur.id ? Sync.state().project : WS.project(w); return q && q.id === p.id; });
    if (here) { if (here.id !== WS.cur.id) await goWorkspace(here.id); return; }
    if (!S.order.length && !Sync.state().project) {
      await Sync.openProject(p);
      WS.cur.name = p.name; WS.save(); projLabel();
      return;
    }
    const w = WS.create(p.name);
    WS.set('mosaico.pendingOpen.' + w.id, p);
    await goWorkspace(w.id);
  }
  async function flushSaves() {
    const waits = [];
    for (const [id, t] of saveTimers) { clearTimeout(t); const it = S.items.get(id); if (it) waits.push(DB.put('items', meta(it)).catch(() => { })); }
    saveTimers.clear();
    if (S.video) waits.push(flushFrame(S.video).catch(() => { }));
    await Promise.all(waits);
  }
  async function goWorkspace(id) { await flushSaves(); WS.go(id); }

  // ---- menú de proyectos ----
  const projSheet = $('#projSheet'), projBody = $('#projBody');
  let projFound = null, projBusy = '';
  function projLabel() {
    $('#projName').textContent = WS.cur.name;
    document.title = WS.list.length > 1 ? `${WS.cur.name} · Mosaico` : 'Mosaico';
  }
  function renderProjects() {
    if (projSheet.hidden) return;
    const st = Sync ? Sync.state() : {};
    const projOf = w => w.id === WS.cur.id ? (st.project || WS.project(w)) : WS.project(w);
    let h = `<div class="plist">${WS.list.map(w => {
      const p = projOf(w), cur = w.id === WS.cur.id;
      const sub = p ? `☁︎ En Drive${p.owner ? ' · de ' + escHtml(p.owner) : ''}` : 'Sólo en este dispositivo';
      return `<div class="prow${cur ? ' cur' : ''}">
        <button class="pw" data-pact="go" data-id="${w.id}"><b>${escHtml(w.name)}</b><span class="muted small">${sub}</span></button>
        ${cur ? '<span class="muted small">abierto</span>' : (isNarrow() ? '' : `<a class="chip" href="${escHtml(WS.url(w.id))}" target="_blank" rel="noopener" title="Abrir en otra pestaña">↗</a>`)}
      </div>`;
    }).join('')}</div>
      <div class="row"><button class="btn primary" data-pact="new">+ Proyecto nuevo</button><button class="btn" data-pact="find">Abrir uno de la nube</button></div>`;
    if (projFound) {
      h += projFound.length
        ? `<p class="muted small">En tu Drive y compartidos con vos:</p><div class="plist">${projFound.map(p => {
            const has = WS.list.find(w => { const q = projOf(w); return q && q.id === p.id; });
            return `<div class="prow"><span><b>${escHtml(p.name)}</b><br><span class="muted small">de ${escHtml(p.owner)}</span></span><button class="btn${has ? '' : ' primary'}" data-pact="open" data-id="${escHtml(p.id)}">${has ? 'Ir' : 'Abrir'}</button></div>`;
          }).join('')}</div>`
        : `<p class="muted small">No encontré proyectos en tu Drive ni compartidos con vos.</p>`;
    }
    h += `<div class="row"><button class="chip" data-pact="rename">Renombrar “${escHtml(WS.cur.name)}”</button>${WS.list.length > 1 ? '<button class="chip danger" data-pact="remove">Quitar de este dispositivo</button>' : ''}</div>`;
    if (projBusy) h = `<p class="muted">${escHtml(projBusy)}</p>`;
    projBody.innerHTML = h;
  }
  async function projAction(act, el) {
    const st = Sync ? Sync.state() : {};
    const busy = async (label, fn) => {
      projBusy = label; renderProjects();
      try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), false, 7000); }
      finally { projBusy = ''; renderProjects(); }
    };
    if (act === 'go') { if (el.dataset.id !== WS.cur.id) await goWorkspace(el.dataset.id); else projSheet.hidden = true; return; }
    if (act === 'new') {
      const name = (prompt('Nombre del proyecto nuevo (por ejemplo, el de la cuenta de Instagram)', '') || '').trim();
      if (!name) return;
      const w = WS.create(name);
      if (st.signedIn) WS.set('mosaico.pendingCreate.' + w.id, true);   // se crea también en Drive al abrirlo
      await goWorkspace(w.id);
      return;
    }
    if (act === 'find') {
      if (!st.signedIn) { projSheet.hidden = true; cloudSheet.hidden = false; renderCloud(Sync.state()); toast('Primero conectá Google'); return; }
      return busy('Buscando proyectos…', async () => { projFound = await Sync.findProjects(); });
    }
    if (act === 'open') {
      const p = (projFound || []).find(x => x.id === el.dataset.id);
      return busy('Abriendo…', () => openCloudProject(p));
    }
    if (act === 'rename') {
      const name = (prompt('Nuevo nombre del proyecto', WS.cur.name) || '').trim();
      if (!name || name === WS.cur.name) return;
      WS.cur.name = name; WS.save(); projLabel(); renderProjects();
      if (st.project && st.signedIn) Sync.renameProject(name).catch(e => toast('No se pudo renombrar en Drive: ' + e.message, false, 6000));
      return;
    }
    if (act === 'remove') {
      const p = st.project;
      const msg = p
        ? `¿Quitar “${WS.cur.name}” de este dispositivo? En Drive queda todo, y lo podés volver a abrir cuando quieras.`
        : (S.order.length ? `“${WS.cur.name}” no está en la nube: sus ${S.order.length} publicaciones se van a borrar de este dispositivo. ¿Seguro?` : `¿Quitar “${WS.cur.name}”?`);
      if (!confirm(msg)) return;
      const other = WS.list.find(w => w.id !== WS.cur.id);
      WS.list.splice(WS.list.indexOf(WS.cur), 1); WS.save();
      WS.set('mosaico.project.' + WS.cur.id, null);
      WS.set('mosaico.pendingDelete', [...(WS.get('mosaico.pendingDelete') || []), WS.cur.db]);
      WS.go(other.id);
    }
  }
  $('#projBtn').addEventListener('click', () => { projFound = null; projSheet.hidden = false; renderProjects(); });
  $('#projClose').addEventListener('click', () => { projSheet.hidden = true; });
  projSheet.addEventListener('click', e => {
    if (e.target === projSheet) { projSheet.hidden = true; return; }
    const b = e.target.closest('[data-pact]');
    if (b) { e.preventDefault(); projAction(b.dataset.pact, b); }
  });
  projLabel();

  cloudBtn.addEventListener('click', () => { if (!Sync) toast('La nube todavía está cargando. Si no responde, cerrá las otras pestañas de Mosaico y recargá.', false, 7000); });
  function startCloud() {
    if (Sync) return;
    if (!window.createMosaicoSync) { cloudBtn.hidden = true; return; }
    Sync = window.createMosaicoSync(appApi);
    Sync.onChange(st => { renderCloud(st); renderProjects(); });
    const pendOpen = WS.get('mosaico.pendingOpen.' + WS.cur.id), pendCreate = WS.get('mosaico.pendingCreate.' + WS.cur.id);
    if ((pendOpen || pendCreate) && !Sync.state().project) {
      if (Sync.state().signedIn) {
        WS.set('mosaico.pendingOpen.' + WS.cur.id, null); WS.set('mosaico.pendingCreate.' + WS.cur.id, null);
        cloudSheet.hidden = false;
        setTimeout(() => pendOpen ? cloudAction('openPending', { p: pendOpen }) : cloudAction('create'), 0);
      } else if (pendOpen) toast('Conectá Google para bajar “' + pendOpen.name + '”', false, 6000);
    }
    if (Sync.fromRedirect === 'ok' && !Sync.state().project) { cloudSheet.hidden = false; renderCloud(Sync.state()); }
    else if (Sync.fromRedirect && Sync.fromRedirect !== 'ok') toast('No se pudo conectar con Google: ' + Sync.fromRedirect, false, 8000);
    cloudBtn.addEventListener('click', () => {
      const st = Sync.state();
      if (st.expired && st.project) return cloudAction('signin');   // un toque y reconecta
      cloudSheet.hidden = false; renderCloud(st);
    });
    $('#cloudClose').addEventListener('click', () => { cloudSheet.hidden = true; });
    cloudSheet.addEventListener('click', e => {
      if (e.target === cloudSheet) { cloudSheet.hidden = true; return; }
      const b = e.target.closest('[data-act]');
      if (b && b.tagName !== 'FORM') { e.preventDefault(); cloudAction(b.dataset.act, b); }
    });
    cloudSheet.addEventListener('submit', async e => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const email = input.value.trim();
      if (!email) return;
      cloudBusy = 'Compartiendo…'; renderCloud(Sync.state());
      try { await Sync.share(email); toast('Listo: le llegó una invitación a ' + email, false, 5000); }
      catch (err) { toast(err.message || String(err), false, 7000); }
      finally { cloudBusy = ''; renderCloud(Sync.state()); }
    });
  }

  // ================= Inicio =================
  async function init() {
    if (location.protocol === 'file:') {
      toast('Abrí la app desde http://localhost:5173 (no haciendo doble clic en el archivo), si no el navegador no deja guardar.', false, 15000);
    }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { }
    try {
      if (localStorage.getItem('mosaico.gridAspect') === '45') {
        S.gridAspect = ASPECT; $('#viewToggle').textContent = '4:5';
      }
    } catch { }
    // Si la memoria local no responde (p. ej. otra pestaña con una versión vieja la tiene tomada), avisar.
    const slow = setTimeout(() => toast('Mosaico está esperando la memoria del navegador. Cerrá las otras pestañas de Mosaico y recargá esta.', true), 4000);
    try {
      T.init();
      const [metas, order, deleted, orderDirty] = await Promise.all([DB.getAll('items'), DB.get('meta', 'order'), DB.get('meta', 'deleted'), DB.get('meta', 'orderDirty')]);
      S.deleted = new Set(deleted || []);
      S.orderDirty = !!orderDirty;
      for (const m of metas) S.items.set(m.id, { ...m, adj: { ...zeroAdj(), ...m.adj }, texts: m.texts || [] });
      S.order = (order || []).filter(id => S.items.has(id));
      for (const id of S.items.keys()) if (!S.order.includes(id)) S.order.push(id);
    } catch (e) { reportError(e); }
    clearTimeout(slow);
    renderGrid();
    try { startCloud(); } catch (e) { reportError(e); }   // la nube no depende de que carguen las miniaturas
    await Promise.all(S.order.map(async id => {
      const it = S.items.get(id);
      try {
        if (it.kind === 'blank') { it.thumb = solidImage(it.bg); drawThumb(it); return; }
        const b = await DB.get('blobs', id);
        it.thumb = await loadImage(b.thumb);
        drawThumb(it);
      } catch (e) { console.error(e); }
    }));
    if (S.order.length && !isNarrow()) openEditor(S.order[0]);
  }
  init().catch(reportError);

  // para pruebas
  window.__mosaico = { importFiles, exportItem, loadHeicLib, clampCrop, S, T, appApi, get Sync() { return Sync; } };
})();
