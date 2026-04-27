// ============================================================================
//  db-sync.js v2 — localStorage ↔ Firestore canlı senkron katmanı
//
//  Sayfa entegrasyonu:
//
//     <script>
//       window.SYNC_KEYS = ['namazTakipData_v2'];
//       // ya da: window.SYNC_PREFIXES = ['eng_day_', 'eng_done_'];
//       window.addEventListener('dbsynced', () => {
//         // bulutdan veri geldi → UI'yi yenile
//       });
//     </script>
//     <script type="module" src="./db-sync.js"></script>
//
//  Mimari:
//   - Anonim auth ile uid → users/{uid}/...
//   - Genel anahtarlar:  users/{uid}/store/{key}  → { v: <JSON string>, u: ts }
//   - SHARDED anahtar (kitap, çünkü 500+ kitap tek belgeye sığmaz):
//       users/{uid}/store/liquid_lib_settings  → settings (dailyGoal, yearlyGoal)
//       users/{uid}/books/{bookId}             → her kitap kendi belgesinde
//       users/{uid}/history/{entryId}          → her okuma kaydı kendi belgesinde
//     Migration: eski tek-belge formatı varsa otomatik parçalanır ve eskisi silinir.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
    getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
    getFirestore, collection, doc, getDoc, getDocs,
    setDoc, deleteDoc, onSnapshot, serverTimestamp,
    writeBatch, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCNlJXeTLUd5BSrNv0ihJj8s4jzjGm3tBU",
    authDomain: "mylifeapp-9e1a5.firebaseapp.com",
    projectId: "mylifeapp-9e1a5",
    storageBucket: "mylifeapp-9e1a5.firebasestorage.app",
    messagingSenderId: "184551882274",
    appId: "1:184551882274:web:2debc4946068b7586c147b",
    measurementId: "G-G4N9Y45JYG"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
try { enableIndexedDbPersistence(db); } catch (_) {}

// === Sayfa yapılandırması ===
const ALLOWED_KEYS = Array.isArray(window.SYNC_KEYS) ? window.SYNC_KEYS.slice() : [];
const ALLOWED_PREFIXES = Array.isArray(window.SYNC_PREFIXES) ? window.SYNC_PREFIXES.slice() : [];
const NEVER_SYNC_PREFIXES = ['101_v', 'devam_', '_dbsync_'];

// Sharded yapı kullanan anahtarlar
const SHARDED_KEYS = ['liquid_lib_pro_v1'];
const KITAP_KEY = 'liquid_lib_pro_v1';
const KITAP_SETTINGS_DOC = 'liquid_lib_settings';
const KITAP_OLD_DOC_ID = 'liquid_lib_pro_v1';
const KITAP_SNAPSHOT_KEY = '_dbsync_kitap_snapshot';

function isAllowed(key) {
    if (!key) return false;
    if (NEVER_SYNC_PREFIXES.some(p => key.startsWith(p))) return false;
    if (ALLOWED_KEYS.includes(key)) return true;
    if (ALLOWED_PREFIXES.some(p => key.startsWith(p))) return true;
    return false;
}
function isSharded(key) { return SHARDED_KEYS.includes(key); }

// === localStorage proxy ===
const _origSet = Storage.prototype.setItem;
const _origRemove = Storage.prototype.removeItem;
let _suppressWrite = false;
let _currentUid = null;
let _hydrated = false;

Storage.prototype.setItem = function (k, v) {
    _origSet.call(this, k, v);
    if (this !== window.localStorage) return;
    if (_suppressWrite) return;
    if (!isAllowed(k)) return;
    scheduleWrite(k, v);
};
Storage.prototype.removeItem = function (k) {
    _origRemove.call(this, k);
    if (this !== window.localStorage) return;
    if (_suppressWrite) return;
    if (!isAllowed(k)) return;
    scheduleDelete(k);
};

// === Anahtar bazlı debounce ===
const writeQueue = new Map();
const writeTimers = new Map();
const DEBOUNCE_MS = 600;

function scheduleWrite(k, v) {
    writeQueue.set(k, { type: 'set', value: v });
    if (writeTimers.has(k)) clearTimeout(writeTimers.get(k));
    writeTimers.set(k, setTimeout(() => flushWrite(k), DEBOUNCE_MS));
}
function scheduleDelete(k) {
    writeQueue.set(k, { type: 'del' });
    if (writeTimers.has(k)) clearTimeout(writeTimers.get(k));
    writeTimers.set(k, setTimeout(() => flushWrite(k), DEBOUNCE_MS));
}

