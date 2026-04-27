
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
    getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
    getFirestore, collection, doc, getDocs,
    setDoc, deleteDoc, onSnapshot, serverTimestamp,
    enableIndexedDbPersistence
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

// Çevrimdışı yerleşik önbellek (Firestore otomatik kuyruğa alır)
try { enableIndexedDbPersistence(db); } catch (_) { /* çoklu sekmede yutulur */ }

// Sayfa yapılandırması
const ALLOWED_KEYS = Array.isArray(window.SYNC_KEYS) ? window.SYNC_KEYS.slice() : [];
const ALLOWED_PREFIXES = Array.isArray(window.SYNC_PREFIXES) ? window.SYNC_PREFIXES.slice() : [];

// Hiçbir koşulda asla senkronlanmayacak desenler (tabela & devam)
const NEVER_SYNC_PREFIXES = ['101_v', 'devam_'];

function isAllowed(key) {
    if (!key) return false;
    if (NEVER_SYNC_PREFIXES.some(p => key.startsWith(p))) return false;
    if (ALLOWED_KEYS.includes(key)) return true;
    if (ALLOWED_PREFIXES.some(p => key.startsWith(p))) return true;
    return false;
}

// localStorage proxy: setItem/removeItem'i yakala
const _origSet = Storage.prototype.setItem;
const _origRemove = Storage.prototype.removeItem;
let _suppressWrite = false;     // bulut → yerel uygularken echo etme
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

// Anahtar bazlı debounce
const writeQueue = new Map();   // key -> { type, value }
const writeTimers = new Map();  // key -> timeoutId
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
    const ref = doc(db, 'users', _currentUid, 'store', k);
    setStatus('syncing');
    try {
        if (op.type === 'set') {
            await setDoc(ref, { v: op.value, u: serverTimestamp() });
        } else {
            await deleteDoc(ref);
        }
        setStatus('ok');
    } catch (e) {
        console.warn('[db-sync] write failed:', k, e);
        setStatus('error');
    }
}

// İlk hidrasyon + canlı dinleyici
async function onAuthed(uid) {
    _currentUid = uid;
    setStatus('syncing');

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

    // İlk açılış: yerelde olup bulutta olmayan kayıtları yukarı it
    const cloudKeys = new Set(snap.docs.map(d => d.id));
    for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!isAllowed(k) || cloudKeys.has(k)) continue;
        scheduleWrite(k, window.localStorage.getItem(k));
    }

    _hydrated = true;
    setStatus('ok');
    window.dispatchEvent(new CustomEvent('dbsynced', {
        detail: { applied, uid, source: 'hydrate' }
    }));

    // Canlı dinleyici (başka cihazlardan gelen değişiklikler)
    onSnapshot(colRef, (qs) => {
        let changed = 0;
        _suppressWrite = true;
        try {
            qs.docChanges().forEach(ch => {
                const k = ch.doc.id;
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

// =====================================================================
//  Görsel sync göstergesi (sağ üstte minik nokta)
// =====================================================================
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
    // state: 'syncing' | 'ok' | 'error'
    const colors = { syncing: '#f1c40f', ok: '#2ecc71', error: '#e74c3c' };
    const c = colors[state] || '#888';
    const apply = () => { const b = ensureBadge(); b.style.background = c; b.style.color = c; };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
}
setStatus('syncing');

// Test/debug için global yardımcılar (opsiyonel)
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
