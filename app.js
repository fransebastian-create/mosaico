'use strict';
(() => {
  // ================= Constantes =================
  const VERSION = 'v0.8';
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
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ================= Almacenamiento local (IndexedDB) =================
  const DB = {
    _p: null,
    open() {
      return this._p ||= new Promise((res, rej) => {
        const r = indexedDB.open('mosaico', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          const mk = (n, o) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); };
          mk('items', { keyPath: 'id' });
          mk('blobs', { keyPath: 'id' });   // fotograma/foto + miniatura (se reescribe seguido, es liviano)
          mk('videos', { keyPath: 'id' });  // video original (se escribe una sola vez)
          mk('meta');
        };
        r.onsuccess = () => res(r.result);
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

  const meta = it => ({ id: it.id, name: it.name, w: it.w, h: it.h, crop: it.crop, adj: it.adj, kind: it.kind || 'image', duration: it.duration, t: it.t, sync: it.sync || null });
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

  let toastTimer;
  function toast(msg, sticky = false, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
      d.addEventListener('click', () => onCellClick(it));
      it.canvas = c; it.cell = d;
    }
    it.cell.classList.toggle('current', S.current === it);
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
    if (!it.thumb || !it.canvas || !R) return;
    const cw = 360, ch = Math.round(cw / S.gridAspect);
    const vs = videoSource(it);
    const src = vs || { img: it.thumb, w: it.thumb.naturalWidth, h: it.thumb.naturalHeight };
    const out = R.render(src.img, src.w, src.h, it.crop,
      S.showOriginalGrid ? null : it.adj, cw, ch, S.gridAspect);
    const c = it.canvas;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    c.getContext('2d').drawImage(out, 0, 0);
  }
  function renderGrid() {
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

  async function importFiles(fileList) {
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
        let src = f, img;
        try { img = await loadImage(f); }
        catch (e) {
          if (!isHeic(f)) throw e;
          toast(`Convirtiendo foto HEIC ${i + 1} de ${files.length}…`, true);
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
    S.order = [...newIds, ...S.order];
    saveOrder(); renderGrid();
    if (errors.length) {
      toast(`Se agregaron ${newIds.length}. No se pudo leer: ${errors.join(' · ')}`, false, 12000);
    } else {
      toast(`Se ${newIds.length === 1 ? 'agregó 1 archivo' : 'agregaron ' + newIds.length + ' archivos'}`);
    }
    if (newIds.length && !isNarrow()) openEditor(newIds[0]);
  }

  // arrastrar archivos desde la compu
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
    importFiles(e.dataTransfer.files);
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
    if (S.current && S.current.cell) S.current.cell.classList.remove('current');
    S.current = it;
    it.cell && it.cell.classList.add('current');
    document.body.classList.add('has-current', 'editing');
    syncControls(); updateTitle(); fitFrame(); requestRender();
    const isVid = it.kind === 'video';
    $('#frameRow').hidden = !isVid;
    if (isVid) {
      frameInput.value = it.duration ? Math.round((it.t || 0) / it.duration * 1000) : 0;
      frameOut.textContent = fmtTime(it.t || 0);
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
    $('#editorTitle').textContent = it ? `Publicación ${S.order.indexOf(it.id) + 1} de ${S.order.length}${it.kind === 'video' ? ' · portada de video' : ''}` : '';
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
  function drawPreview() {
    const it = S.current;
    if (!it || !it.thumb || !R) return;
    const s = source(it);
    const out = R.render(s.img, s.w, s.h, it.crop, S.holdBefore ? null : it.adj, pv.width, pv.height, ASPECT);
    pctx.drawImage(out, 0, 0);
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
    try { frame.setPointerCapture(e.pointerId); } catch { }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) twist = makeTwist();
    frame.classList.add('dragging');
  });
  frame.addEventListener('pointermove', e => {
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
      if (!S.current) return;
      macGesture = { scale: 1, rotation: 0, tw: makeTwist() };
      frame.classList.add('dragging');
    });
    frame.addEventListener('gesturechange', e => {
      e.preventDefault();
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
      macGesture = null;
      frame.classList.remove('dragging');
    });
  }

  frame.addEventListener('wheel', e => {
    if (!S.current || macGesture) return;
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, f, rect);
    cropChanged();
  }, { passive: false });
  frame.addEventListener('dblclick', () => {
    if (!S.current) return;
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
  rotInput.addEventListener('dblclick', () => S.current && setRotation(base90(S.current.crop.rot || 0)));
  $('#rotOut').closest('label').addEventListener('dblclick', () => S.current && setRotation(base90(S.current.crop.rot || 0)));
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
    row.querySelector('label').addEventListener('dblclick', reset);
    inp.addEventListener('dblclick', reset);
    sliderUI[a.key] = { inp, out };
    $('#sliders').append(row);
  }
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
  function copyAdj() {
    if (!S.current) return;
    S.clip = { ...S.current.adj };
    pasteBtn.disabled = pasteManyBtn.disabled = false;
    toast('Ajustes copiados');
  }
  function pasteAdj() {
    if (!S.current || !S.clip) return;
    S.current.adj = { ...S.clip };
    syncControls(); requestRender(); saveItem(S.current);
    toast('Ajustes pegados');
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
  function startSelect() {
    if (!S.clip) return;
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
    $('#selectCount').textContent = n ? `${n} seleccionada${n > 1 ? 's' : ''}` : 'Tocá las fotos';
    $('#selectApply').disabled = !n;
  }
  pasteManyBtn.addEventListener('click', startSelect);
  $('#selectCancel').addEventListener('click', endSelect);
  $('#selectAll').addEventListener('click', () => {
    S.order.forEach(id => { S.selected.add(id); S.items.get(id).cell.classList.add('selected'); });
    updateSelectBar();
  });
  $('#selectApply').addEventListener('click', () => {
    const n = S.selected.size;
    for (const id of S.selected) {
      const it = S.items.get(id);
      it.adj = { ...S.clip };
      drawThumb(it); saveItem(it);
    }
    endSelect(); syncControls(); requestRender();
    toast(`Ajustes pegados en ${n} foto${n > 1 ? 's' : ''}`);
  });

  // eliminar
  $('#deleteBtn').addEventListener('click', async () => {
    const it = S.current; if (!it) return;
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

  // ================= Exportar / descargar =================
  async function exportItem(it) {
    let s;
    if (videoSource(it)) {
      while (seeking) await new Promise(r => setTimeout(r, 50));
      s = videoSource(it);
    }
    if (s) { /* fotograma actual del video */ }
    else if (S.full && S.full.id === it.id) s = S.full;
    else {
      const img = await loadImage(await getOrigBlob(it));
      s = { img, w: img.naturalWidth, h: img.naturalHeight };
    }
    const out = R.render(s.img, s.w, s.h, it.crop, it.adj, OUT_W, OUT_H, ASPECT, true);
    const c = canvas(OUT_W, OUT_H);
    c.getContext('2d').drawImage(out, 0, 0);
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
    toast('Preparando…', true);
    try {
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
        const blob = await exportItem(S.items.get(ids[i]));
        files.push(new File([blob], `mosaico-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
      }
      toast('Listas — numeradas en el orden en que hay que publicarlas');
      await deliver(files);
    } catch (e) { console.error(e); toast('No se pudo exportar'); }
  });

  // ================= Teclado =================
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c' && !getSelection().toString()) { copyAdj(); e.preventDefault(); }
    else if (mod && e.key.toLowerCase() === 'v' && S.clip) { pasteAdj(); e.preventDefault(); }
    else if (e.key === 'Escape' && S.selecting) endSelect();
    else if (!mod && tag !== 'input' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && S.current) {
      const i = S.order.indexOf(S.current.id) + (e.key === 'ArrowRight' ? 1 : -1);
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
  }
  // Lo que el módulo de sincronización necesita de la app.
  const appApi = {
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
      S.orderDirty = !!keepDirty && S.orderDirty;
      persistOrder();
      if (changed) renderGridSoon();
    },
    async addRemoteItem(m, thumbBlob) {
      if (S.items.has(m.id) || S.deleted.has(m.id)) return;
      await DB.put('blobs', { id: m.id, thumb: thumbBlob });   // el original se baja al abrirla
      const it = { ...m, adj: { ...zeroAdj(), ...m.adj }, crop: { rot: 0, ...m.crop } };
      it.thumb = await loadImage(thumbBlob);
      await DB.put('items', meta(it));
      S.items.set(it.id, it);
      if (!S.order.includes(it.id)) S.order.unshift(it.id);
      renderGridSoon();
    },
    async updateRemoteItem(it, m, thumbBlob) {
      const wasT = it.t;
      Object.assign(it, { name: m.name, w: m.w, h: m.h, crop: { rot: 0, ...m.crop }, adj: { ...zeroAdj(), ...m.adj }, kind: m.kind, duration: m.duration, t: m.t, sync: m.sync });
      if (thumbBlob) {
        await DB.put('blobs', { id: it.id, thumb: thumbBlob });   // cambió la portada: el original viejo ya no sirve
        it.thumb = await loadImage(thumbBlob);
        if (S.full && S.full.id === it.id) S.full = null;
      }
      await DB.put('items', meta(it));
      drawThumb(it);
      if (S.current === it) {
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
      h = `<p class="muted">Cuenta: <b>${escHtml(st.user && st.user.email)}</b></p>
        <button class="btn primary" data-act="create">Crear proyecto nuevo en mi Drive</button>
        <p class="muted small">${n ? `Se suben las ${n} publicaciones que hay en este dispositivo.` : 'Se crea una carpeta “Mosaico” en tu Drive.'}</p>
        <button class="btn" data-act="find">Buscar proyectos compartidos conmigo</button>`;
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
        <p class="muted small">Le llega un mail de Google y puede editar. Tiene que entrar a la app y tocar “Buscar proyectos compartidos conmigo”.</p>
        <div class="row">
          <button class="chip" data-act="sync">Sincronizar ahora</button>
          <a class="chip" href="${escHtml(Sync.folderUrl())}" target="_blank" rel="noopener">Ver carpeta en Drive</a>
        </div>
        <div class="row">
          <button class="chip" data-act="leave">Usar otro proyecto</button>
          <button class="chip" data-act="signout">Cerrar sesión de Google</button>
        </div>`;
    }
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
    if (act === 'create') return run('Creando la carpeta en tu Drive…', () => Sync.createProject('Mosaico'));
    if (act === 'find') return run('Buscando proyectos…', async () => { foundProjects = await Sync.findProjects(); });
    if (act === 'open') {
      const p = (foundProjects || []).find(x => x.id === el.dataset.id);
      return run('Abriendo el proyecto…', () => Sync.openProject(p));
    }
    if (act === 'sync') { Sync.syncNow(); return; }
    if (act === 'leave') {
      if (confirm('¿Dejar de sincronizar este proyecto en este dispositivo? No se borra nada.')) { Sync.leaveProject(); foundProjects = null; renderCloud(Sync.state()); }
      return;
    }
  }
  function startCloud() {
    if (!window.createMosaicoSync) { cloudBtn.hidden = true; return; }
    Sync = window.createMosaicoSync(appApi);
    Sync.onChange(renderCloud);
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
    const [metas, order, deleted, orderDirty] = await Promise.all([DB.getAll('items'), DB.get('meta', 'order'), DB.get('meta', 'deleted'), DB.get('meta', 'orderDirty')]);
    S.deleted = new Set(deleted || []);
    S.orderDirty = !!orderDirty;
    for (const m of metas) S.items.set(m.id, { ...m, adj: { ...zeroAdj(), ...m.adj } });
    S.order = (order || []).filter(id => S.items.has(id));
    for (const id of S.items.keys()) if (!S.order.includes(id)) S.order.push(id);
    renderGrid();
    await Promise.all(S.order.map(async id => {
      const it = S.items.get(id);
      try {
        const b = await DB.get('blobs', id);
        it.thumb = await loadImage(b.thumb);
        drawThumb(it);
      } catch (e) { console.error(e); }
    }));
    if (S.order.length && !isNarrow()) openEditor(S.order[0]);
    startCloud();
  }
  init().catch(reportError);

  // para pruebas
  window.__mosaico = { importFiles, exportItem, loadHeicLib, clampCrop, S, get Sync() { return Sync; } };
})();