async function flushWrite(k) {
    writeTimers.delete(k);
    if (!_currentUid) return;
    const op = writeQueue.get(k);
    if (!op) return;
    writeQueue.delete(k);
    setStatus('syncing');
    try {
        if (isSharded(k)) {
            await flushShardedKitap(op);
        } else {
            const ref = doc(db, 'users', _currentUid, 'store', k);
            if (op.type === 'set') {
                await setDoc(ref, { v: op.value, u: serverTimestamp() });
            } else {
                await deleteDoc(ref);
            }
        }
        setStatus('ok');
    } catch (e) {
        console.warn('[db-sync] write failed:', k, e);
        setStatus('error');
    }
}

// =========================================================================
//  SHARDED HANDLER: Kitap (liquid_lib_pro_v1)
// =========================================================================
function stripMeta(d) {
    if (!d) return d;
    const { u, ...rest } = d;
    return rest;
}

async function pullKitap(uid) {
    const settingsRef = doc(db, 'users', uid, 'store', KITAP_SETTINGS_DOC);
    const booksRef = collection(db, 'users', uid, 'books');
    const histRef = collection(db, 'users', uid, 'history');

    const [settingsSnap, booksSnap, histSnap] = await Promise.all([
        getDoc(settingsRef),
        getDocs(booksRef),
        getDocs(histRef)
    ]);

    let settings = { dailyGoal: 50, yearlyGoal: 60 };
    if (settingsSnap.exists()) {
        try { settings = JSON.parse(settingsSnap.data().v); } catch (_) {}
    }
    const books = booksSnap.docs.map(d => stripMeta(d.data()));
    const history = histSnap.docs.map(d => stripMeta(d.data()));
    return { books, history, settings };
}

async function pushKitap(uid, newData, oldData) {
    if (!newData) return;
    if (!oldData) oldData = { books: [], history: [], settings: {} };

    const writes = [];

    // Settings
    const newS = JSON.stringify(newData.settings || {});
    const oldS = JSON.stringify(oldData.settings || {});
    if (newS !== oldS) {
        writes.push({
            type: 'set',
            ref: doc(db, 'users', uid, 'store', KITAP_SETTINGS_DOC),
            data: { v: newS, u: serverTimestamp() }
        });
    }

    // Books diff
    const oldBooks = new Map((oldData.books || []).map(b => [String(b.id), b]));
    const newBooks = new Map((newData.books || []).map(b => [String(b.id), b]));
    for (const [id, book] of newBooks) {
        const oldBook = oldBooks.get(id);
        if (!oldBook || JSON.stringify(book) !== JSON.stringify(oldBook)) {
            writes.push({
                type: 'set',
                ref: doc(db, 'users', uid, 'books', id),
                data: { ...book, u: serverTimestamp() }
            });
        }
    }
    for (const id of oldBooks.keys()) {
        if (!newBooks.has(id)) {
            writes.push({ type: 'delete', ref: doc(db, 'users', uid, 'books', id) });
        }
    }

    // History diff
    const oldHist = new Map((oldData.history || []).map(h => [String(h.id), h]));
    const newHist = new Map((newData.history || []).map(h => [String(h.id), h]));
    for (const [id, entry] of newHist) {
        const oldEntry = oldHist.get(id);
        if (!oldEntry || JSON.stringify(entry) !== JSON.stringify(oldEntry)) {
            writes.push({
                type: 'set',
                ref: doc(db, 'users', uid, 'history', id),
                data: { ...entry, u: serverTimestamp() }
            });
        }
    }
    for (const id of oldHist.keys()) {
        if (!newHist.has(id)) {
            writes.push({ type: 'delete', ref: doc(db, 'users', uid, 'history', id) });
        }
    }

    if (writes.length === 0) return;

    // 480'lik chunk'lar (Firestore limiti 500)
    const CHUNK = 480;
    for (let i = 0; i < writes.length; i += CHUNK) {
        const batch = writeBatch(db);
        for (const w of writes.slice(i, i + CHUNK)) {
            if (w.type === 'set') batch.set(w.ref, w.data);
            else batch.delete(w.ref);
        }
        await batch.commit();
    }
}

