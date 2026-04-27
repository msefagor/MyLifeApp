// drive-sync.js v1 — Pure Google Drive senkron katmanı (Firebase yok!)
//
// =============================================================================
//  KONFİGÜRASYON — TEK DEĞİŞTİRİLECEK YER
//  CLIENT_ID'yi Google Cloud Console'dan kopyala:
//    APIs & Services → Credentials → OAuth 2.0 Client IDs → "Web client"
//    Format: 1234567890-abcdefg.apps.googleusercontent.com
// =============================================================================
const GOOGLE_CLIENT_ID    = '184551882274-PUT_YOUR_OAUTH_WEB_CLIENT_ID_HERE.apps.googleusercontent.com';
const GOOGLE_API_KEY      = 'AIzaSyCNlJXeTLUd5BSrNv0ihJj8s4jzjGm3tBU';
const GOOGLE_APP_ID       = '184551882274'; // Cloud project number
const ALLOWED_EMAIL       = 'muhammedsefagor@gmail.com';
//
// =============================================================================
//  Sayfa entegrasyonu (mevcut db-sync.js ile aynı kontrat):
//    <script>window.SYNC_KEYS = ['namazTakipData_v2'];</script>
//    <script type="module" src="./drive-sync.js?v=1"></script>
//
//  HTML, 'dbsynced' event'i dinleyerek bulutdan veri gelince UI'yi yeniler.
// =============================================================================

console.log('[drive-sync] v1 yükleniyor… UA=', navigator.userAgent.slice(0, 80));
window.__dbSyncLoading = true;

// =============================================================================
//  DOMAIN MAPPING — hangi localStorage anahtarları hangi Drive dosyasına gider
// =============================================================================
const DOMAINS = {
    namaz:     { file: 'namaz.json',     keys: ['namazTakipData_v2'] },
    notlar:    { file: 'notlar.json',    keys: ['glassProTasks'] },
    kitap:     { file: 'kitap.json',     keys: ['liquid_lib_pro_v1'] },
    yatirim:   { file: 'yatirim.json',   keys: ['liquid_trader_db_v3', 'liquid_trader_settings_v3'] },
    ingilizce: { file: 'ingilizce.json', prefixes: ['eng_day_', 'eng_done_'] }
};
const SESSION_FILE = '_session.json';
const NEVER_SYNC_PREFIXES = ['101_v', 'devam_', '_dbsync_'];

// LocalStorage'da saklanan ayarlar (Drive'a YÜKLENMEZ)
const LS_FOLDER_ID    = '_dbsync_folder_id';
const LS_FOLDER_NAME  = '_dbsync_folder_name';
const LS_FILE_IDS     = '_dbsync_file_ids';      // { domain: fileId }
const LS_DEVICE_ID    = '_dbsync_device_id';
const LS_USER_EMAIL   = '_dbsync_user_email';
const LS_LAST_PULL    = '_dbsync_last_pull';     // { domain: timestamp }

// =============================================================================
//  HANGİ ANAHTAR HANGİ DOMAIN'E AİT?
// =============================================================================
function keyToDomain(key) {
    if (!key) return null;
    for (const pref of NEVER_SYNC_PREFIXES) {
        if (key.startsWith(pref)) return null;
    }
    for (const [domain, def] of Object.entries(DOMAINS)) {
        if (def.keys && def.keys.includes(key)) return domain;
        if (def.prefixes && def.prefixes.some(p => key.startsWith(p))) return domain;
    }
    return null;
}

// Bu sayfa hangi domain'leri kullanıyor? (window.SYNC_KEYS / SYNC_PREFIXES'ten)
function pageDomains() {
    const domains = new Set();
    const keys = Array.isArray(window.SYNC_KEYS) ? window.SYNC_KEYS : [];
    const prefixes = Array.isArray(window.SYNC_PREFIXES) ? window.SYNC_PREFIXES : [];
    for (const k of keys) {
        const d = keyToDomain(k);
        if (d) domains.add(d);
    }
    for (const p of prefixes) {
        for (const [domain, def] of Object.entries(DOMAINS)) {
            if (def.prefixes && def.prefixes.includes(p)) domains.add(domain);
        }
    }
    return [...domains];
}

