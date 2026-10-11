/* DriveNotes — Google Drive 上のノートの閲覧と登録（PWA）
 * 保存形式は EvernoteDriveBackup と同じ:
 *   02_Markdown変換_Markdown/<ノートブック>/YYYYMMDD_タイトル.md
 *   03_添付ファイル_Attachments/<ノートブック>/<添付ファイル>
 * Markdown からは ../../03_添付ファイル_Attachments/... の相対リンクで添付を参照する。
 */
'use strict';

const C = window.DRIVENOTES_CONFIG;
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const MD_FOLDER = C.markdownFolderName;
const ATT_FOLDER = C.attachmentsFolderName;
const FIELDS = 'id,name,mimeType,modifiedTime,createdTime,size,parents,webViewLink';
const MD_QUERY = "(mimeType='text/markdown' or mimeType='text/x-markdown')";
const PAGE = 200;

const S = {
  token: null, exp: 0, root: null, nav: 0,
  names: new Map(), parents: new Map(),
  sidebar: null, notebookOptions: null,
  blobs: new Map(),
};

/* ------------------------------------------------------------ 小道具 */
const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d, withTime) {
  const s = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return withTime ? `${s}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` : s;
}
function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
function fmtDate(v) {
  const d = new Date(v);
  if (isNaN(d)) return String(v || '');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtSize(n) {
  n = +n || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
// EvernoteDriveBackup の safe_name と同じ規則
function safeName(name, limit = 80) {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/^\.+|\.+$/g, '');
  return s.slice(0, limit).trim() || '無題';
}
function safeAttName(fileName) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return safeName(stem, 40).replace(/[\s()[\]#%]/g, '_') + ext.replace(/[^\w.]/g, '');
}
function parseName(name) {
  const base = String(name).replace(/\.md$/i, '');
  const m = base.match(/^(\d{4})(\d{2})(\d{2})_(.*)$/);
  if (m) return { date: m[1] === '0000' ? '' : `${m[1]}/${m[2]}/${m[3]}`, title: m[4] || '無題' };
  return { date: '', title: base };
}
function isMd(f) { return /^text\/(x-)?markdown$/.test(f.mimeType) || /\.md$/i.test(f.name); }

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ------------------------------------------------------------ 認証 */
class AuthError extends Error {}
let tokenClient = null;

function loadToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem('dn_token') || 'null');
    if (t && t.exp > Date.now() + 60000) { S.token = t.token; S.exp = t.exp; }
  } catch { /* 保存領域が使えない環境では毎回ログイン */ }
}
function hasToken() { return S.token && Date.now() < S.exp - 30000; }

function waitForGis() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > 15000) return reject(new Error('Googleのログイン部品を読み込めませんでした。通信状況を確認してください。'));
      setTimeout(poll, 100);
    })();
  });
}