async function flushShardedKitap(op) {
    if (op.type === 'del') return; // explicit silme yok
    const newData = JSON.parse(op.value || '{"books":[],"history":[],"settings":{}}');
    let oldData = { books: [], history: [], settings: {} };
    const snapStr = window.localStorage.getItem(KITAP_SNAPSHOT_KEY);
    if (snapStr) { try { oldData = JSON.parse(snapStr); } catch (_) {} }
    await pushKitap(_currentUid, newData, oldData);
    _suppressWrite = true;
    try { _origSet.call(window.localStorage, KITAP_SNAPSHOT_KEY, op.value); }
    finally { _suppressWrite = false; }
}

async function migrateKitapIfNeeded(uid) {
    const oldRef = doc(db, 'users', uid, 'store', KITAP_OLD_DOC_ID);
    const oldSnap = await getDoc(oldRef);
    if (!oldSnap.exists()) return false;
    let oldData;
    try { oldData = JSON.parse(oldSnap.data().v); }
    catch (_) { return false; }
    if (!oldData || !Array.isArray(oldData.books)) return false;
    console.log('[db-sync] kitap migration: eski tek-belge bulundu, parçalanıyor...');
    setStatus('syncing');
    await pushKitap(uid, oldData, { books: [], history: [], settings: {} });
    await deleteDoc(oldRef);
    console.log('[db-sync] kitap migration tamamlandı.');
    return true;
}

async function hydrateKitap(uid) {
    if (!isAllowed(KITAP_KEY)) return;
    await migrateKitapIfNeeded(uid);
    const data = await pullKitap(uid);
    const valueStr = JSON.stringify(data);
    const localValue = window.localStorage.getItem(KITAP_KEY);
    const cloudEmpty = data.books.length === 0 && data.history.length === 0;

    _suppressWrite = true;
    try {
        if (cloudEmpty && localValue) {
            // Bulut boş, yerelde veri var → snapshot'ı boş bırak,
            // sonradan otomatik push edilsin
            _origSet.call(window.localStorage, KITAP_SNAPSHOT_KEY, JSON.stringify({ books: [], history: [], settings: {} }));
            scheduleWrite(KITAP_KEY, localValue);
        } else {
            _origSet.call(window.localStorage, KITAP_KEY, valueStr);
            _origSet.call(window.localStorage, KITAP_SNAPSHOT_KEY, valueStr);
        }
    } finally {
        _suppressWrite = false;
    }
}

function subscribeKitap(uid) {
    if (!isAllowed(KITAP_KEY)) return;
    let books = null;
    let history = null;
    let settings = null;

    const settle = () => {
        if (books === null || history === null || settings === null) return;
        const valueStr = JSON.stringify({ books, history, settings });
        const cur = window.localStorage.getItem(KITAP_KEY);
        if (cur === valueStr) return;
        _suppressWrite = true;
        try {
            _origSet.call(window.localStorage, KITAP_KEY, valueStr);
            _origSet.call(window.localStorage, KITAP_SNAPSHOT_KEY, valueStr);
        } finally {
            _suppressWrite = false;
        }
        window.dispatchEvent(new CustomEvent('dbsynced', {
            detail: { source: 'remote', sharded: 'kitap' }
        }));
    };

    onSnapshot(doc(db, 'users', uid, 'store', KITAP_SETTINGS_DOC), (d) => {
        if (d.exists()) {
            try { settings = JSON.parse(d.data().v); }
            catch (_) { settings = { dailyGoal: 50, yearlyGoal: 60 }; }
        } else {
            settings = { dailyGoal: 50, yearlyGoal: 60 };
        }
        settle();
    }, e => console.warn('[db-sync] settings snapshot:', e));

    onSnapshot(collection(db, 'users', uid, 'books'), (qs) => {
        books = qs.docs.map(d => stripMeta(d.data()));
        settle();
    }, e => console.warn('[db-sync] books snapshot:', e));

    onSnapshot(collection(db, 'users', uid, 'history'), (qs) => {
        history = qs.docs.map(d => stripMeta(d.data()));
        settle();
    }, e => console.warn('[db-sync] history snapshot:', e));
}

