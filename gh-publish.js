/* ============================================================================
 *  gh-publish.js  —  İngilizce sayfası içeriğini GitHub deposu üzerinden paylaş
 * ----------------------------------------------------------------------------
 *  AMAÇ:
 *   - SAHİP (sen): İçerik ekledikçe `eng_day_*` / `eng_done_*` verisi otomatik
 *     olarak GitHub deposundaki `ingilizce-data.json` dosyasına yazılır.
 *   - ZİYARETÇİ (GitHub linkine giren herkes): Sayfa açılınca bu JSON okunur,
 *     senin tüm içeriğin gösterilir. Ziyaretçi SADECE OKUR; düzenleyemez/silemez.
 *
 *  GÜVENLİK: GitHub Personal Access Token (PAT) yalnızca SENİN tarayıcının
 *  localStorage'ında (`gh_pat`) tutulur. Depoya / koda asla yazılmaz.
 * ========================================================================== */
(function () {
  'use strict';

  // ----- Ayarlar -----
  const GH = {
    owner: 'msefagor',
    repo: 'MyLifeApp',
    branch: 'main',                 // Pages farklı dal kullanıyorsa değiştir
    file: 'ingilizce-data.json',
    prefixes: ['eng_day_', 'eng_done_'],
    tokenKey: 'gh_pat'
  };

  const api = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.file}`;

  // ----- Yardımcılar -----
  const getToken = () => { try { return localStorage.getItem(GH.tokenKey) || ''; } catch (_) { return ''; } };
  const isOwner  = () => !!getToken();

  // UTF-8 güvenli base64 (Türkçe karakterler için şart)
  const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decode = (str) => decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));

  const matches = (key) => GH.prefixes.some((p) => key && key.startsWith(p));

  // localStorage'daki tüm eng_ verisini topla
  function collect() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (matches(k)) data[k] = localStorage.getItem(k);
    }
    return data;
  }

  function hasAnyLocal() {
    for (let i = 0; i < localStorage.length; i++) {
      if (matches(localStorage.key(i))) return true;
    }
    return false;
  }

  // ----- Render tazeleme -----
  function refreshUI() {
    try {
      if (typeof renderCalendar === 'function') renderCalendar();
      if (typeof updateSelectedDateCard === 'function') updateSelectedDateCard();
    } catch (_) {}
  }

  // ----- GitHub'a YAYINLA (sadece sahip) -----
  let _publishTimer = null;
  let _publishing = false;
  let _lastError = '';                               // rozete tıklayınca gösterilir

  // HTTP durum kodunu anlaşılır Türkçe açıklamaya çevir
  function explain(status, raw) {
    switch (status) {
      case 401: return 'Token geçersiz veya SÜRESİ DOLMUŞ (401).\n\nÇözüm: GitHub → Settings → Developer settings → ' +
                       'Personal access tokens → Fine-grained tokens → yeni token üret, sonra rozete tıklayıp ' +
                       '"2 = Token\'ı kaldır" de ve yeni token\'ı yapıştır.';
      case 403: return 'Token\'ın yetkisi yetersiz veya istek limiti aşıldı (403).\n\nÇözüm: Token ayarlarında ' +
                       'Repository access = MyLifeApp ve Permissions → Contents = "Read and write" olmalı.';
      case 404: return 'Depo/dal/dosya bulunamadı (404).\n\nKontrol et: ' + GH.owner + '/' + GH.repo +
                       ' deposu, "' + GH.branch + '" dalı ve "' + GH.file + '" dosyası mevcut mu? ' +
                       'Ayrıca token bu depoya kapsamlı mı?';
      case 409:
      case 422: return 'Dosya bu sırada başka yerden değişti (' + status + ').\n\nOtomatik tekrar denendi; ' +
                       'yine olmadıysa sayfayı yenileyip "1 = Şimdi yayınla" de.';
      default:  return 'HTTP ' + status + '\n' + (raw || '').slice(0, 300);
    }
  }

  async function getSha(token) {
    const head = await fetch(`${api}?ref=${GH.branch}&t=${Date.now()}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    });
    if (head.ok) { const j = await head.json(); return j.sha; }
    if (head.status === 404) return null;            // dosya henüz yok, sorun değil
    const txt = await head.text();
    const err = new Error('GET'); err.status = head.status; err.raw = txt; throw err;
  }

  async function putFile(token, body, sha) {
    const res = await fetch(api, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        message: `İngilizce içerik güncellendi — ${new Date().toISOString()}`,
        content: b64encode(body),
        branch: GH.branch,
        ...(sha ? { sha } : {})
      })
    });
    if (res.ok) return true;
    const txt = await res.text();
    const err = new Error('PUT'); err.status = res.status; err.raw = txt; throw err;
  }

  async function publishNow() {
    const token = getToken();
    if (!token) return;
    if (_publishing) { schedulePublish(); return; }   // çakışma olmasın
    _publishing = true;

    try {
      const data = collect();
      const body = JSON.stringify(data, null, 0);

      // GÜVENLİK: elde veri yokken depodaki dolu dosyanın üzerine boş {} yazma
      if (Object.keys(data).length === 0) {
        const remote = await fetchData();
        if (remote && Object.keys(remote).length > 0) {
          _lastError = 'Yerelde içerik yok; depodaki dolu dosya korunmak için yayın iptal edildi.';
          ghStatus('err', 'GitHub: yayın iptal (veri boş)');
          return;
        }
      }

      try {
        await putFile(token, body, await getSha(token));
      } catch (e) {
        if (e.status === 409 || e.status === 422) {   // SHA çakışması → tazele ve bir kez daha dene
          await putFile(token, body, await getSha(token));
        } else { throw e; }
      }

      _lastError = '';
      ghStatus('ok', 'GitHub: yayınlandı ' + new Date().toLocaleTimeString('tr-TR'));
    } catch (e) {
      const status = e.status || 0;
      _lastError = explain(status, e.raw);
      console.warn('[gh-publish] yayın hatası:', status, e.raw || e.message);
      ghStatus('err', 'GitHub: hata ' + (status || '(ağ)') + ' — tıkla');
      if (!status) {
        _lastError = 'Sunucuya ulaşılamadı.\n\nOlası sebepler: internet yok, sayfayı file:// ile ' +
                     '(çift tıklayarak) açtın, ya da bir eklenti/ağ isteği engelliyor. ' +
                     'Sayfayı https://msefagor.github.io/MyLifeApp/ingilizce.html adresinden aç.';
      }
    } finally {
      _publishing = false;
    }
  }

  function schedulePublish() {
    if (!isOwner()) return;
    clearTimeout(_publishTimer);
    ghStatus('sync', 'GitHub: kaydediliyor…');
    _publishTimer = setTimeout(publishNow, 1500);   // debounce
  }

  // ----- JSON'dan OKU (ziyaretçi, ya da boş cihazdaki sahip) -----
  // GitHub Pages CDN'i dosyayı önbelleğe alabildiği için önce raw.githubusercontent
  // (daha güncel) denenir; başarısız olursa Pages'teki yerel dosyaya düşülür.
  async function fetchData() {
    const sources = [
      `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/${GH.file}?t=${Date.now()}`,
      `./${GH.file}?t=${Date.now()}`
    ];
    for (const url of sources) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && typeof data === 'object') return data;
      } catch (_) { /* sonraki kaynağı dene */ }
    }
    return null;
  }

  async function pullIntoLocal() {
    const data = await fetchData();
    if (!data) return false;
    const orig = _origSetItem;                 // interceptor'ı atla
    let count = 0;
    Object.keys(data).forEach((k) => {
      if (matches(k)) { orig(k, data[k]); count++; }
    });
    if (count) refreshUI();
    return count > 0;
  }

  // ----- Yazma müdahalesi: her eng_ kaydında otomatik yayınla (sahip) -----
  const _origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    _origSetItem(k, v);
    if (isOwner() && matches(k)) schedulePublish();
  };

  // ----- Ziyaretçi için salt-okunur kilit -----
  function lockForVisitor() {
    if (isOwner()) return;
    const guard = (msg) => () => {
      try { if (typeof showToast === 'function') showToast(msg, { type: 'info', title: 'Salt-okunur' }); }
      catch (_) { alert(msg); }
    };
    // Düzenleme giriş noktalarını engelle (okuma/ders akışı çalışmaya devam eder)
    window.openEditor  = guard('Bu sayfa salt-okunurdur. İçeriği yalnızca görüntüleyebilirsiniz.');
    window.saveContent = guard('Bu sayfa salt-okunurdur. Değişiklik kaydedilemez.');
  }

  // ----- Küçük durum rozeti + sahip kontrol düğmesi -----
  function ghStatus(state, msg) {
    let el = document.getElementById('gh-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gh-status';
      el.style.cssText =
        'position:fixed;left:12px;bottom:12px;z-index:99999;font:12px/1.3 system-ui,sans-serif;' +
        'padding:6px 10px;border-radius:10px;color:#fff;background:rgba(20,24,40,.85);' +
        'backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer;opacity:.92';
      el.title = 'GitHub paylaşımı (tıkla)';
      el.onclick = ownerMenu;
      document.body.appendChild(el);
    }
    const dot = state === 'ok' ? '🟢' : state === 'err' ? '🔴' : state === 'sync' ? '🟡' : '⚪';
    el.textContent = `${dot} ${msg}`;
  }

  function ownerMenu() {
    if (!isOwner()) {
      const t = prompt(
        'GitHub Token (PAT) yapıştır:\n' +
        '— Bu token yalnızca bu tarayıcıda saklanır, depoya yazılmaz.\n' +
        '— Contents: Read & Write izinli, MyLifeApp deposuna kapsamlı olmalı.'
      );
      if (t && t.trim()) {
        try { localStorage.setItem(GH.tokenKey, t.trim()); } catch (_) {}
        alert('Token kaydedildi. Sayfa sahip moduna geçiyor; içerik otomatik yayınlanacak.');
        location.reload();
      }
      return;
    }
    if (_lastError) {
      alert('SON HATA\n\n' + _lastError);
    }
    const choice = prompt(
      'SAHİP MODU\n' +
      '1 = Şimdi yayınla\n' +
      '2 = Token\'ı kaldır (ziyaretçi moduna dön)\n' +
      '3 = Token\'ı test et\n' +
      'İptal = kapat'
    );
    if (choice === '1') publishNow();
    else if (choice === '3') testToken();
    else if (choice === '2') {
      try { localStorage.removeItem(GH.tokenKey); } catch (_) {}
      alert('Token kaldırıldı.'); location.reload();
    }
  }

  // ----- Token sağlık testi -----
  async function testToken() {
    const token = getToken();
    if (!token) { alert('Token yok — ziyaretçi modundasın.'); return; }
    try {
      const res = await fetch(`${api}?ref=${GH.branch}&t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (res.ok || res.status === 404) {
        alert('✅ Token geçerli. Depoya yazma yolu açık.\n\nDosya durumu: ' +
              (res.ok ? 'mevcut' : 'henüz yok (ilk yayında oluşturulacak)'));
        _lastError = '';
        ghStatus('ok', 'GitHub: sahip modu');
      } else {
        const txt = await res.text();
        _lastError = explain(res.status, txt);
        alert('❌ Token sorunu\n\n' + _lastError);
        ghStatus('err', 'GitHub: hata ' + res.status + ' — tıkla');
      }
    } catch (e) {
      alert('❌ Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.');
    }
  }

  // ----- Başlatma -----
  async function init() {
    if (isOwner()) {
      // Sahip: localStorage gerçek kaynaktır. Yeni/boş cihazsa JSON'dan çek.
      if (!hasAnyLocal()) await pullIntoLocal();
      ghStatus('ok', 'GitHub: sahip modu');
      // Token'ı sessizce doğrula; süresi dolmuşsa hemen uyar (yayın anını bekleme)
      try {
        const res = await fetch(`${api}?ref=${GH.branch}&t=${Date.now()}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' }
        });
        if (!res.ok && res.status !== 404) {
          _lastError = explain(res.status, await res.text());
          ghStatus('err', 'GitHub: token sorunu ' + res.status + ' — tıkla');
        }
      } catch (_) {}
    } else {
      // Ziyaretçi: içeriği JSON'dan oku, salt-okunur kilit uygula.
      lockForVisitor();
      const got = await pullIntoLocal();
      ghStatus(got ? 'ok' : 'idle', got ? 'GitHub: içerik yüklendi' : 'GitHub: içerik yok');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
