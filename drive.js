'use strict';
// =====================================================================
// Mosaico · Sincronización con Google Drive
//
// La app trabaja siempre contra la memoria local del navegador (rápido, funciona sin internet).
// Este módulo sube los cambios a una carpeta de Drive compartida y trae los de las demás personas.
//
// Estructura en Drive:
//   Mosaico/                 (carpeta del proyecto, compartible)
//     datos/   item-<id>.json   ajustes, recorte, giro… de cada publicación
//              orden.json       orden de la grilla + publicaciones eliminadas
//     archivos/<id>-original.jpg, <id>-miniatura.jpg, <id>-video.mov
// =====================================================================
window.createMosaicoSync = function createMosaicoSync(app) {
  const CFG = window.MOSAICO_CONFIG || {};
  const CLIENT_ID = CFG.googleClientId || '';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const POLL_MS = 6000;
  const PUSH_DELAY = 1500;
  const CHUNK = 8 * 1024 * 1024;   // subida en partes de 8 MB (múltiplo de 256 KB, como pide Drive)
  const LS_TOKEN = 'mosaico.token', LS_PROJECT = 'mosaico.project', LS_USER = 'mosaico.user';

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  };

  const st = {
    token: null,          // {access_token, expires_at}
    user: ls.get(LS_USER),// {email, name}
    project: ls.get(LS_PROJECT), // {id, name, datosId, archivosId, ordenId, owner}
    phase: 'idle',        // idle | syncing | error | expired | offline
    detail: '',
    lastPull: null,
    running: false,
    timer: null,
    pushTimer: null,
    tokenClient: null,
    listeners: new Set(),
    log: [],              // registro corto de lo que va pasando (se ve en el panel)
  };
  function log(msg) {
    const d = new Date(), hh = n => String(n).padStart(2, '0');
    st.log.push(`${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())} ${msg}`);
    if (st.log.length > 40) st.log.shift();
    console.log('[mosaico]', msg);
  }
  // Si algo no termina nunca, cortarlo con un error que diga qué era.
  function withTimeout(p, ms, what) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('se trabó ' + what)), ms); })]).finally(() => clearTimeout(t));
  }
  const tok = ls.get(LS_TOKEN);
  if (tok && tok.expires_at > Date.now() + 60_000) st.token = tok;

  function emit() { st.listeners.forEach(f => { try { f(state()); } catch (e) { console.error(e); } }); }
  function setPhase(phase, detail = '') {
    if (phase === 'error' || (phase === 'syncing' && detail && !/%/.test(detail))) log((phase === 'error' ? 'Error: ' : '') + detail);
    st.phase = phase; st.detail = detail; emit();
  }
  function state() {
    return {
      configured: !!CLIENT_ID,
      signedIn: !!st.token && st.token.expires_at > Date.now(),
      expired: !!st.user && (!st.token || st.token.expires_at <= Date.now()),
      user: st.user, project: st.project, phase: st.phase, detail: st.detail,
      log: st.log.slice(-15),
    };
  }

  // ---------------- Autenticación (Google Identity Services) ----------------
  function gisReady() {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      (function wait() {
        if (window.google && google.accounts && google.accounts.oauth2) return res();
        if (Date.now() - t0 > 15000) return rej(new Error('no se pudo cargar el inicio de sesión de Google'));
        setTimeout(wait, 100);
      })();
    });
  }
  // Debe llamarse desde un clic (abre la ventanita de Google).
  // En celulares (sobre todo iPhone) la ventanita de Google pierde el contacto con la app,
  // así que ahí la página entera va a Google y vuelve con el permiso en la dirección.
  const useRedirect = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) || navigator.standalone === true;
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const LS_STATE = 'mosaico.oauthState';
  function signInRedirect() {
    const stateTok = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem(LS_STATE, stateTok); localStorage.setItem(LS_STATE, stateTok); } catch { }
    const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: stateTok });
    if (st.user && st.user.email) p.set('login_hint', st.user.email); else p.set('prompt', 'consent');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
    return new Promise(() => { });   // la página se va
  }
  // Al volver de Google: leer el permiso de la dirección (#access_token=…) y limpiarla.
  function takeRedirectResult() {
    if (!/[#&](access_token|error)=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    let expect = null;
    try { expect = sessionStorage.getItem(LS_STATE) || localStorage.getItem(LS_STATE); sessionStorage.removeItem(LS_STATE); localStorage.removeItem(LS_STATE); } catch { }
    if (!expect || h.get('state') !== expect) return { error: 'la respuesta de Google no coincide; probá de nuevo' };
    if (h.get('error')) return { error: h.get('error') === 'access_denied' ? 'no se dio el permiso' : h.get('error') };
    return { access_token: h.get('access_token'), expires_in: +h.get('expires_in') || 3600 };
  }
  async function acceptToken(r) {
    st.token = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 60) * 1000 };
    ls.set(LS_TOKEN, st.token);
    try {
      const about = await api('GET', '/about', { query: { fields: 'user(emailAddress,displayName)' } });
      st.user = { email: about.user.emailAddress, name: about.user.displayName };
      ls.set(LS_USER, st.user);
    } catch (e) { console.error(e); }
    setPhase('idle');
    start();
  }
  async function signIn() {
    if (!CLIENT_ID) throw new Error('Falta configurar el ID de cliente de Google');
    if (useRedirect()) return signInRedirect();
    await gisReady();
    return new Promise((res, rej) => {
      st.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: async r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          await acceptToken(r);
          res(state());
        },
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Se cerró la ventana de Google' : (e && e.message) || 'No se pudo conectar')),
      });
      st.tokenClient.requestAccessToken({ prompt: st.user ? '' : 'consent', hint: st.user && st.user.email });
    });
  }
  function signOut() {
    if (st.token && window.google && google.accounts) { try { google.accounts.oauth2.revoke(st.token.access_token, () => { }); } catch { } }
    st.token = null; st.user = null; st.project = null;
    ls.set(LS_TOKEN, null); ls.set(LS_USER, null); ls.set(LS_PROJECT, null);
    stop(); setPhase('idle');
  }
  const hasToken = () => st.token && st.token.expires_at > Date.now();

  // ---------------- API de Drive ----------------
  class AuthError extends Error { }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtMB = n => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
  // fetch con límite de tiempo: si la conexión se cuelga, se corta y se reintenta en la próxima vuelta.
  async function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); }
    catch (e) {
      const err = new Error(ctl.signal.aborted ? 'la conexión tardó demasiado' : 'sin conexión');
      err.offline = true; throw err;
    } finally { clearTimeout(t); }
  }
  async function api(method, path, { query, body, raw, headers, base = API } = {}) {
    if (!hasToken()) throw new AuthError('sesión vencida');
    const url = new URL(base + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const h = { Authorization: 'Bearer ' + st.token.access_token, ...(headers || {}) };
    let b = body;
    if (body && !(body instanceof Blob) && typeof body !== 'string') { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const res = await fetchT(url, { method, headers: h, body: b }, body instanceof Blob ? 180000 : 60000);
    if (res.status === 401) { st.token = null; ls.set(LS_TOKEN, null); throw new AuthError('sesión vencida'); }
    if (!res.ok) {
      let msg = res.status + '';
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch { }
      const err = new Error('Drive: ' + msg); err.status = res.status; throw err;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }
  async function listAll(q, fields = 'id,name,modifiedTime,appProperties') {
    const out = []; let pageToken;
    do {
      const r = await api('GET', '/files', { query: { q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true } });
      out.push(...r.files); pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function createFolder(name, parent, appProperties) {
    return api('POST', '/files', { query: { fields: 'id,name' }, body: { name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined, appProperties } });
  }
  // Sube un archivo nuevo (multipart si es chico, reanudable si es grande).
  async function uploadNew(meta, blob, onProgress) {
    const type = blob.type || 'application/octet-stream';
    if (blob.size <= 5 * 1024 * 1024) {
      const boundary = 'mosaico' + Math.random().toString(36).slice(2);
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(meta),
        `\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${boundary}--`,
      ]);
      return api('POST', '/files', { base: UPLOAD, query: { uploadType: 'multipart', fields: 'id,modifiedTime' }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
    }
    return putResumable(await startResumable(meta, blob), blob, onProgress);
  }
  async function startResumable(meta, blob) {
    const type = blob.type || 'application/octet-stream';
    const res = await api('POST', '/files', { base: UPLOAD, query: { uploadType: 'resumable', fields: 'id,modifiedTime' }, body: meta, raw: true, headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) } });
    const loc = res.headers.get('Location');
    if (!loc) throw new Error('Drive no devolvió la dirección de subida');
    return loc;
  }
  async function updateContent(fileId, blob) {
    const type = blob.type || 'application/octet-stream';
    if (blob.size <= 5 * 1024 * 1024) {
      return api('PATCH', '/files/' + fileId, { base: UPLOAD, query: { uploadType: 'media', fields: 'id,modifiedTime' }, body: blob, headers: { 'Content-Type': type } });
    }
    const res = await api('PATCH', '/files/' + fileId, { base: UPLOAD, query: { uploadType: 'resumable', fields: 'id,modifiedTime' }, body: {}, raw: true, headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) } });
    return putResumable(res.headers.get('Location'), blob);
  }
  // Rango ya recibido por Drive según la cabecera Range ("bytes=0-1234"); sin cabecera = nada.
  const rangeEnd = res => { const r = res.headers.get('Range'); return r ? +r.split('-')[1] + 1 : null; };
  function sessionGone() { const e = new Error('la subida anterior venció, empieza de nuevo'); e.sessionGone = true; return e; }
  // Pregunta a Drive cuánto de una subida ya llegó.
  async function uploadStatus(location, total) {
    const res = await fetchT(location, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } }, 60000);
    if (res.status === 200 || res.status === 201) return { done: await res.json() };
    if (res.status === 308) return { offset: rangeEnd(res) || 0 };
    if (res.status === 404 || res.status === 410) throw sessionGone();
    throw new Error('Drive: error al consultar la subida (' + res.status + ')');
  }
  // Sube en partes de 8 MB, informa el avance, reintenta cada parte y puede seguir desde `resume`.
  async function putResumable(location, blob, onProgress, resume = false) {
    if (!location) throw new Error('Drive no devolvió la dirección de subida');
    const total = blob.size;
    let offset = 0, fails = 0;
    if (resume) {
      const q = await uploadStatus(location, total);
      if (q.done) return q.done;
      offset = q.offset;
    }
    for (;;) {
      onProgress && onProgress(offset, total);
      const end = Math.min(offset + CHUNK, total);
      let res;
      try {
        res = await fetchT(location, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` }, body: blob.slice(offset, end) }, 300000);
      } catch (e) { res = null; if (++fails > 4) throw e; }
      if (res && (res.status === 200 || res.status === 201)) { onProgress && onProgress(total, total); return res.json(); }
      if (res && res.status === 308) {
        const got = rangeEnd(res);
        offset = got == null ? end : got;
        fails = 0;
        if (offset < total) continue;
        // Drive no confirmó el final: preguntar
        const q = await uploadStatus(location, total);
        if (q.done) return q.done;
        offset = q.offset; continue;
      }
      if (res && (res.status === 404 || res.status === 410)) throw sessionGone();
      if (res && res.status < 500 && res.status !== 429) throw new Error('Drive: error al subir (' + res.status + ')');
      if (res && ++fails > 4) throw new Error('Drive: error al subir (' + res.status + ')');
      // falló la conexión o Drive pidió esperar: esperar un poco y seguir desde lo que llegó
      await sleep(1500 * fails);
      const q = await uploadStatus(location, total);
      if (q.done) return q.done;
      offset = q.offset;
    }
  }
  async function download(fileId, ms = 120000) {
    return withTimeout((async () => {
      const res = await api('GET', '/files/' + fileId, { query: { alt: 'media', supportsAllDrives: true }, raw: true });
      return res.blob();
    })(), ms, 'bajando un archivo de Drive');
  }
  async function downloadJSON(fileId) { return JSON.parse(await (await download(fileId)).text()); }
  const jsonBlob = o => new Blob([JSON.stringify(o)], { type: 'application/json' });
  const trash = id => api('PATCH', '/files/' + id, { query: { supportsAllDrives: true }, body: { trashed: true } }).catch(e => console.warn('no se pudo borrar', id, e));

  // ---------------- Proyecto ----------------
  async function findProjects() {
    const files = await listAll(
      "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='mosaicoProject' and value='1' }",
      'id,name,owners(displayName,emailAddress),modifiedTime');
    return files.map(f => ({ id: f.id, name: f.name, owner: f.owners && f.owners[0] ? (f.owners[0].displayName || f.owners[0].emailAddress) : '' }));
  }
  async function createProject(name = 'Mosaico') {
    const root = await createFolder(name, null, { mosaicoProject: '1' });
    const datos = await createFolder('datos', root.id, { mosaicoRole: 'datos' });
    const archivos = await createFolder('archivos', root.id, { mosaicoRole: 'archivos' });
    const orden = await uploadNew({ name: 'orden.json', parents: [datos.id], appProperties: { mosaicoRole: 'orden' } }, jsonBlob({ order: [], deleted: [] }));
    return useProject({ id: root.id, name, datosId: datos.id, archivosId: archivos.id, ordenId: orden.id, owner: st.user && st.user.name });
  }
  async function openProject(p) {
    const kids = await listAll(`'${esc(p.id)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`);
    const datos = kids.find(k => k.appProperties && k.appProperties.mosaicoRole === 'datos');
    const archivos = kids.find(k => k.appProperties && k.appProperties.mosaicoRole === 'archivos');
    if (!datos || !archivos) throw new Error('La carpeta no parece un proyecto de Mosaico completo');
    const ords = await listAll(`'${esc(datos.id)}' in parents and trashed=false and name='orden.json'`);
    let ordenId = ords[0] && ords[0].id;
    if (!ordenId) ordenId = (await uploadNew({ name: 'orden.json', parents: [datos.id], appProperties: { mosaicoRole: 'orden' } }, jsonBlob({ order: [], deleted: [] }))).id;
    return useProject({ id: p.id, name: p.name, datosId: datos.id, archivosId: archivos.id, ordenId, owner: p.owner });
  }
  async function useProject(p) {
    st.project = p; ls.set(LS_PROJECT, p);
    st.lastPull = null;
    await app.onProjectChanged(p.id);
    emit(); start(); kick(0);
    return p;
  }
  function leaveProject() { st.project = null; ls.set(LS_PROJECT, null); stop(); setPhase('idle'); }
  async function share(email) {
    if (!st.project) throw new Error('No hay proyecto');
    await api('POST', `/files/${st.project.id}/permissions`, {
      query: { sendNotificationEmail: true, emailMessage: 'Te comparto el proyecto de Mosaico para editar la grilla en conjunto.', supportsAllDrives: true },
      body: { role: 'writer', type: 'user', emailAddress: email },
    });
  }
  const folderUrl = () => st.project ? `https://drive.google.com/drive/folders/${st.project.id}` : null;

  // ---------------- Sincronización ----------------
  const metaFields = it => ({ id: it.id, name: it.name, w: it.w, h: it.h, crop: it.crop, adj: it.adj, kind: it.kind || 'image', duration: it.duration, t: it.t });

  function ensureSync(it) {
    const pid = st.project.id;
    if (!it.sync || it.sync.project !== pid) it.sync = { project: pid, media: {}, mediaRev: 0, dirty: true, mediaDirty: false };
    return it.sync;
  }
  async function pushItem(it) {
    const s = ensureSync(it);
    const gen = it._gen || 0;
    const A = st.project.archivosId;
    const props = role => ({ mosaicoId: it.id, mosaicoRole: role });
    const blobs = await app.getBlobs(it.id);
    if (!blobs) return;
    if (!s.media.orig && blobs.orig) {
      setPhase('syncing', 'Subiendo ' + it.name);
      s.media.orig = (await uploadNew({ name: `${it.id}-original.jpg`, parents: [A], appProperties: props('orig') }, blobs.orig,
        (d, t) => setPhase('syncing', `Subiendo ${it.name} · ${Math.floor(d / t * 100)}%`))).id;
      s.media.thumb = (await uploadNew({ name: `${it.id}-miniatura.jpg`, parents: [A], appProperties: props('thumb') }, blobs.thumb)).id;
      s.mediaDirty = false;
      app.persist(it);
    } else if (s.mediaDirty && blobs.orig) {
      setPhase('syncing', 'Subiendo portada de ' + it.name);
      await updateContent(s.media.orig, blobs.orig);
      await updateContent(s.media.thumb, blobs.thumb);
      s.mediaRev = (s.mediaRev || 0) + 1;
      s.mediaDirty = false;
      app.persist(it);
    }
    if (it.kind === 'video' && !s.media.video) {
      const v = await app.getVideo(it.id);
      if (v) {
        const progress = (d, t) => setPhase('syncing', `Subiendo video ${it.name} · ${Math.floor(d / t * 100)}% (${fmtMB(d)} de ${fmtMB(t)})`);
        progress(0, v.size);
        const ext = (it.name.match(/\.(\w+)$/) || [, 'mov'])[1].toLowerCase();
        const meta = { name: `${it.id}-video.${ext}`, parents: [A], appProperties: props('video') };
        let r;
        if (v.size <= 5 * 1024 * 1024) r = await uploadNew(meta, v);
        else {
          // La dirección de subida se guarda: si se corta (o se recarga la página) sigue desde donde quedó.
          let up = s.videoUpload;
          if (up && (up.size !== v.size || Date.now() - up.t > 6 * 864e5)) up = null;
          const resume = !!up;
          if (!up) { up = s.videoUpload = { uri: await startResumable(meta, v), size: v.size, t: Date.now() }; app.persist(it); }
          try { r = await putResumable(up.uri, v, progress, resume); }
          catch (e) { if (e.sessionGone) { s.videoUpload = null; app.persist(it); } throw e; }
        }
        s.media.video = r.id; s.videoUpload = null;
        app.persist(it);
      }
    }
    if (!s.media.orig) return;   // todavía no hay original local (p. ej. llegó de otra persona sin abrir)
    const doc = { ...metaFields(it), media: s.media, mediaRev: s.mediaRev || 0, updatedAt: Date.now(), updatedBy: st.user && st.user.email };
    if (!s.jsonId) {
      const r = await uploadNew({ name: `item-${it.id}.json`, parents: [st.project.datosId], appProperties: { mosaicoId: it.id, mosaicoRole: 'item' } }, jsonBlob(doc));
      s.jsonId = r.id;
    } else {
      await updateContent(s.jsonId, jsonBlob(doc));
    }
    s.remoteUpdatedAt = doc.updatedAt;
    if ((it._gen || 0) === gen) s.dirty = false;   // si se editó mientras subía, queda pendiente
    app.persist(it);
  }

  function mergeOrder(remote, local) {
    const deleted = new Set([...(remote.deleted || []), ...(local.deleted || [])]);
    const keep = id => !deleted.has(id);
    let order;
    if (local.dirty) {
      order = local.order.filter(keep);
      const extra = (remote.order || []).filter(id => keep(id) && !order.includes(id));
      order = [...extra, ...order];
    } else {
      order = (remote.order || []).filter(keep);
      const localOnly = local.order.filter(id => keep(id) && !order.includes(id));
      order = [...localOnly, ...order];
    }
    return { order, deleted: [...deleted] };
  }
  async function pushOrder() {
    const local = app.getOrderState();
    let remote = { order: [], deleted: [] };
    try { remote = await downloadJSON(st.project.ordenId); } catch (e) { if (e instanceof AuthError || e.offline) throw e; }
    const merged = mergeOrder(remote, local);
    await updateContent(st.project.ordenId, jsonBlob({ ...merged, updatedAt: Date.now(), updatedBy: st.user && st.user.email }));
    app.applyOrder(merged.order, merged.deleted, false);
  }

  async function pull() {
    const P = st.project;
    const since = st.lastPull ? new Date(st.lastPull - 5000).toISOString() : null;
    let q = `'${esc(P.datosId)}' in parents and trashed=false`;
    if (since) q += ` and modifiedTime > '${since}'`;
    const files = await listAll(q);
    if (!st.lastPull) log(`En Drive: ${files.filter(f => f.appProperties && f.appProperties.mosaicoRole === 'item').length} publicaciones`);
    let maxT = st.lastPull || 0;
    const total = files.length; let n = 0;
    let orderFile = null;
    const local = new Map(app.listItems().map(it => [it.id, it]));
    const deleted = new Set(app.getOrderState().deleted);
    for (const f of files) {
      n++;
      maxT = Math.max(maxT, Date.parse(f.modifiedTime));
      const role = f.appProperties && f.appProperties.mosaicoRole;
      if (role === 'orden' || f.name === 'orden.json') { orderFile = f; continue; }
      if (role !== 'item') continue;
      const id = f.appProperties.mosaicoId;
      if (deleted.has(id)) continue;
      const it = local.get(id);
      if (it && it.sync && it.sync.dirty) continue;              // mis cambios pendientes ganan
      let doc;
      try { doc = await downloadJSON(f.id); } catch (e) { if (e instanceof AuthError || e.offline) throw e; log('No se pudo leer ' + f.name + ': ' + e.message); continue; }
      if (it && it.sync && it.sync.remoteUpdatedAt === doc.updatedAt) continue;   // es mi propio cambio
      const syncInfo = { project: P.id, jsonId: f.id, media: doc.media || {}, mediaRev: doc.mediaRev || 0, dirty: false, mediaDirty: false, remoteUpdatedAt: doc.updatedAt };
      if (!it) {
        setPhase('syncing', `Bajando ${n} de ${total} · ${doc.name}`);
        if (!doc.media || !doc.media.thumb) { log('Sin miniatura todavía: ' + doc.name); continue; }
        const thumb = await download(doc.media.thumb, 60000);
        await withTimeout(app.addRemoteItem({ ...metaFields(doc), sync: syncInfo }, thumb), 30000, 'guardando ' + doc.name + ' en el teléfono');
      } else {
        const mediaChanged = (doc.mediaRev || 0) > ((it.sync && it.sync.mediaRev) || 0) || !it.sync;
        const thumb = mediaChanged ? await download(doc.media.thumb, 60000) : null;
        await withTimeout(app.updateRemoteItem(it, { ...metaFields(doc), sync: syncInfo }, thumb), 30000, 'actualizando ' + doc.name);
      }
    }
    if (orderFile || !st.lastPull) {
      const remote = await downloadJSON(P.ordenId);
      const localO = app.getOrderState();
      const merged = mergeOrder(remote, localO);
      app.applyOrder(merged.order, merged.deleted, localO.dirty);
    }
    st.lastPull = maxT || Date.now();
  }

  // Una sola pestaña sincroniza a la vez (evita subir lo mismo dos veces).
  function cycle() {
    if (st.running || !st.project) return;
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('mosaico-sync', { ifAvailable: true }, lock => lock ? cycleInner() : null);
    return cycleInner();
  }
  async function cycleInner() {
    if (st.running || !st.project) return;
    if (!hasToken()) { setPhase('expired'); return; }
    if (!navigator.onLine) { setPhase('offline'); return; }
    st.running = true;
    try {
      // 1) subir lo mío
      const pending = app.listItems().filter(it => !it.sync || it.sync.project !== st.project.id || it.sync.dirty || it.sync.mediaDirty || (it.kind === 'video' && !(it.sync.media || {}).video));
      // primero fotos y datos, los videos pesados al final
      pending.sort((a, b) => (a.kind === 'video') - (b.kind === 'video'));
      if (pending.length) log(`Para subir: ${pending.length}`);
      for (const it of pending) { await pushItem(it); }
      if (app.getOrderState().dirty) await pushOrder();
      // 2) traer lo de las demás
      await pull();
      if (st.phase !== 'idle' || !st.lastLoggedIdle) { log('Al día'); st.lastLoggedIdle = true; }
      setPhase('idle', 'Sincronizado');
    } catch (e) {
      console.error(e);
      if (e instanceof AuthError) setPhase('expired');
      else if (e.offline) setPhase('offline');
      else setPhase('error', e.message || String(e));
    } finally { st.running = false; }
  }
  function kick(delay = PUSH_DELAY) {
    clearTimeout(st.pushTimer);
    st.pushTimer = setTimeout(cycle, delay);
  }
  function start() {
    stop();
    if (!st.project) return;
    st.timer = setInterval(() => { if (!document.hidden) cycle(); }, POLL_MS);
    kick(0);
  }
  function stop() { clearInterval(st.timer); clearTimeout(st.pushTimer); st.timer = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.project) kick(200); });
  window.addEventListener('online', () => st.project && kick(200));

  // Bajar archivos pesados sólo cuando hacen falta (al abrir o descargar).
  async function fetchMedia(it, role) {
    if (!it.sync || !it.sync.media || !it.sync.media[role]) throw new Error('Este archivo todavía no está en la nube');
    if (!hasToken()) throw new Error('Conectá Google para bajar el archivo original');
    return download(it.sync.media[role]);
  }
  async function trashItem(it) {
    if (!it.sync || !st.project || it.sync.project !== st.project.id || !hasToken()) return;
    const ids = [it.sync.jsonId, ...Object.values(it.sync.media || {})].filter(Boolean);
    await Promise.all(ids.map(trash));
  }

  const back = takeRedirectResult();
  if (back && back.access_token) acceptToken(back);
  else {
    if (st.project && hasToken()) start();
    else if (st.project && st.user) setPhase('expired');
  }

  return {
    state, onChange(f) { st.listeners.add(f); f(state()); return () => st.listeners.delete(f); },
    signIn, signOut, findProjects, createProject, openProject, leaveProject, share, folderUrl,
    kick, fetchMedia, trashItem, syncNow: () => kick(0),
    fromRedirect: back ? (back.error || 'ok') : null,   // volvimos recién de Google (celulares)
    _mergeOrder: mergeOrder, _putResumable: putResumable,
  };
};