// =============================================================================
//  DEVICE ID & SESSION ID
// =============================================================================
function getDeviceId() {
    let id = window.localStorage.getItem(LS_DEVICE_ID);
    if (!id) {
        id = (navigator.userAgent.includes('iPhone') ? 'iPhone-' :
              navigator.userAgent.includes('iPad') ? 'iPad-' :
              navigator.userAgent.includes('Mac') ? 'Mac-' :
              navigator.userAgent.includes('Android') ? 'Android-' : 'Web-')
              + Math.random().toString(36).slice(2, 8);
        window.localStorage.setItem(LS_DEVICE_ID, id);
    }
    return id;
}
const DEVICE_ID = getDeviceId();
const SESSION_ID = Math.random().toString(36).slice(2, 10) + '-' + Date.now();

// =============================================================================
//  STATUS BADGE (sağ üstteki nokta)
// =============================================================================
let statusEl = null;
function ensureStatusBadge() {
    if (statusEl || !document.body) return;
    statusEl = document.createElement('div');
    statusEl.id = '__dbsync_status__';
    statusEl.style.cssText = 'position:fixed;top:max(env(safe-area-inset-top),12px);right:12px;width:10px;height:10px;border-radius:50%;background:#888;z-index:99998;box-shadow:0 0 6px rgba(0,0,0,0.5);transition:background 0.3s;cursor:pointer;';
    statusEl.title = 'Drive sync durumu';
    document.body.appendChild(statusEl);
}
function setStatus(state, msg) {
    if (!statusEl) ensureStatusBadge();
    if (!statusEl) return;
    const colors = { idle: '#888', syncing: '#f1c40f', ok: '#2ecc71', warn: '#3498db', error: '#e74c3c' };
    statusEl.style.background = colors[state] || '#888';
    if (msg) statusEl.title = msg;
}

// =============================================================================
//  GIS + GAPI SCRIPT YÜKLEYİCİLER
// =============================================================================
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src; s.async = true; s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script yüklenemedi: ' + src));
        document.head.appendChild(s);
    });
}

let _gisReady = false, _gapiReady = false, _pickerReady = false;

async function ensureGIS() {
    if (_gisReady) return;
    await loadScript('https://accounts.google.com/gsi/client');
    // GIS eşitle
    for (let i = 0; i < 100; i++) {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
            _gisReady = true;
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('GIS yüklenemedi (timeout)');
}

async function ensureGAPI() {
    if (_gapiReady) return;
    await loadScript('https://apis.google.com/js/api.js');
    for (let i = 0; i < 100; i++) {
        if (window.gapi && typeof window.gapi.load === 'function') {
            _gapiReady = true;
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('gapi yüklenemedi (timeout)');
}

async function ensurePicker() {
    if (_pickerReady) return;
    await ensureGAPI();
    await new Promise((resolve, reject) => {
        window.gapi.load('picker', { callback: resolve, onerror: reject });
    });
    for (let i = 0; i < 100; i++) {
        if (window.google && window.google.picker) {
            _pickerReady = true;
            return;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('Picker yüklenemedi (timeout)');
}

// =============================================================================
//  AUTH STATE
// =============================================================================
let _accessToken = null;
let _accessTokenExp = 0;
let _userEmail = window.localStorage.getItem(LS_USER_EMAIL) || null;
let _tokenClient = null;

function tokenValid() {
    return _accessToken && Date.now() < _accessTokenExp - 60_000; // 1dk buffer
}

async function ensureTokenClient() {
    await ensureGIS();
    if (_tokenClient) return _tokenClient;

    if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('PUT_YOUR_OAUTH')) {
        throw new Error('drive-sync.js içinde GOOGLE_CLIENT_ID henüz ayarlanmamış. KURULUM-DRIVE.md\'yi okuyun.');
    }

    _tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
        prompt: '',  // varsayılan; ilk girişte requestAccessToken({prompt:'consent'})
        callback: () => {} // requestAccessToken her seferinde override edecek
    });
    return _tokenClient;
}

/**
 * Google ile giriş yap. İlk seferinde popup ile consent alır,
 * sonraki çağrılarda silent refresh yapar.
 */
async function requestToken({ interactive = true, forceConsent = false } = {}) {
    const client = await ensureTokenClient();
    return new Promise((resolve, reject) => {
        client.callback = async (resp) => {
            if (resp.error) {
                reject(new Error('Google auth: ' + (resp.error_description || resp.error)));
                return;
            }
            _accessToken = resp.access_token;
            _accessTokenExp = Date.now() + (resp.expires_in || 3600) * 1000;

            // Email'i çek (whitelist kontrolü)
            try {
                const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
                    headers: { 'Authorization': 'Bearer ' + _accessToken }
                });
                if (r.ok) {
                    const u = await r.json();
                    _userEmail = u.email || null;
                    if (_userEmail) window.localStorage.setItem(LS_USER_EMAIL, _userEmail);
                }
            } catch (_) {}

            if (_userEmail && _userEmail !== ALLOWED_EMAIL) {
                _accessToken = null; _accessTokenExp = 0;
                window.localStorage.removeItem(LS_USER_EMAIL);
                _userEmail = null;
                alert('Bu uygulamayı sadece ' + ALLOWED_EMAIL + ' kullanabilir. Yanlış hesap: ' + (resp.email || ''));
                reject(new Error('Yetkisiz email'));
                return;
            }

            resolve(_accessToken);
        };
        client.requestAccessToken({
            prompt: forceConsent ? 'consent' : (interactive ? '' : 'none'),
            hint: ALLOWED_EMAIL
        });
    });
}