async function signIn() {
  await waitForGis();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: C.clientId, scope: SCOPE, callback: () => {} });
  }
  await new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(`ログインできませんでした（${r.error}）`));
      S.token = r.access_token;
      S.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
      S.lastActive = Date.now();
      try { sessionStorage.setItem('dn_token', JSON.stringify({ token: S.token, exp: S.exp })); } catch {}
      resolve();
    };
    tokenClient.error_callback = (e) => reject(new Error(e?.type === 'popup_closed' ? 'ログインが中断されました' : 'ログイン画面を開けませんでした'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/* ------------------------------------------------------------ 自動ログアウト */
// 一定時間操作がなければ、トークン・表示中のノート・画像を破棄してログイン画面に戻す。
// （下書きは端末内に残す。トークンの取り消し（revoke）は DriveClipper と同じ許可を
//   消してしまうため行わず、アプリ内から破棄するだけにする）
const IDLE_MS = (Number(C.autoLogoutMinutes) || 15) * 60 * 1000;
S.lastActive = Date.now();
function signOut(message) {
  S.token = null;
  S.exp = 0;
  try { sessionStorage.removeItem('dn_token'); } catch {}
  for (const url of S.blobs.values()) URL.revokeObjectURL(url);
  S.blobs.clear();
  S.root = null;
  S.names.clear();
  S.parents.clear();
  if (typeof resetCaches === 'function') resetCaches();
  document.querySelector('.relogin')?.remove();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  closeLightbox();
  closeDrawer();
  $('#searchInput').value = '';
  loginView(message);
}
function checkIdle() {
  if (S.token && Date.now() - S.lastActive > IDLE_MS) {
    signOut(`${Math.round(IDLE_MS / 60000)}分間操作がなかったため、自動でログアウトしました。`);
  }
}
['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach((ev) =>
  window.addEventListener(ev, () => { S.lastActive = Date.now(); }, { capture: true, passive: true }));
setInterval(checkIdle, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });

/* ------------------------------------------------------------ Drive API */
async function req(url, opts = {}) {
  if (!hasToken()) throw new AuthError('ログインの有効期限が切れました');
  S.lastActive = Date.now();
  let r;
  try {
    r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${S.token}` } });
  } catch {
    throw new Error('通信できませんでした。電波状況を確認してください。');
  }
  if (r.status === 401) {
    S.token = null;
    try { sessionStorage.removeItem('dn_token'); } catch {}
    throw new AuthError('ログインの有効期限が切れました');
  }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error?.message || ''; } catch {}
    throw new Error(`Google Drive エラー（${r.status}）${msg ? ': ' + msg : ''}`);
  }
  return r;
}
function remember(f) {
  if (!f?.id) return;
  S.names.set(f.id, f.name);
  if (f.parents?.length) S.parents.set(f.id, f.parents[0]);
}
async function listPage(q, { pageSize = PAGE, orderBy, pageToken } = {}) {
  const r = await req(`${DRIVE}/files?` + qs({ q, pageSize, orderBy, pageToken, spaces: 'drive', fields: `nextPageToken,files(${FIELDS})` }));
  const j = await r.json();
  (j.files || []).forEach(remember);
  return { files: j.files || [], next: j.nextPageToken || null };
}
async function listAll(q, opts = {}) {
  const out = [];
  let tok = null;
  do {
    const p = await listPage(q, { ...opts, pageSize: 1000, pageToken: tok });
    out.push(...p.files);
    tok = p.next;
  } while (tok);
  return out;
}
async function getMeta(id) {
  const f = await (await req(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)).json();
  remember(f);
  return f;
}
const getText = async (id) => (await req(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`)).text();
const getBlob = async (id) => (await req(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`)).blob();

async function findChild(parentId, name, { folder } = {}) {
  let q = `'${esc(parentId)}' in parents and name='${esc(name)}' and trashed=false`;
  if (folder) q += ` and mimeType='${FOLDER}'`;
  return (await listPage(q, { pageSize: 10 })).files[0] || null;
}
async function createFolder(parentId, name) {
  const r = await req(`${DRIVE}/files?fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
  });
  const f = await r.json();
  remember(f);
  return f;
}
async function ensureFolder(parentId, name) {
  return (await findChild(parentId, name, { folder: true }))?.id || (await createFolder(parentId, name)).id;
}
async function patchFile(id, { name, trashed, addParents, removeParents } = {}) {
  const body = {};
  if (name != null) body.name = name;
  if (trashed != null) body.trashed = trashed;
  const r = await req(`${DRIVE}/files/${encodeURIComponent(id)}?` + qs({ addParents, removeParents, fields: FIELDS }), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body),
  });
  const f = await r.json();
  remember(f);
  return f;
}
async function updateText(id, text, meta = {}) {
  const b = 'dn' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`,
    text, `\r\n--${b}--`]);
  const r = await req(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${FIELDS}`, {
    method: 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
  });
  const f = await r.json();
  remember(f);
  return f;
}
async function copyFile(id, name, parentId) {
  const r = await req(`${DRIVE}/files/${encodeURIComponent(id)}/copy?fields=${FIELDS}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name, parents: [parentId] }),
  });
  const f = await r.json();
  remember(f);
  return f;
}
function resetCaches() {
  S.sidebar = null;
  S.notebookOptions = null;
  pathCache.clear();
  attCache.clear();
}
const pathCache = new Map();
async function resolveFolderPath(baseId, parts, create = false) {
  let id = baseId;
  let key = baseId;
  for (const part of parts) {
    key += '/' + part;
    if (pathCache.has(key)) { id = pathCache.get(key); continue; }
    const next = create ? await ensureFolder(id, part) : (await findChild(id, part, { folder: true }))?.id;
    if (!next) return null;
    pathCache.set(key, next);
    id = next;
  }
  return id;
}

async function uploadFile(blob, name, parentId, mime, onProgress) {
  mime = mime || 'application/octet-stream';
  const meta = { name, parents: [parentId], mimeType: mime };
  if (blob.size <= 5 * 1024 * 1024) {
    const b = 'dn' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`,
      blob,
      `\r\n--${b}--`,
    ]);
    const r = await req(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
    const f = await r.json();
    remember(f);
    onProgress?.(1);
    return f;
  }
  // 大きなファイルは再開可能アップロード（進捗表示つき）
  const init = await req(`${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
    body: JSON.stringify(meta),
  });
  const location = init.headers.get('Location');
  if (!location) throw new Error('アップロードを開始できませんでした');
  const f = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', location);
    x.setRequestHeader('Content-Type', mime);
    x.upload.onprogress = (e) => { S.lastActive = Date.now(); if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(`アップロードに失敗しました（${x.status}）`)));
    x.onerror = () => reject(new Error('アップロード中に通信が切れました'));
    x.send(blob);
  });
  remember(f);
  return f;
}

/* ------------------------------------------------------------ 保存場所の特定 */
async function discover() {
  if (S.root) return S.root;
  const found = await listPage(`name='${esc(C.rootFolderName)}' and mimeType='${FOLDER}' and trashed=false`, { pageSize: 10 });
  const root = found.files[0];
  if (!root) {
    throw new Error(`「${C.rootFolderName}」フォルダが見つかりません。DriveClippers プロジェクトのアプリで作成したフォルダにだけアクセスできます。`);
  }
  const [md, att] = await Promise.all([findChild(root.id, MD_FOLDER, { folder: true }), findChild(root.id, ATT_FOLDER, { folder: true })]);
  S.root = {
    rootId: root.id,
    mdId: md?.id || (await createFolder(root.id, MD_FOLDER)).id,
    attId: att?.id || (await createFolder(root.id, ATT_FOLDER)).id,
    webclipsId: root.parents?.[0] || null,
  };
  S.names.set(S.root.mdId, 'Evernote');
  return S.root;
}

/* ------------------------------------------------------------ 画面の骨組み */
const main = () => $('#main');
function setMain(...nodes) {
  const m = main();
  m.replaceChildren(...nodes);
  m.scrollTop = 0;
  window.scrollTo(0, 0);
}
function loadingView(text = '読み込み中…') {
  setMain(h('div', { class: 'state' }, h('div', { class: 'spinner' }), h('p', {}, text)));
}
function errorView(err, retry) {
  setMain(h('div', { class: 'state error' },
    h('h2', {}, 'うまく表示できませんでした'),
    h('p', {}, err.message || String(err)),
    retry && h('button', { class: 'btn', onclick: retry }, '再試行')));
}
function loginView(message) {
  $('#fab').hidden = true;
  $('#sidebar').replaceChildren();
  setMain(h('div', { class: 'login' },
    h('img', { src: 'icon-192.png', alt: '', width: 72, height: 72 }),
    h('h1', {}, 'DriveNotes'),
    h('p', {}, 'Google Drive に保存した Evernote バックアップと WebClips を閲覧し、新しいノートを登録します。'),
    message && h('p', { class: 'notice' }, message),
    h('button', {
      class: 'btn primary large',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await signIn(); route(); } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      },
    }, 'Google でログイン'),
    h('p', { class: 'fine' }, `アクセス範囲は DriveClippers のアプリが作成したファイルと、取り込み時に選んだファイルだけです（drive.file）。${Math.round(IDLE_MS / 60000)}分間操作がないと自動でログアウトします。`)));
}
function reloginBanner() {
  if ($('.relogin')) return;
  const bar = h('div', { class: 'relogin' },
    h('span', {}, 'ログインの有効期限（約1時間）が切れました。'),
    h('button', {
      class: 'btn primary small',
      onclick: async () => {
        try { await signIn(); bar.remove(); route(); } catch (err) { toast(err.message); }
      },
    }, '再ログイン'));
  document.body.append(bar);
}
function handleError(err, retry) {
  if (err instanceof AuthError) {
    if (!S.root) return loginView(err.message);
    reloginBanner();
    return;
  }
  console.error(err);
  errorView(err, retry);
}

/* ------------------------------------------------------------ サイドバー */
function openDrawer() { document.body.classList.add('drawer-open'); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }

async function loadSidebarData(force) {
  if (S.sidebar && !force) return S.sidebar;
  const { mdId, webclipsId, rootId } = S.root;
  const [notebooks, clips] = await Promise.all([
    listAll(`'${mdId}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' }),
    webclipsId
      ? listAll(`'${webclipsId}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name desc' }).catch(() => [])
      : Promise.resolve([]),
  ]);
  if (webclipsId && !S.names.has(webclipsId)) S.names.set(webclipsId, 'WebClips');
  S.sidebar = { notebooks, clips: clips.filter((f) => f.id !== rootId) };
  return S.sidebar;
}
function renderSidebar() {
  const nav = $('#sidebar');
  const current = location.hash;
  const item = (f) => h('a', { href: `#/f/${f.id}`, class: current === `#/f/${f.id}` ? 'active' : null }, folderIcon(), h('span', {}, f.name));
  const data = S.sidebar || { notebooks: [], clips: [] };
  nav.replaceChildren(
    h('a', { href: '#/', class: `home ${current === '#/' || current === '' ? 'active' : ''}` }, homeIcon(), h('span', {}, 'ホーム')),
    h('a', { href: '#/new', class: 'new-note' }, plusIcon(), h('span', {}, '新しいノート')),
    h('a', { href: '#/import', class: current === '#/import' ? 'active' : null }, clipIcon(), h('span', {}, 'Drive から取り込み')),
    h('a', { href: '#', class: 'create-nb', onclick: (e) => { e.preventDefault(); closeDrawer(); createNotebookDialog(); } }, folderIcon(), h('span', {}, 'ノートブックを作成')),
    h('div', { class: 'nav-head' }, h('span', {}, 'Evernote ノートブック'),
      h('button', { class: 'link-btn', title: '一覧を更新', onclick: async () => { await loadSidebarData(true); S.notebookOptions = null; renderSidebar(); toast('一覧を更新しました'); } }, '更新')),
    ...data.notebooks.map(item),
    data.clips.length ? h('div', { class: 'nav-head' }, h('span', {}, 'WebClips')) : null,
    ...data.clips.map(item));
}
const svg = (d) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('width', '18'); el.setAttribute('height', '18'); el.setAttribute('aria-hidden', 'true');
  el.innerHTML = d;
  return el;
};
const folderIcon = () => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8"/>');
const noteIcon = () => svg('<path d="M6 3h9l4 4v14H6z M15 3v4h4 M9 12h7 M9 16h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
const homeIcon = () => svg('<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
const plusIcon = () => svg('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>');
const clipIcon = () => svg('<path d="M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');

/* ------------------------------------------------------------ 一覧の部品 */
function noteRow(f, showFolder) {
  const { date, title } = parseName(f.name);
  if (!isMd(f) && f.mimeType !== FOLDER) {
    return h('a', { class: 'row file', href: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, target: '_blank', rel: 'noopener' },
      clipIcon(), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, f.name), h('div', { class: 'row-sub' }, fmtSize(f.size))));
  }
  const parentName = showFolder ? S.names.get(S.parents.get(f.id)) : null;
  return h('a', { class: 'row', href: `#/n/${f.id}` },
    noteIcon(),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, title),
      h('div', { class: 'row-sub' }, [date || fmtDate(f.modifiedTime), parentName].filter(Boolean).join(' ・ '))));
}
function folderRow(f) {
  return h('a', { class: 'row folder', href: `#/f/${f.id}` }, folderIcon(), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, f.name)));
}
async function fillParentNames(files) {
  const ids = [...new Set(files.map((f) => S.parents.get(f.id)).filter((id) => id && !S.names.has(id)))];
  await Promise.all(ids.slice(0, 30).map((id) => getMeta(id).catch(() => null)));
}