// =========================================================================
//  GENEL HİDRASYON ve SUBSCRIBE
// =========================================================================
async function onAuthed(uid) {
    _currentUid = uid;
    setStatus('syncing');

    // 1) Sharded keys (kitap)
    if (SHARDED_KEYS.some(isAllowed)) {
        try { await hydrateKitap(uid); }
        catch (e) { console.warn('[db-sync] kitap hydrate error:', e); }
    }

    // 2) Normal store/{key} hidrasyon
    const colRef = collection(db, 'users', uid, 'store');
    let snap;
    try {
        snap = await getDocs(colRef);
    } catch (e) {
        console.warn('[db-sync] hydrate failed (kurallar?):', e);
        setStatus('error');
        return;
    }

    let applied = 0;
    _suppressWrite = true;
    try {
        snap.forEach(d => {
            const k = d.id;
            // Kitap belgeleri özel handler ile işleniyor
            if (k === KITAP_SETTINGS_DOC || isSharded(k)) return;
            if (!isAllowed(k)) return;
            const data = d.data();
            if (data && typeof data.v === 'string') {
                if (window.localStorage.getItem(k) !== data.v) {
                    _origSet.call(window.localStorage, k, data.v);
                    applied++;
                }
            }
        });
    } finally {
        _suppressWrite = false;
    }

    // İlk açılış: yerelde olup bulutta olmayan normal anahtarları yukarı it
    const cloudKeys = new Set(snap.docs.map(d => d.id));
    for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('_dbsync_')) continue;
        if (isSharded(k)) continue; // sharded kendi hidrasyonu işliyor
        if (!isAllowed(k) || cloudKeys.has(k)) continue;
        scheduleWrite(k, window.localStorage.getItem(k));
    }

    _hydrated = true;
    setStatus('ok');
    window.dispatchEvent(new CustomEvent('dbsynced', {
        detail: { applied, uid, source: 'hydrate' }
    }));

    // 3) Subscribe — sharded
    if (SHARDED_KEYS.some(isAllowed)) subscribeKitap(uid);

    // 4) Subscribe — normal store
    onSnapshot(colRef, (qs) => {
        let changed = 0;
        _suppressWrite = true;
        try {
            qs.docChanges().forEach(ch => {
                const k = ch.doc.id;
                if (k === KITAP_SETTINGS_DOC || isSharded(k)) return;
                if (!isAllowed(k)) return;
                if (ch.type === 'removed') {
                    if (window.localStorage.getItem(k) !== null) {
                        _origRemove.call(window.localStorage, k);
                        changed++;
                    }
                } else {
                    const v = ch.doc.data().v;
                    if (typeof v === 'string' && window.localStorage.getItem(k) !== v) {
                        _origSet.call(window.localStorage, k, v);
                        changed++;
                    }
                }
            });
        } finally {
            _suppressWrite = false;
        }
        if (changed > 0) {
            window.dispatchEvent(new CustomEvent('dbsynced', {
                detail: { changed, source: 'remote' }
            }));
        }
    }, (err) => {
        console.warn('[db-sync] onSnapshot error:', err);
        setStatus('error');
    });
}

onAuthStateChanged(auth, async (user) => {
    if (user) {
        onAuthed(user.uid);
    } else {
        try {
            await signInAnonymously(auth);
        } catch (e) {
            console.error('[db-sync] anonim giriş hatası:', e);
            setStatus('error');
        }
    }
});

// =========================================================================
//  Sağ üstte sync durumu (renkli nokta)
// =========================================================================
function ensureBadge() {
    let el = document.getElementById('dbsync-badge');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'dbsync-badge';
    el.title = 'Bulut senkronu';
    el.style.cssText = `
        position: fixed;
        top: max(env(safe-area-inset-top), 10px);
        right: 10px;
        width: 10px; height: 10px; border-radius: 50%;
        background: #888;
        z-index: 99999;
        box-shadow: 0 0 8px currentColor;
        transition: background 0.3s ease;
        pointer-events: none;
    `;
    document.body.appendChild(el);
    return el;
}
function setStatus(state) {
    const colors = { syncing: '#f1c40f', ok: '#2ecc71', error: '#e74c3c' };
    const c = colors[state] || '#888';
    const apply = () => { const b = ensureBadge(); b.style.background = c; b.style.color = c; };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
}
setStatus('syncing');

// Debug için global yardımcılar
window.dbSync = {
    forceFlushAll() {
        for (const k of writeTimers.keys()) {
            clearTimeout(writeTimers.get(k));
            flushWrite(k);
        }
    },
    isHydrated: () => _hydrated,
    uid: () => _currentUid
};