async function ensureToken() {
    if (tokenValid()) return _accessToken;
    // Sessiz refresh dene
    try {
        return await requestToken({ interactive: false });
    } catch (_) {
        // Sessiz başarısız → kullanıcıdan tetikleme bekle
        throw new Error('Token süresi doldu, tekrar giriş gerekli');
    }
}

function signOut() {
    if (window.google && _accessToken) {
        try { window.google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (_) {}
    }
    _accessToken = null;
    _accessTokenExp = 0;
    _userEmail = null;
    window.localStorage.removeItem(LS_USER_EMAIL);
    setStatus('warn', 'Çıkış yapıldı');
    dispatchAuthState();
}

function dispatchAuthState() {
    const detail = {
        signedIn: !!_accessToken && !!_userEmail,
        email: _userEmail,
        device: DEVICE_ID,
        folderId: window.localStorage.getItem(LS_FOLDER_ID),
        folderName: window.localStorage.getItem(LS_FOLDER_NAME)
    };
    window.dispatchEvent(new CustomEvent('dbauthstate', { detail }));
}

// =============================================================================
//  DRIVE PICKER — kullanıcı klasör seçer
// =============================================================================
async function pickFolder() {
    await ensureToken();
    await ensurePicker();
    return new Promise((resolve, reject) => {
        try {
            const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
                .setIncludeFolders(true)
                .setSelectFolderEnabled(true)
                .setMimeTypes('application/vnd.google-apps.folder');

            const picker = new window.google.picker.PickerBuilder()
                .setAppId(GOOGLE_APP_ID)
                .setOAuthToken(_accessToken)
                .setDeveloperKey(GOOGLE_API_KEY)
                .addView(view)
                .setTitle('MyLifeApp verilerinin kaydedileceği klasörü seç')
                .setCallback((data) => {
                    const action = data[window.google.picker.Response.ACTION];
                    if (action === window.google.picker.Action.PICKED) {
                        const docs = data[window.google.picker.Response.DOCUMENTS];
                        if (docs && docs.length) {
                            const f = docs[0];
                            window.localStorage.setItem(LS_FOLDER_ID, f.id);
                            window.localStorage.setItem(LS_FOLDER_NAME, f.name || 'MyLifeApp');
                            window.localStorage.removeItem(LS_FILE_IDS); // file id cache reset
                            resolve({ id: f.id, name: f.name });
                            return;
                        }
                    }
                    if (action === window.google.picker.Action.CANCEL) {
                        reject(new Error('Klasör seçimi iptal edildi'));
                        return;
                    }
                })
                .build();
            picker.setVisible(true);
        } catch (e) {
            reject(e);
        }
    });
}

// =============================================================================
//  DRIVE REST API HELPER'LARI
// =============================================================================
async function driveListFolderFiles(folderId) {
    await ensureToken();
    const q = `'${folderId}' in parents and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&pageSize=100`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _accessToken } });
    if (!r.ok) throw new Error('Drive list failed: ' + r.status + ' ' + await r.text());
    const j = await r.json();
    return j.files || [];
}