/* ------------------------------------------------------------ ホーム */
async function viewHome(nav) {
  loadingView();
  const recent = await listPage(`${MD_QUERY} and trashed=false`, { pageSize: 30, orderBy: 'modifiedTime desc' });
  await fillParentNames(recent.files);
  if (nav !== S.nav) return;
  const nbs = S.sidebar?.notebooks || [];
  setMain(h('section', { class: 'page' },
    h('h1', { class: 'page-title' }, 'ホーム'),
    h('div', { class: 'quick' },
      h('a', { class: 'btn primary', href: '#/new' }, plusIcon(), ' 新しいノート'),
      h('a', { class: 'btn', href: '#/import' }, clipIcon(), ' Drive から取り込み'),
      h('button', { class: 'btn', onclick: () => createNotebookDialog() }, folderIcon(), ' ノートブックを作成'),
      h('button', { class: 'btn only-mobile', onclick: openDrawer }, folderIcon(), ' ノートブック')),
    h('h2', { class: 'sec' }, '最近更新したノート'),
    recent.files.length ? h('div', { class: 'list' }, recent.files.map((f) => noteRow(f, true))) : h('p', { class: 'muted' }, 'ノートがまだありません。'),
    nbs.length ? h('h2', { class: 'sec' }, 'Evernote ノートブック') : null,
    nbs.length ? h('div', { class: 'grid' }, nbs.map((f) => h('a', { class: 'tile', href: `#/f/${f.id}` }, folderIcon(), h('span', {}, f.name)))) : null));
}

/* ------------------------------------------------------------ フォルダ（ノートブック） */
async function breadcrumbs(id) {
  const crumbs = [];
  const stops = new Set([S.root.mdId, S.root.webclipsId]);
  let cur = id;
  for (let i = 0; i < 6 && cur; i++) {
    if (!S.names.has(cur) || (!S.parents.has(cur) && !stops.has(cur))) await getMeta(cur).catch(() => null);
    crumbs.unshift({ id: cur, name: S.names.get(cur) || '…' });
    if (stops.has(cur)) break;
    cur = S.parents.get(cur);
  }
  return crumbs;
}
function crumbBar(crumbs) {
  return h('nav', { class: 'crumbs', 'aria-label': '現在地' },
    h('a', { href: '#/' }, 'ホーム'),
    crumbs.map((c, i) => [h('span', { class: 'sep' }, '›'),
      i === crumbs.length - 1 ? h('span', {}, c.name) : h('a', { href: c.id === S.root.mdId ? '#/' : `#/f/${c.id}` }, c.name)]));
}

async function viewFolder(id, nav, params) {
  loadingView();
  const filter = params.get('q') || '';
  const [crumbs, subfolders, first] = await Promise.all([
    breadcrumbs(id),
    listAll(`'${esc(id)}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' }),
    filter
      ? listPage(`'${esc(id)}' in parents and fullText contains '${esc(filter)}' and mimeType!='${FOLDER}' and trashed=false`, { pageSize: PAGE })
      : listPage(`'${esc(id)}' in parents and mimeType!='${FOLDER}' and trashed=false`, { pageSize: PAGE, orderBy: 'name desc' }),
  ]);
  if (nav !== S.nav) return;
  const name = S.names.get(id) || 'フォルダ';
  const list = h('div', { class: 'list' }, subfolders.map(folderRow), first.files.map((f) => noteRow(f)));
  const count = h('span', { class: 'count' });
  let shown = first.files.length;
  let next = first.next;
  const more = h('button', { class: 'btn more', hidden: !next }, 'さらに読み込む');
  const updateCount = () => { count.textContent = `${shown}${next ? '+' : ''} 件`; more.hidden = !next; };
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const page = filter
        ? await listPage(`'${esc(id)}' in parents and fullText contains '${esc(filter)}' and mimeType!='${FOLDER}' and trashed=false`, { pageSize: PAGE, pageToken: next })
        : await listPage(`'${esc(id)}' in parents and mimeType!='${FOLDER}' and trashed=false`, { pageSize: PAGE, orderBy: 'name desc', pageToken: next });
      list.append(...page.files.map((f) => noteRow(f)));
      shown += page.files.length;
      next = page.next;
      updateCount();
    } catch (err) { handleError(err); toast(err.message); }
    more.disabled = false;
  });
  updateCount();
  const filterForm = h('form', { class: 'filter', onsubmit: (e) => {
    e.preventDefault();
    const v = e.currentTarget.elements.q.value.trim();
    location.hash = `#/f/${id}` + (v ? `?q=${encodeURIComponent(v)}` : '');
  } },
  h('input', { name: 'q', type: 'search', value: filter, placeholder: `「${name}」内を検索`, enterkeyhint: 'search' }));
  const isNotebook = S.parents.get(id) === S.root.mdId;
  const inEvernote = crumbs[0]?.id === S.root.mdId && id !== S.root.mdId;
  setMain(h('section', { class: 'page' },
    crumbBar(crumbs.slice(1)),
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, name), count,
      h('div', { class: 'head-actions' },
        inEvernote ? h('button', { class: 'btn small', onclick: () => renameNotebookDialog(id, crumbs.slice(1).map((c) => c.name)) }, '名前を変更') : null,
        isNotebook ? h('a', { class: 'btn small', href: `#/new?nb=${id}` }, plusIcon(), ' このノートブックに追加') : null)),
    filterForm,
    filter ? h('p', { class: 'muted' }, `「${filter}」の検索結果（関連度順）`, ' ', h('a', { href: `#/f/${id}` }, '解除')) : null,
    list,
    !subfolders.length && !first.files.length ? h('p', { class: 'muted' }, 'ノートはありません。') : null,
    more));
}