async function driveDownloadJSON(fileId) {
    await ensureToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _accessToken } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Drive download failed: ' + r.status);
    const text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {
        console.warn('[drive-sync] JSON parse hatası, dosya bozuk:', fileId);
        return null;
    }
}

async function driveUploadJSON({ fileId = null, folderId, name, content }) {
    await ensureToken();
    const boundary = '-------drive-sync-' + Math.random().toString(36).slice(2);
    const metadata = fileId ? { name } : { name, parents: [folderId] };
    const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) + `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(content) + `\r\n` +
        `--${boundary}--`;

    const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;

    const r = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
            'Authorization': 'Bearer ' + _accessToken,
            'Content-Type': 'multipart/related; boundary="' + boundary + '"'
        },
        body
    });
    if (!r.ok) throw new Error('Drive upload failed: ' + r.status + ' ' + await r.text());
    return await r.json();
}

async function driveDeleteFile(fileId) {
    await ensureToken();
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + _accessToken }
    });
    if (!r.ok && r.status !== 404) throw new Error('Drive delete failed: ' + r.status);
}

// =============================================================================
//  FILE ID CACHE — dosya id'lerini her seferinde aramamak için
// =============================================================================
function getFileIdCache() {
    try { return JSON.parse(window.localStorage.getItem(LS_FILE_IDS) || '{}'); } catch (_) { return {}; }
}
function setFileIdCache(cache) {
    window.localStorage.setItem(LS_FILE_IDS, JSON.stringify(cache));
}

async function resolveFileId(folderId, name) {
    const cache = getFileIdCache();
    if (cache[name]) return cache[name];
    // Drive'da ara
    const files = await driveListFolderFiles(folderId);
    for (const f of files) cache[f.name] = f.id;
    setFileIdCache(cache);
    return cache[name] || null;
}

// =============================================================================
//  PUSH (yerel → Drive) — bir domain'i Drive'a yaz
// =============================================================================
const _pushTimers = {};
const PUSH_DEBOUNCE_MS = 3000;
let _suppressPush = false;

function collectDomainData(domain) {
    const def = DOMAINS[domain];
    const data = {};
    if (def.keys) {
        for (const k of def.keys) {
            const v = window.localStorage.getItem(k);
            if (v != null) data[k] = v;
        }
    }
    if (def.prefixes) {
        for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (!k) continue;
            if (def.prefixes.some(p => k.startsWith(p))) {
                data[k] = window.localStorage.getItem(k);
            }
        }
    }
    return data;
}

async function pushDomain(domain) {
    if (_suppressPush) return;
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId || !tokenValid()) return;
    const def = DOMAINS[domain];
    if (!def) return;

    setStatus('syncing', 'Yükleniyor: ' + domain);
    try {
        const payload = {
            _meta: {
                version: 1,
                domain,
                device: DEVICE_ID,
                email: _userEmail,
                updatedAt: Date.now(),
                updatedAtIso: new Date().toISOString()
            },
            data: collectDomainData(domain)
        };
        const fileId = await resolveFileId(folderId, def.file);
        const result = await driveUploadJSON({ fileId, folderId, name: def.file, content: payload });
        // Cache'e kaydet
        const cache = getFileIdCache();
        cache[def.file] = result.id;
        setFileIdCache(cache);
        // Last pull timestamp'ini güncelle (kendi yazdığımızı tekrar pull etmeyelim)
        const lp = JSON.parse(window.localStorage.getItem(LS_LAST_PULL) || '{}');
        lp[domain] = payload._meta.updatedAt;
        window.localStorage.setItem(LS_LAST_PULL, JSON.stringify(lp));
        setStatus('ok', 'Senkronize ✓');
        console.log('[drive-sync] push ✓', domain, def.file);
    } catch (e) {
        console.error('[drive-sync] push hatası', domain, e);
        setStatus('error', 'Hata: ' + (e.message || e));
    }
}

function schedulePush(domain) {
    if (!domain) return;
    if (_pushTimers[domain]) clearTimeout(_pushTimers[domain]);
    _pushTimers[domain] = setTimeout(() => {
        delete _pushTimers[domain];
        pushDomain(domain).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
}

// =============================================================================
//  PULL (Drive → yerel) — bir domain'i indir, localStorage'a uygula
// =============================================================================
async function pullDomain(domain) {
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId || !tokenValid()) return false;
    const def = DOMAINS[domain];
    if (!def) return false;

    try {
        const fileId = await resolveFileId(folderId, def.file);
        if (!fileId) return false;
        const remote = await driveDownloadJSON(fileId);
        if (!remote || !remote.data) return false;

        // Bizim son yazdığımızdan eskiyse atla (dosya bizimkinden eski)
        const lp = JSON.parse(window.localStorage.getItem(LS_LAST_PULL) || '{}');
        if (lp[domain] && remote._meta && remote._meta.updatedAt &&
            remote._meta.updatedAt < lp[domain]) {
            console.log('[drive-sync] pull skip (yerel daha yeni):', domain);
            return false;
        }

        // localStorage'a uygula (push tetikleme!)
        _suppressPush = true;
        try {
            // Önce domain'in mevcut anahtarlarını temizle (silinmiş key'leri yansıtmak için)
            if (def.prefixes) {
                const toDelete = [];
                for (let i = 0; i < window.localStorage.length; i++) {
                    const k = window.localStorage.key(i);
                    if (k && def.prefixes.some(p => k.startsWith(p))) toDelete.push(k);
                }
                for (const k of toDelete) {
                    if (!(k in remote.data)) window.localStorage.removeItem(k);
                }
            }
            // Sonra yeni değerleri yaz
            for (const [k, v] of Object.entries(remote.data)) {
                window.localStorage.setItem(k, v);
            }
        } finally {
            _suppressPush = false;
        }

        lp[domain] = remote._meta ? remote._meta.updatedAt : Date.now();
        window.localStorage.setItem(LS_LAST_PULL, JSON.stringify(lp));
        console.log('[drive-sync] pull ✓', domain, 'cihaz=' + (remote._meta && remote._meta.device));
        return true;
    } catch (e) {
        console.error('[drive-sync] pull hatası', domain, e);
        return false;
    }
}

async function pullAllForPage() {
    const domains = pageDomains();
    if (!domains.length) return;
    setStatus('syncing', 'İndiriliyor…');
    let any = false;
    for (const d of domains) {
        const ok = await pullDomain(d);
        if (ok) any = true;
    }
    if (any) {
        // HTML'e haber ver — UI yenilensin
        window.dispatchEvent(new CustomEvent('dbsynced', { detail: { domains } }));
    }
    setStatus('ok', any ? 'Güncel ✓' : 'Hazır');
}

// =============================================================================
//  LOCALSTORAGE PROXY — set/remove yakalanır → push tetiklenir
// =============================================================================
const _origSetItem = Storage.prototype.setItem;
const _origRemoveItem = Storage.prototype.removeItem;
Storage.prototype.setItem = function (key, value) {
    _origSetItem.call(this, key, value);
    if (this === window.localStorage && !_suppressPush) {
        const domain = keyToDomain(key);
        if (domain) schedulePush(domain);
    }
};
Storage.prototype.removeItem = function (key) {
    _origRemoveItem.call(this, key);
    if (this === window.localStorage && !_suppressPush) {
        const domain = keyToDomain(key);
        if (domain) schedulePush(domain);
    }
};

// =============================================================================
//  SESSION LOCK — _session.json ile tek-cihaz kilit
// =============================================================================
let _sessionPollTimer = null;
const SESSION_HEARTBEAT_MS = 30_000;
const SESSION_POLL_MS = 20_000;
const SESSION_STALE_MS = 90_000; // 90sn heartbeat yoksa kilit serbest

async function readSession() {
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId) return null;
    const fileId = await resolveFileId(folderId, SESSION_FILE);
    if (!fileId) return null;
    return await driveDownloadJSON(fileId);
}

async function writeSession() {
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId) return;
    const payload = {
        sid: SESSION_ID,
        device: DEVICE_ID,
        email: _userEmail,
        heartbeatAt: Date.now(),
        ua: navigator.userAgent.slice(0, 120)
    };
    const fileId = await resolveFileId(folderId, SESSION_FILE);
    const result = await driveUploadJSON({ fileId, folderId, name: SESSION_FILE, content: payload });
    const cache = getFileIdCache();
    cache[SESSION_FILE] = result.id;
    setFileIdCache(cache);
}

async function claimSession() {
    try {
        const cur = await readSession();
        if (cur && cur.sid && cur.sid !== SESSION_ID &&
            (Date.now() - (cur.heartbeatAt || 0) < SESSION_STALE_MS)) {
            // Başka aktif cihaz var — onu da yazıyoruz, yeni sahip biz oluyoruz
            // (mantık: sonra gelen kazanır, eski cihaz poll'da fark eder ve kendini kapatır)
            console.log('[drive-sync] başka aktif cihaz vardı:', cur.device, '— oturumu devralıyoruz');
        }
        await writeSession();
        startSessionPoll();
    } catch (e) {
        console.warn('[drive-sync] session claim başarısız:', e);
    }
}

function startSessionPoll() {
    if (_sessionPollTimer) clearInterval(_sessionPollTimer);
    _sessionPollTimer = setInterval(async () => {
        try {
            const cur = await readSession();
            if (!cur) {
                await writeSession(); // dosya silinmişse yeniden yaz
                return;
            }
            if (cur.sid !== SESSION_ID) {
                // Başka cihaz devraldı → otomatik çıkış
                console.warn('[drive-sync] başka cihaz oturumu devraldı:', cur.device);
                clearInterval(_sessionPollTimer);
                _sessionPollTimer = null;
                alert('⚠ Bu hesap başka bir cihazda açıldı (' + (cur.device || 'bilinmiyor') + ').\nBu cihazda oturum kapatılıyor.');
                signOut();
                setTimeout(() => location.reload(), 500);
                return;
            }
            // Heartbeat
            await writeSession();
        } catch (e) {
            console.warn('[drive-sync] session poll hatası:', e);
        }
    }, SESSION_POLL_MS);
}

// =============================================================================
//  POLL & VISIBILITY PULL
// =============================================================================
const POLL_MS = 60_000;
let _pollTimer = null;
function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
            pullAllForPage().catch(() => {});
        }
    }, POLL_MS);
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tokenValid()) {
        pullAllForPage().catch(() => {});
    }
});

// =============================================================================
//  GÜNLÜK YEDEK (23:55) — backups/YYYY-MM-DD.json
// =============================================================================
const BACKUP_KEY_LAST = '_dbsync_last_backup';
const BACKUP_HOUR = 23, BACKUP_MIN = 55;

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

async function ensureBackupSubfolder(folderId) {
    // 'backups' alt klasörünü bul / oluştur
    const cache = getFileIdCache();
    if (cache.__backupsFolderId) return cache.__backupsFolderId;
    await ensureToken();
    const q = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='backups'`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _accessToken } });
    if (!r.ok) throw new Error('backups list failed: ' + r.status);
    const j = await r.json();
    let id;
    if (j.files && j.files.length) {
        id = j.files[0].id;
    } else {
        const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + _accessToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'backups',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [folderId]
            })
        });
        if (!cr.ok) throw new Error('backups create failed: ' + cr.status);
        id = (await cr.json()).id;
    }
    cache.__backupsFolderId = id;
    setFileIdCache(cache);
    return id;
}