/* ------------------------------------------------------------ ノート表示 */
function parseFrontMatter(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    try { val = JSON.parse(val); } catch { val = val.replace(/^["']|["']$/g, ''); }
    fm[key] = val;
  }
  return { fm, body: text.slice(m[0].length) };
}
function attPath(url) {
  if (!url) return null;
  let d = url;
  try { d = decodeURIComponent(url); } catch {}
  const i = d.indexOf(ATT_FOLDER + '/');
  return i < 0 ? null : d.slice(i + ATT_FOLDER.length + 1);
}
function renderMarkdown(md) {
  const html = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
  const tpl = document.createElement('template'); // template 内では画像の読み込みが走らない
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const p = attPath(src);
    if (p) {
      img.removeAttribute('src');
      img.dataset.att = p;
      img.classList.add('att-img', 'pending');
    } else if (!/^(https?:|data:)/i.test(src)) {
      img.removeAttribute('src');
    }
    img.setAttribute('loading', 'lazy');
  });
  tpl.content.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const p = attPath(href);
    if (p) {
      a.dataset.att = p;
      a.setAttribute('href', '#');
      a.classList.add('att-link');
    } else if (/^https?:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
  return document.importNode(tpl.content, true);
}

const attCache = new Map();
// 添付は「ノートが今いるノートブック」の添付フォルダから探す。
// 見つからなければ本文に記録されたパス（作成時のノートブック名）で探す。
// これにより、ノートブック名を変えても本文を書き換えずに画像を表示できる。
function resolveAtt(path, nbParts = []) {
  const key = nbParts.join('/') + '|' + path;
  if (!attCache.has(key)) {
    attCache.set(key, (async () => {
      const parts = path.split('/');
      const name = parts.pop();
      if (nbParts.length) {
        const cur = await resolveFolderPath(S.root.attId, nbParts);
        const f = cur && await findChild(cur, name);
        if (f) return f;
      }
      if (parts.join('/') === nbParts.join('/')) return null;
      const folderId = await resolveFolderPath(S.root.attId, parts);
      return folderId ? findChild(folderId, name) : null;
    })().catch((e) => { attCache.delete(key); throw e; }));
  }
  return attCache.get(key);
}
async function loadImage(img, nbParts) {
  try {
    const f = await resolveAtt(img.dataset.att, nbParts);
    if (!f) throw new Error('missing');
    let url = S.blobs.get(f.id);
    if (!url) {
      url = URL.createObjectURL(await getBlob(f.id));
      S.blobs.set(f.id, url);
    }
    img.src = url;
    img.classList.remove('pending');
    img.addEventListener('click', () => openLightbox(url, f));
  } catch (err) {
    img.classList.remove('pending');
    img.classList.add('missing');
    img.alt = '画像を読み込めませんでした';
    if (err instanceof AuthError) reloginBanner();
  }
}
function wireAttachments(container, nbParts) {
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); loadImage(e.target, nbParts); } }), { rootMargin: '600px' })
    : null;
  container.querySelectorAll('img[data-att]').forEach((img) => (io ? io.observe(img) : loadImage(img, nbParts)));
  container.querySelectorAll('a[data-att]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const w = window.open('about:blank', '_blank');
    try {
      const f = await resolveAtt(a.dataset.att, nbParts);
      if (!f) throw new Error('添付ファイルが見つかりません');
      const link = f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;
      if (w) w.location.href = link; else location.href = link;
    } catch (err) {
      w?.close();
      if (err instanceof AuthError) reloginBanner(); else toast(err.message);
    }
  }));
}
function openLightbox(url, f) {
  const lb = $('#lightbox');
  lb.replaceChildren(
    h('img', { src: url, alt: f.name }),
    h('div', { class: 'lb-bar' },
      h('span', {}, f.name),
      h('a', { href: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, target: '_blank', rel: 'noopener' }, 'Driveで開く'),
      h('button', { class: 'btn small', onclick: closeLightbox }, '閉じる')));
  lb.hidden = false;
  lb.onclick = (e) => { if (e.target === lb || e.target.tagName === 'IMG') closeLightbox(); };
}
function closeLightbox() { $('#lightbox').hidden = true; }

async function viewNote(id, nav) {
  loadingView();
  const [meta, text] = await Promise.all([getMeta(id), getText(id)]);
  const crumbs = await breadcrumbs(S.parents.get(id));
  if (nav !== S.nav) return;
  const { fm, body } = parseFrontMatter(text);
  const { date, title } = parseName(meta.name);
  const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? String(fm.tags).split(/[,、]/) : []);
  const content = h('div', { class: 'md' });
  content.append(renderMarkdown(body));
  const parentId = S.parents.get(id);
  const nbParts = crumbs[0]?.id === S.root.mdId ? crumbs.slice(1).map((c) => c.name) : [];
  setMain(h('article', { class: 'page note' },
    crumbBar(crumbs.slice(1)),
    h('h1', { class: 'note-title' }, fm.title || title),
    h('div', { class: 'note-meta' },
      h('span', {}, fm.created ? `作成 ${fmtDate(fm.created)}` : date),
      fm.updated && fm.updated !== fm.created ? h('span', {}, `更新 ${fmtDate(fm.updated)}`) : null,
      fm.source_url ? h('a', { href: fm.source_url, target: '_blank', rel: 'noopener noreferrer' }, '元のページ') : null,
      h('a', { href: meta.webViewLink || `https://drive.google.com/file/d/${id}/view`, target: '_blank', rel: 'noopener' }, 'Driveで開く')),
    tags.length ? h('div', { class: 'tags' }, tags.map((t) => h('span', { class: 'tag' }, String(t).trim()))) : null,
    h('div', { class: 'note-tools' },
      h('button', { class: 'btn small', onclick: () => renameNoteDialog(meta, text) }, 'タイトル変更'),
      h('button', { class: 'btn small', onclick: () => moveNoteDialog(meta, text, nbParts) }, '移動'),
      h('button', { class: 'btn small danger', onclick: () => deleteNoteDialog(meta) }, '削除')),
    content,
    h('div', { class: 'note-foot' },
      parentId ? h('a', { class: 'btn', href: `#/f/${parentId}` }, '← 一覧に戻る') : null,
      parentId && S.parents.get(parentId) === S.root.mdId ? h('a', { class: 'btn', href: `#/new?nb=${parentId}` }, plusIcon(), ' 同じノートブックに追加') : null)));
  wireAttachments(content, nbParts);
}

/* ------------------------------------------------------------ 検索 */
async function viewSearch(q, nav) {
  $('#searchInput').value = q;
  if (!q) return setMain(h('section', { class: 'page' }, h('h1', { class: 'page-title' }, '検索'), h('p', { class: 'muted' }, '上の検索欄にキーワードを入力してください。')));
  loadingView('検索中…');
  const res = await listPage(`fullText contains '${esc(q)}' and ${MD_QUERY} and trashed=false`, { pageSize: 100 });
  await fillParentNames(res.files);
  if (nav !== S.nav) return;
  setMain(h('section', { class: 'page' },
    h('h1', { class: 'page-title' }, `「${q}」の検索結果`),
    h('p', { class: 'muted' }, `${res.files.length}${res.next ? '+' : ''} 件（本文・タイトルを関連度順で表示）`),
    res.files.length ? h('div', { class: 'list' }, res.files.map((f) => noteRow(f, true))) : h('p', {}, '見つかりませんでした。')));
}

/* ------------------------------------------------------------ 登録 */
async function notebookOptions() {
  if (S.notebookOptions) return S.notebookOptions;
  const tops = S.sidebar?.notebooks || (await loadSidebarData()).notebooks;
  const opts = [];
  // スタック（子フォルダを持つフォルダ）は展開する
  const subs = await Promise.all(tops.map((f) => listAll(`'${f.id}' in parents and mimeType='${FOLDER}' and trashed=false`, { orderBy: 'name' }).catch(() => [])));
  tops.forEach((f, i) => {
    opts.push({ id: f.id, label: f.name, parts: [f.name] });
    subs[i].forEach((s) => opts.push({ id: s.id, label: `${f.name} / ${s.name}`, parts: [f.name, s.name] }));
  });
  S.notebookOptions = opts;
  return opts;
}

/* 共有（Android の共有メニュー／iPhone のショートカット）から受け取った内容 */
const SHARE_CACHE = 'drivenotes-share';
async function readShared() {
  try {
    const c = await caches.open(SHARE_CACHE);
    const m = await c.match(new URL('share/meta', document.baseURI).href);
    if (!m) return null;
    const meta = await m.json();
    const files = [];
    for (let i = 0; i < meta.count; i++) {
      const r = await c.match(new URL(`share/file/${i}`, document.baseURI).href);
      if (!r) continue;
      const b = await r.blob();
      files.push(new File([b], decodeURIComponent(r.headers.get('x-file-name') || `file${i + 1}`), { type: b.type || r.headers.get('content-type') || '' }));
    }
    return { ...meta, files };
  } catch {
    return null;
  }
}
async function clearShared() { try { await caches.delete(SHARE_CACHE); } catch {} }
function normalizeShared(sh) {
  let { title = '', text = '', url = '' } = sh;
  text = String(text).trim();
  if (!url) {
    const m = text.match(/https?:\/\/\S+/);
    if (m) { url = m[0]; text = text.replace(m[0], '').trim(); }
  }
  if (!/^https?:\/\//i.test(url)) url = '';
  if (!title && text) title = text.split(/\r?\n/)[0].slice(0, 60);
  if (!title && url) { try { title = new URL(url).hostname; } catch {} }
  return { title: String(title).trim(), text, url, files: sh.files || [] };
}

const DRAFT_KEY = 'dn_draft';
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; } }
function writeDraft(d) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {} }

async function shrinkImage(file, maxPx) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  if (scale >= 1) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

async function viewNew(nav, params) {
  loadingView('ノートブックを準備中…');
  const opts = await notebookOptions();
  if (nav !== S.nav) return;
  let shared = null;
  if (params.get('shared') === '1') shared = await readShared();
  else if (params.get('url') || params.get('text') || params.get('title')) {
    shared = { title: params.get('title') || '', text: params.get('text') || '', url: params.get('url') || '', files: [] };
  }
  if (shared) shared = normalizeShared(shared);
  if (nav !== S.nav) return;
  const savedDraft = readDraft();
  const draft = shared ? { nb: savedDraft.nb, resize: savedDraft.resize, title: shared.title, body: [shared.text, shared.url ? `[元のページ](${shared.url})` : ''].filter(Boolean).join('\n\n') } : savedDraft;
  const preferred = params.get('nb') || draft.nb || localStorage.getItem('dn_last_nb');
  const files = [];
  const sourceUrl = shared?.url || '';

  const select = h('select', { name: 'nb', required: true },
    opts.map((o) => h('option', { value: o.id, selected: o.id === preferred }, o.label)),
    h('option', { value: '__new__' }, '＋ 新しいノートブックを作る'));
  const newNb = h('input', { name: 'newnb', type: 'text', placeholder: '新しいノートブック名', hidden: true, maxlength: 60 });
  select.addEventListener('change', () => { newNb.hidden = select.value !== '__new__'; if (!newNb.hidden) newNb.focus(); saveDraft(); });

  const title = h('input', { name: 'title', type: 'text', placeholder: 'タイトル', value: draft.title || '', maxlength: 120, autocomplete: 'off' });
  const body = h('textarea', { name: 'body', rows: 10, placeholder: '本文（Markdown が使えます）' });
  body.value = draft.body || '';
  const tags = h('input', { name: 'tags', type: 'text', placeholder: 'タグ（カンマ区切り）', value: draft.tags || '', autocomplete: 'off' });
  const resize = h('input', { type: 'checkbox', name: 'resize', checked: draft.resize ?? false });

  const thumbs = h('div', { class: 'thumbs' });
  const renderThumbs = () => {
    thumbs.replaceChildren(...files.map((f, i) => h('div', { class: 'thumb' },
      f.type.startsWith('image/') ? h('img', { src: f._url, alt: '' }) : h('div', { class: 'file-ico' }, clipIcon(), h('span', {}, (f.name.split('.').pop() || '').toUpperCase())),
      h('div', { class: 'thumb-name' }, f.name),
      h('div', { class: 'thumb-size' }, fmtSize(f.size)),
      h('button', { type: 'button', class: 'thumb-del', 'aria-label': '削除', onclick: () => { URL.revokeObjectURL(f._url); files.splice(i, 1); renderThumbs(); } }, '×'))));
  };
  const addFiles = (list) => {
    for (const f of list) { f._url = URL.createObjectURL(f); files.push(f); }
    renderThumbs();
  };
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });

  const status = h('div', { class: 'progress', hidden: true }, h('div', { class: 'bar' }, h('i')), h('p', {}));
  const setProgress = (ratio, text) => {
    status.hidden = false;
    status.querySelector('i').style.width = `${Math.round(ratio * 100)}%`;
    status.querySelector('p').textContent = text;
  };

  function saveDraft() {
    writeDraft({ nb: select.value === '__new__' ? '' : select.value, title: title.value, body: body.value, tags: tags.value, resize: resize.checked });
  }
  [title, body, tags, resize].forEach((el) => el.addEventListener('input', saveDraft));

  const submit = h('button', { class: 'btn primary large', type: 'submit' }, '保存');
  const form = h('form', { class: 'editor', onsubmit: async (e) => {
    e.preventDefault();
    if (!title.value.trim() && !body.value.trim() && !files.length) return toast('タイトル・本文・添付のいずれかを入力してください');
    submit.disabled = true;
    try {
      let opt = opts.find((o) => o.id === select.value);
      if (select.value === '__new__') {
        const name = safeName(newNb.value, 60);
        if (!newNb.value.trim()) throw new Error('新しいノートブック名を入力してください');
        opt = { id: null, label: name, parts: [name] };
      }
      const saved = await saveNote({ opt, title: title.value.trim(), body: body.value, tags: tags.value, files, resize: resize.checked, onProgress: setProgress, sourceUrl });
      clearShared();
      files.forEach((f) => URL.revokeObjectURL(f._url));
      localStorage.removeItem(DRAFT_KEY);
      localStorage.setItem('dn_last_nb', saved.notebookId);
      toast('保存しました');
      location.hash = `#/n/${saved.file.id}`;
    } catch (err) {
      submit.disabled = false;
      status.hidden = true;
      if (err instanceof AuthError) { reloginBanner(); toast('再ログイン後にもう一度「保存」を押してください（入力内容は残っています）', 6000); }
      else toast(err.message, 6000);
    }
  } },
  h('label', { class: 'field' }, h('span', {}, 'ノートブック'), select, newNb),
  h('label', { class: 'field' }, h('span', {}, 'タイトル'), title),
  h('label', { class: 'field' }, h('span', {}, '本文'), body),
  h('div', { class: 'field' }, h('span', {}, '写真・添付ファイル'),
    h('div', { class: 'attach-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => camera.click() }, '写真を撮る'),
      h('button', { type: 'button', class: 'btn', onclick: () => picker.click() }, 'ファイルを選ぶ')),
    camera, picker, thumbs,
    h('label', { class: 'check' }, resize, h('span', {}, `写真を縮小して保存する（長辺 ${C.resizeMaxPx}px）`))),
  h('label', { class: 'field' }, h('span', {}, 'タグ'), tags),
  status,
  h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: () => history.back() }, 'キャンセル')));

  // ドラッグ＆ドロップ・貼り付け（PC）
  form.addEventListener('dragover', (e) => { e.preventDefault(); form.classList.add('drop'); });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (e) => { e.preventDefault(); form.classList.remove('drop'); addFiles(e.dataTransfer.files); });
  form.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });

  if (shared?.files.length) addFiles(shared.files);
  setMain(h('section', { class: 'page' },
    h('h1', { class: 'page-title' }, '新しいノート'),
    shared ? h('p', { class: 'shared-note' }, '共有された内容を読み込みました。ノートブックを選んで「保存」してください。') : null,
    params.get('shared') === 'error' ? h('p', { class: 'shared-note' }, '共有された内容を受け取れませんでした。もう一度共有してください。') : null,
    form));
  if (!draft.title && !draft.body) title.focus({ preventScroll: true });
}