async function performBackup() {
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId) throw new Error('Klasör seçilmemiş');
    await ensureToken();
    setStatus('syncing', 'Yedekleniyor…');
    try {
        const backupsFolder = await ensureBackupSubfolder(folderId);
        const snapshot = {
            _meta: {
                version: 1,
                createdAt: Date.now(),
                createdAtIso: new Date().toISOString(),
                device: DEVICE_ID,
                email: _userEmail
            },
            domains: {}
        };
        for (const [domain, def] of Object.entries(DOMAINS)) {
            snapshot.domains[domain] = {
                file: def.file,
                data: collectDomainData(domain)
            };
        }
        const name = todayStr() + '.json';
        // Aynı isimde dosya varsa üzerine yaz
        const q = `'${backupsFolder}' in parents and trashed=false and name='${name}'`;
        const lr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
            headers: { 'Authorization': 'Bearer ' + _accessToken }
        });
        const lj = await lr.json();
        const existingId = (lj.files && lj.files[0]) ? lj.files[0].id : null;
        await driveUploadJSON({ fileId: existingId, folderId: backupsFolder, name, content: snapshot });
        window.localStorage.setItem(BACKUP_KEY_LAST, todayStr());
        setStatus('ok', 'Yedek alındı: ' + name);
        return name;
    } catch (e) {
        setStatus('error', 'Yedek hatası');
        throw e;
    }
}