async function saveNote({ opt, title, body, tags, files, resize, onProgress, sourceUrl }) {
  const now = new Date();
  const parts = opt.parts;
  onProgress(0, '保存先を準備しています…');
  const nbId = opt.id || await resolveFolderPath(S.root.mdId, parts, true);
  const attId = files.length ? await resolveFolderPath(S.root.attId, parts, true) : null;
  const up = '../'.repeat(parts.length + 1);
  const ts = stamp(now, true);
  const links = [];
  const total = files.reduce((s, f) => s + f.size, 0) || 1;
  let done = 0;
  for (const [i, original] of files.entries()) {
    const isImage = original.type.startsWith('image/');
    const file = resize && isImage ? await shrinkImage(original, C.resizeMaxPx) : original;
    const fname = `${ts}_${pad(i + 1)}_${safeAttName(file.name)}`;
    await uploadFile(file, fname, attId, file.type || 'application/octet-stream', (r) => {
      onProgress((done + original.size * r) / total * 0.95, `添付をアップロード中 ${i + 1}/${files.length}：${original.name}`);
    });
    done += original.size;
    const rel = `${up}${ATT_FOLDER}/${[...parts, fname].join('/')}`.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const label = original.name.replace(/[[\]]/g, '');
    links.push(isImage ? `![${label}](${rel})` : `[📎 ${label}](${rel})`);
  }
  onProgress(0.97, 'ノートを保存中…');
  const tagList = tags.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
  const iso = isoLocal(now);
  const fm = ['---',
    `title: ${JSON.stringify(title || '無題')}`,
    `notebook: ${JSON.stringify(parts[parts.length - 1])}`,
    `created: ${JSON.stringify(iso)}`,
    `updated: ${JSON.stringify(iso)}`,
    `tags: ${JSON.stringify(tagList)}`,
    sourceUrl ? `source_url: ${JSON.stringify(sourceUrl)}` : null,
    'source: "DriveNotes"',
    '---', ''].filter((l) => l != null).join('\n');
  const md = fm + body.trim() + (links.length ? (body.trim() ? '\n\n' : '') + links.join('\n\n') : '') + '\n';
  let name = `${stamp(now)}_${safeName(title || '無題')}.md`;
  if (await findChild(nbId, name)) name = name.replace(/\.md$/, `_${ts.slice(8)}.md`);
  const file = await uploadFile(new Blob([md], { type: 'text/markdown' }), name, nbId, 'text/markdown');
  onProgress(1, '完了');
  if (!opt.id) { S.sidebar = null; S.notebookOptions = null; }
  return { file, notebookId: nbId };
}

/* ------------------------------------------------------------ 整理（タイトル変更・移動・削除・ノートブック名変更） */
const FM_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ATT_LINK_RE = new RegExp(`\\]\\(([^)\\s]*${ATT_FOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^)\\s]*)\\)`, 'g');
const encPath = (s) => s.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

// フロントマターの値を書き換える（無ければ何もしない）
function setFrontMatter(text, updates) {
  const m = text.match(FM_RE);
  if (!m) return text;
  const lines = m[1].split(/\r?\n/);
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}: ${JSON.stringify(v)}`;
    const i = lines.findIndex((l) => l.startsWith(k + ':'));
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  return `---\n${lines.join('\n')}\n---\n` + text.slice(m[0].length);
}
const datePrefix = (name) => (name.match(/^(\d{8})_/) || [])[0] || '';

// 汎用ダイアログ（入力欄・選択肢・確認）
function openDialog({ title, message, fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg' });
    const status = h('p', { class: 'dlg-status', hidden: true });
    const form = h('form', { method: 'dialog' },
      h('h2', {}, title),
      message ? h('p', { class: 'muted' }, message) : null,
      fields,
      status,
      h('div', { class: 'actions' },
        h('button', { class: `btn ${danger ? 'danger-fill' : 'primary'}`, value: 'ok' }, ok),
        h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'キャンセル')));
    dlg.append(form);
    document.body.append(dlg);
    const api = {
      busy(text) {
        status.hidden = false;
        status.textContent = text;
        form.querySelectorAll('button,input,select').forEach((el) => { el.disabled = true; });
      },
      close() { dlg.close(); dlg.remove(); },
    };
    form.addEventListener('submit', (e) => {
      const v = e.submitter?.value;
      if (v !== 'ok') { api.close(); resolve(null); return; }
      e.preventDefault();
      resolve({ data: new FormData(form), ...api });
    });
    dlg.addEventListener('cancel', () => { api.close(); resolve(null); });
    dlg.showModal();
    form.querySelector('input,select')?.focus();
  });
}
async function runAction(res, label, fn) {
  try {
    res.busy(label);
    await fn();
    res.close();
  } catch (err) {
    res.close();
    if (err instanceof AuthError) reloginBanner();
    toast(err.message || String(err), 6000);
  }
}

// 1. タイトル変更: ファイル名（日付部分は維持）とフロントマターの title を変更
async function renameNoteDialog(meta, text) {
  const { title } = parseName(meta.name);
  const input = h('input', { name: 'title', type: 'text', value: parseFrontMatter(text).fm.title || title, required: true, maxlength: 120 });
  const res = await openDialog({ title: 'タイトル変更', fields: [h('label', { class: 'field' }, h('span', {}, '新しいタイトル'), input)], ok: '変更' });
  if (!res) return;
  const newTitle = String(res.data.get('title') || '').trim();
  if (!newTitle) { res.close(); return; }
  await runAction(res, '変更中…', async () => {
    const parentId = S.parents.get(meta.id);
    const name = `${datePrefix(meta.name)}${safeName(newTitle)}.md`;
    if (name !== meta.name) {
      const dup = await findChild(parentId, name);
      if (dup && dup.id !== meta.id) throw new Error('同じノートブックに同じ名前のノートがあります');
    }
    const newText = setFrontMatter(text, { title: newTitle, updated: isoLocal(new Date()) });
    if (newText !== text) await updateText(meta.id, newText, { name });
    else await patchFile(meta.id, { name });
    toast('タイトルを変更しました');
    route();
  });
}

// 2. 移動: 添付は移動先へ「複製」（同じ添付を他のノートが共有している場合があるため元は残す）
async function moveNoteDialog(meta, text, fromParts) {
  const opts = await notebookOptions();
  const curId = S.parents.get(meta.id);
  const select = h('select', { name: 'to', required: true },
    opts.filter((o) => o.id !== curId).map((o) => h('option', { value: o.id }, o.label)),
    h('option', { value: '__new__' }, '＋ 新しいノートブックを作る'));
  const newNb = h('input', { name: 'newnb', type: 'text', placeholder: '新しいノートブック名', hidden: true, maxlength: 60 });
  select.addEventListener('change', () => { newNb.hidden = select.value !== '__new__'; });
  const res = await openDialog({
    title: 'ノートを移動',
    message: '写真などの添付ファイルも一緒に移動先へコピーします。',
    fields: [h('label', { class: 'field' }, h('span', {}, '移動先のノートブック'), select, newNb)],
    ok: '移動',
  });
  if (!res) return;
  let to = opts.find((o) => o.id === res.data.get('to'));
  if (res.data.get('to') === '__new__') {
    const n = String(res.data.get('newnb') || '').trim();
    if (!n) { res.close(); toast('新しいノートブック名を入力してください'); return; }
    to = { id: null, label: safeName(n, 60), parts: [safeName(n, 60)] };
  }
  await runAction(res, '移動の準備中…', async () => {
    const toNbId = to.id || await resolveFolderPath(S.root.mdId, to.parts, true);
    // 添付を移動先へ複製
    const paths = [...new Set([...text.matchAll(ATT_LINK_RE)].map((m) => attPath(m[1])).filter(Boolean))];
    let toAttId = null;
    for (const [i, p] of paths.entries()) {
      res.busy(`添付ファイルをコピー中 ${i + 1}/${paths.length}`);
      const f = await resolveAtt(p, fromParts);
      if (!f) continue;
      toAttId = toAttId || await resolveFolderPath(S.root.attId, to.parts, true);
      if (!(await findChild(toAttId, f.name))) await copyFile(f.id, f.name, toAttId);
    }
    // 本文のリンクを移動先ノートブックに合わせて書き換え
    res.busy('ノートを移動中…');
    const prefix = encPath(`${'../'.repeat(to.parts.length + 1)}${ATT_FOLDER}/${to.parts.join('/')}/`);
    let newText = text.replace(ATT_LINK_RE, (all, link) => `](${prefix}${link.split('/').pop()})`);
    newText = setFrontMatter(newText, { notebook: to.parts[to.parts.length - 1], updated: isoLocal(new Date()) });
    let name = meta.name;
    if (await findChild(toNbId, name)) name = name.replace(/\.md$/i, `_${stamp(new Date(), true).slice(8)}.md`);
    if (newText !== text || name !== meta.name) await updateText(meta.id, newText, { name });
    await patchFile(meta.id, { addParents: toNbId, removeParents: (meta.parents || [curId]).join(',') });
    resetCaches();
    toast(`「${to.label}」へ移動しました`);
    if (location.hash === `#/n/${meta.id}`) route(); else location.hash = `#/n/${meta.id}`;
  });
}