async function listBackups() {
    const folderId = window.localStorage.getItem(LS_FOLDER_ID);
    if (!folderId) return [];
    await ensureToken();
    const backupsFolder = await ensureBackupSubfolder(folderId);
    const q = `'${backupsFolder}' in parents and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=name desc&pageSize=100`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _accessToken } });
    if (!r.ok) throw new Error('backups list failed: ' + r.status);
    const j = await r.json();
    return j.files || [];
}

async function performRestore(backupFileId) {
    await ensureToken();
    setStatus('syncing', 'Geri yükleniyor…');
    try {
        const snap = await driveDownloadJSON(backupFileId);
        if (!snap || !snap.domains) throw new Error('Yedek dosyası bozuk');
        _suppressPush = true;
        try {
            // Tüm domain key'lerini temizle
            for (const def of Object.values(DOMAINS)) {
                if (def.keys) for (const k of def.keys) window.localStorage.removeItem(k);
                if (def.prefixes) {
                    const toDel = [];
                    for (let i = 0; i < window.localStorage.length; i++) {
                        const k = window.localStorage.key(i);
                        if (k && def.prefixes.some(p => k.startsWith(p))) toDel.push(k);
                    }
                    for (const k of toDel) window.localStorage.removeItem(k);
                }
            }
            // Sonra restore
            for (const [, dom] of Object.entries(snap.domains)) {
                if (dom && dom.data) {
                    for (const [k, v] of Object.entries(dom.data)) {
                        window.localStorage.setItem(k, v);
                    }
                }
            }
        } finally { _suppressPush = false; }
        // Drive'daki güncel dosyaları da yedekle yaz (yedek = yeni gerçek)
        for (const domain of Object.keys(DOMAINS)) {
            await pushDomain(domain);
        }
        window.dispatchEvent(new CustomEvent('dbsynced', { detail: { restored: true } }));
        setStatus('ok', 'Geri yükleme tamam');
    } catch (e) {
        setStatus('error', 'Restore hatası');
        throw e;
    }
}