// ノートブックの作成（本文用フォルダを作る。添付用は最初の添付保存時に自動作成）
async function createNotebookDialog() {
  const input = h('input', { name: 'name', type: 'text', required: true, maxlength: 60, placeholder: '例：医療' });
  const res = await openDialog({
    title: 'ノートブックを作成',
    fields: [h('label', { class: 'field' }, h('span', {}, 'ノートブック名'), input)],
    ok: '作成',
  });
  if (!res) return;
  const name = safeName(String(res.data.get('name') || '').trim(), 60);
  if (!String(res.data.get('name') || '').trim()) { res.close(); return; }
  await runAction(res, '作成中…', async () => {
    if (await findChild(S.root.mdId, name, { folder: true })) throw new Error(`「${name}」というノートブックは既にあります`);
    const f = await createFolder(S.root.mdId, name);
    resetCaches();
    await loadSidebarData();
    toast(`ノートブック「${name}」を作成しました`);
    location.hash = `#/f/${f.id}`;
  });
}

// 4. 削除: Drive のゴミ箱へ（30日以内なら Drive から復元可能）
async function deleteNoteDialog(meta) {
  const { title } = parseName(meta.name);
  const res = await openDialog({
    title: 'ノートを削除',
    message: `「${title}」を Google Drive のゴミ箱へ移動します。30日以内なら Drive のゴミ箱から元に戻せます。添付ファイルは他のノートと共有されている場合があるため残します。`,
    ok: '削除', danger: true,
  });
  if (!res) return;
  await runAction(res, '削除中…', async () => {
    const parentId = S.parents.get(meta.id);
    await patchFile(meta.id, { trashed: true });
    toast('ゴミ箱へ移動しました');
    location.hash = parentId ? `#/f/${parentId}` : '#/';
  });
}

// 3. ノートブック名変更: 本文用(02)と添付用(03)のフォルダ名を両方変更
async function renameNotebookDialog(folderId, parts) {
  const oldName = parts[parts.length - 1];
  const input = h('input', { name: 'name', type: 'text', value: oldName, required: true, maxlength: 60 });
  const res = await openDialog({ title: 'ノートブック名を変更', fields: [h('label', { class: 'field' }, h('span', {}, '新しい名前'), input)], ok: '変更' });
  if (!res) return;
  const newName = safeName(String(res.data.get('name') || '').trim(), 60);
  if (!newName || newName === oldName) { res.close(); return; }
  await runAction(res, '変更中…', async () => {
    const mdParent = S.parents.get(folderId);
    if (await findChild(mdParent, newName, { folder: true })) throw new Error(`「${newName}」というノートブックは既にあります`);
    const attFolder = await resolveFolderPath(S.root.attId, parts);
    let attParent = null;
    if (attFolder) {
      attParent = await resolveFolderPath(S.root.attId, parts.slice(0, -1));
      if (await findChild(attParent, newName, { folder: true })) throw new Error(`添付フォルダに「${newName}」が既にあるため変更できません`);
    }
    await patchFile(folderId, { name: newName });
    if (attFolder) await patchFile(attFolder, { name: newName });
    resetCaches();
    toast('ノートブック名を変更しました');
    route();
  });
}

/* ------------------------------------------------------------ Drive からの取り込み（1ファイル＝1ノート） */
const GOOGLE_DOC = 'application/vnd.google-apps.document';
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('ファイル選択画面を読み込めませんでした'));
    document.head.append(s);
  });
}
async function pickDriveFiles() {
  if (!C.pickerApiKey) {
    throw new Error('ファイル選択画面の設定（APIキー）がまだ登録されていません。説明書の「取り込みの準備」をご覧ください。');
  }
  if (!hasToken()) throw new AuthError('ログインの有効期限が切れました');
  if (!window.gapi) await loadScript('https://apis.google.com/js/api.js');
  if (!window.gapi?.load) throw new Error('ファイル選択画面を読み込めませんでした。通信状況を確認してください。');
  await new Promise((resolve, reject) => gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('ファイル選択画面を読み込めませんでした')) }));
  return new Promise((resolve) => {
    const P = google.picker;
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
    const picker = new P.PickerBuilder()
      .setAppId(C.appId)
      .setOAuthToken(S.token)
      .setDeveloperKey(C.pickerApiKey)
      .setLocale('ja')
      .setTitle('取り込むファイルを選択（複数選択できます）')
      .addView(view)
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setCallback((d) => {
        if (d.action === P.Action.PICKED) resolve(d.docs.map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType })));
        else if (d.action === P.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}
async function exportFile(id, mime, asText) {
  const r = await req(`${DRIVE}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`);
  return asText ? r.text() : r.blob();
}

async function importOne(file, ctx, index) {
  const meta = await getMeta(file.id);
  const when = new Date(meta.createdTime || meta.modifiedTime || Date.now());
  const dot = meta.name.lastIndexOf('.');
  const title = (dot > 0 && !meta.mimeType.startsWith('application/vnd.google-apps') ? meta.name.slice(0, dot) : meta.name).trim() || '無題';
  const attName = (n) => `${ctx.ts}_${pad(index + 1, 3)}_${safeAttName(n)}`;
  const linkTo = (n) => encPath(`${'../'.repeat(ctx.parts.length + 1)}${ATT_FOLDER}/${[...ctx.parts, n].join('/')}`);
  const ensureAtt = async () => (ctx.attId = ctx.attId || await resolveFolderPath(S.root.attId, ctx.parts, true));
  let body = '';
  if (meta.mimeType === GOOGLE_DOC) {
    // Google ドキュメントは本文として取り込む（Markdown 変換、できなければテキスト）
    body = await exportFile(meta.id, 'text/markdown', true).catch(() => exportFile(meta.id, 'text/plain', true));
  } else if (/^text\/(plain|markdown|x-markdown)$/.test(meta.mimeType) || /\.(txt|md)$/i.test(meta.name)) {
    body = await getText(meta.id);
  } else if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
    // スプレッドシート等は PDF にして添付
    const pdf = await exportFile(meta.id, 'application/pdf', false);
    const n = attName(`${safeName(meta.name, 60)}.pdf`);
    await uploadFile(pdf, n, await ensureAtt(), 'application/pdf');
    body = `[📎 ${meta.name}.pdf](${linkTo(n)})`;
  } else {
    // PDF・写真などは Drive 上でそのままコピー（端末への読み込み不要）
    const n = attName(meta.name);
    await copyFile(meta.id, n, await ensureAtt());
    const label = meta.name.replace(/[[\]]/g, '');
    body = meta.mimeType.startsWith('image/') ? `![${label}](${linkTo(n)})` : `[📎 ${label}](${linkTo(n)})`;
  }
  const fm = ['---',
    `title: ${JSON.stringify(title)}`,
    `notebook: ${JSON.stringify(ctx.parts[ctx.parts.length - 1])}`,
    `created: ${JSON.stringify(isoLocal(when))}`,
    `updated: ${JSON.stringify(isoLocal(new Date()))}`,
    'tags: ["取り込み"]',
    meta.webViewLink ? `source_url: ${JSON.stringify(meta.webViewLink)}` : null,
    'source: "Drive取り込み"',
    '---', ''].filter((l) => l != null).join('\n');
  let name = `${stamp(when)}_${safeName(title)}.md`;
  if (await findChild(ctx.nbId, name)) name = name.replace(/\.md$/i, `_${pad(index + 1, 3)}.md`);
  return uploadFile(new Blob([fm + body.trim() + '\n'], { type: 'text/markdown' }), name, ctx.nbId, 'text/markdown');
}

async function viewImport(nav) {
  loadingView('ノートブックを準備中…');
  const opts = await notebookOptions();
  if (nav !== S.nav) return;
  const select = h('select', { name: 'nb' },
    opts.map((o) => h('option', { value: o.id }, o.label)),
    h('option', { value: '__new__', selected: true }, '＋ 新しいノートブックを作る'));
  const newNb = h('input', { type: 'text', placeholder: '新しいノートブック名（例：医療）', maxlength: 60 });
  select.addEventListener('change', () => { newNb.hidden = select.value !== '__new__'; });
  const results = h('div', { class: 'list import-list' });
  const summary = h('p', { class: 'muted' });
  const pickBtn = h('button', { class: 'btn primary large', type: 'button' }, 'Google Drive からファイルを選ぶ');
  pickBtn.addEventListener('click', async () => {
    let opt = opts.find((o) => o.id === select.value);
    if (select.value === '__new__') {
      const n = newNb.value.trim();
      if (!n) { toast('取り込み先のノートブック名を入力してください'); newNb.focus(); return; }
      opt = { id: null, label: safeName(n, 60), parts: [safeName(n, 60)] };
    }
    pickBtn.disabled = true;
    try {
      const files = await pickDriveFiles();
      if (!files.length) return;
      const ctx = { parts: opt.parts, nbId: opt.id || await resolveFolderPath(S.root.mdId, opt.parts, true), attId: null, ts: stamp(new Date(), true) };
      if (!opt.id) { resetCaches(); await loadSidebarData(); renderSidebar(); }
      results.replaceChildren();
      let ok = 0;
      for (const [i, f] of files.entries()) {
        const row = h('div', { class: 'row' }, noteIcon(),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, f.name), h('div', { class: 'row-sub' }, '取り込み中…')));
        results.append(row);
        summary.textContent = `${i + 1} / ${files.length} 件目を取り込み中…`;
        try {
          const note = await importOne(f, ctx, i);
          ok++;
          row.replaceWith(h('a', { class: 'row', href: `#/n/${note.id}` }, noteIcon(),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, parseName(note.name).title), h('div', { class: 'row-sub ok' }, '✓ 取り込み完了'))));
        } catch (err) {
          if (err instanceof AuthError) { reloginBanner(); row.querySelector('.row-sub').textContent = '中断（再ログイン後にもう一度選んでください）'; break; }
          row.querySelector('.row-sub').textContent = `✗ ${err.message}`;
          row.querySelector('.row-sub').classList.add('ng');
        }
      }
      summary.replaceChildren(`${ok} / ${files.length} 件を「${opt.label}」に取り込みました。元のファイルはそのまま残っています。 `,
        h('a', { href: `#/f/${ctx.nbId}` }, 'ノートブックを開く'));
    } catch (err) {
      if (err instanceof AuthError) reloginBanner(); else toast(err.message, 7000);
    } finally {
      pickBtn.disabled = false;
    }
  });
  setMain(h('section', { class: 'page' },
    h('h1', { class: 'page-title' }, 'Drive から取り込み'),
    h('p', { class: 'muted' }, 'Google Drive にある PDF・写真・メモなどを選ぶと、1ファイルずつノートとして取り込みます。元のファイルは移動・変更しません。'),
    h('div', { class: 'editor' },
      h('label', { class: 'field' }, h('span', {}, '取り込み先のノートブック'), select, newNb),
      h('div', { class: 'actions' }, pickBtn)),
    summary,
    results));
}

/* ------------------------------------------------------------ ルーター */
async function route() {
  const nav = ++S.nav;
  closeDrawer();
  closeLightbox();
  for (const url of S.blobs.values()) URL.revokeObjectURL(url);
  S.blobs.clear();
  if (!hasToken()) return loginView();
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const seg = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  $('#fab').hidden = seg[0] === 'new';
  try {
    if (!S.root) { loadingView('Google Drive に接続中…'); await discover(); }
    if (!S.sidebar) await loadSidebarData();
    renderSidebar();
    if (seg[0] === 'f' && seg[1]) await viewFolder(seg[1], nav, params);
    else if (seg[0] === 'n' && seg[1]) await viewNote(seg[1], nav);
    else if (seg[0] === 'new') await viewNew(nav, params);
    else if (seg[0] === 'search') await viewSearch(params.get('q') || '', nav);
    else if (seg[0] === 'import') await viewImport(nav);
    else await viewHome(nav);
  } catch (err) {
    if (nav === S.nav) handleError(err, route);
  }
}

$('#menuBtn').addEventListener('click', () => (document.body.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
$('#scrim').addEventListener('click', closeDrawer);
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  location.hash = `#/search?q=${encodeURIComponent(q)}`;
  $('#searchInput').blur();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeLightbox(); closeDrawer(); } });
window.addEventListener('hashchange', route);

loadToken();
route();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