function scheduleDailyBackup() {
    function tryAuto() {
        const last = window.localStorage.getItem(BACKUP_KEY_LAST);
        const today = todayStr();
        if (last === today) return;
        const now = new Date();
        if (now.getHours() < BACKUP_HOUR) return;
        if (now.getHours() === BACKUP_HOUR && now.getMinutes() < BACKUP_MIN) return;
        if (!tokenValid()) return;
        performBackup().catch(err => console.warn('[drive-sync] otomatik yedek hatası:', err));
    }
    tryAuto();
    setInterval(tryAuto, 5 * 60 * 1000);
}

// =============================================================================
//  PUBLIC API
// =============================================================================
window.dbAuth = {
    snapshot() {
        if (!_accessToken || !_userEmail) {
            return {
                signedIn: false,
                email: null,
                folderId: window.localStorage.getItem(LS_FOLDER_ID),
                folderName: window.localStorage.getItem(LS_FOLDER_NAME),
                device: DEVICE_ID
            };
        }
        return {
            signedIn: true,
            email: _userEmail,
            folderId: window.localStorage.getItem(LS_FOLDER_ID),
            folderName: window.localStorage.getItem(LS_FOLDER_NAME),
            device: DEVICE_ID,
            displayName: _userEmail,
            isGoogleLinked: true,
            isAnonymous: false,
            uid: _userEmail,
            needsGoogleSignin: false
        };
    },
    async signIn() {
        await requestToken({ interactive: true, forceConsent: !window.localStorage.getItem(LS_FOLDER_ID) });
        dispatchAuthState();
        return _userEmail;
    },
    async signInWithGoogleFresh() { return this.signIn(); },
    async linkWithGoogle() { return this.signIn(); },
    async signOut() { signOut(); },
    async pickFolder() {
        await ensureToken();
        const f = await pickFolder();
        dispatchAuthState();
        return f;
    },
    async ensureGoogleToken() { return await ensureToken(); },
    isReady() { return tokenValid() && !!window.localStorage.getItem(LS_FOLDER_ID); },
    getDeviceId() { return DEVICE_ID; },
    getSessionId() { return SESSION_ID; }
};

async function lastBackupInfo() {
    try {
        const list = await listBackups();
        if (!list.length) return null;
        return { name: list[0].name, modifiedTime: list[0].modifiedTime, size: list[0].size };
    } catch (_) { return null; }
}

window.dbBackup = {
    performBackup,
    runNow: async () => {
        const name = await performBackup();
        return { filename: name, size: 0, counts: { books: 0, history: 0, store: 0 } };
    },
    performRestore,
    restore: performRestore,
    listBackups,
    list: listBackups,
    deleteBackup: driveDeleteFile,
    deleteOne: driveDeleteFile,
    downloadBackupFile: async (id) => await driveDownloadJSON(id),
    lastBackup: lastBackupInfo,
    lastTime: async () => {
        const info = await lastBackupInfo();
        return info ? info.modifiedTime : null;
    }
};

window.dbSync = {
    pullAllForPage,
    pushDomain,
    pullDomain,
    domains: () => pageDomains(),
    isReady: () => tokenValid() && !!window.localStorage.getItem(LS_FOLDER_ID)
};

// =============================================================================
//  AUTO-INIT
// =============================================================================
async function autoInit() {
    ensureStatusBadge();
    setStatus('idle', 'Drive sync hazır');

    // Sessiz token denemesi (eğer kullanıcı daha önce giriş yaptıysa)
    try {
        await requestToken({ interactive: false });
        if (tokenValid() && window.localStorage.getItem(LS_FOLDER_ID)) {
            setStatus('syncing', 'Veriler indiriliyor…');
            await pullAllForPage();
            await claimSession();
            startPolling();
            scheduleDailyBackup();
            dispatchAuthState();
        } else if (tokenValid()) {
            setStatus('warn', 'Klasör seçilmedi');
            dispatchAuthState();
        } else {
            setStatus('warn', 'Giriş yapılmadı');
            dispatchAuthState();
        }
    } catch (_) {
        setStatus('warn', 'Giriş gerekli');
        dispatchAuthState();
    }

    window.__dbSyncLoading = false;
    window.dispatchEvent(new CustomEvent('dbauthready'));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoInit());
} else {
    autoInit();
}

// İlk girişten sonra (signIn → folder pick → init)
window.addEventListener('dbauthstate', async (ev) => {
    const d = ev.detail || {};
    if (d.signedIn && d.folderId && tokenValid()) {
        if (!_pollTimer) {
            try {
                await pullAllForPage();
                await claimSession();
                startPolling();
                scheduleDailyBackup();
            } catch (_) {}
        }
    }
});

console.log('[drive-sync] modül kuruldu, device=', DEVICE_ID, 'sid=', SESSION_ID);
