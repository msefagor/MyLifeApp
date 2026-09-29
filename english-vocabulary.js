/* Shared daily English -> article vocabulary bridge. No network translation needed. */
(() => {
    'use strict';
    if (window.EnglishVocabulary && window.EnglishVocabulary.version === 2) return;
    const APP = 'makale_app_v1', RECEIPTS = 'eng_vocab_imported_v1';
    const clean = value => value.trim().replace(/\*\*|__|`/g, '').replace(/\\\|/g, '|');
    const norm = value => clean(value).toLowerCase().replace(/[‘’]/g, "'")
        .replace(/^[^a-zçğıöşü']+|[^a-zçğıöşü']+$/gi, '').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
    function parse(text) {
        const result = []; let active = false, pending = [];
        const fold = value => clean(value).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/\u0307/g, '');
        const header = value => /^(ingilizce kelime|english word|okunuşu.*|pronunciation|türkçe anlami|turkce anlami|meaning|örnek cümle.*|ornek cumle.*|example.*|çevirisi.*|cevirisi.*|translation)$/.test(fold(value));
        const add = cells => {
            if (cells.length < 3 || header(cells[0])) return;
            const w = norm(cells[0]);
            if (!w || !cells[2]) return;
            result.push({ w, tr: cells[2], pronunciation: cells[1] || '', exampleEn: cells[3] || '', exampleTr: cells[4] || '' });
        };
        for (const raw of String(text).replace(/\u00a0/g, ' ').split(/\r?\n/)) {
            const line = raw.trim();
            const title = fold(line.replace(/^#{1,6}\s*/, ''));
            if (/^(?:\d+[.)]\s*)?(?:🔑\s*)?temel\s+kelimeler(?:\s|\(|$)/.test(title) || /^(?:\d+[.)]\s*)?vocabulary(?:\s|\(|$)/.test(title)) {
                active = true; pending = []; continue;
            }
            if (/^#{1,6}\s/.test(line) || /^\d+[.)]\s/.test(line) || /^(?:💬|📖|🗣|🎙|📝|📅)/u.test(line)) {
                active = false; pending = []; continue;
            }
            if (!active || !line || /^[-:|\s]+$/.test(line)) continue;
            let cells;
            if (line.includes('|')) {
                // Avoid lookbehind for older mobile browsers; escaped pipes remain in cells.
                cells = line.replace(/\\\|/g, '\u0000').replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => clean(c.replace(/\u0000/g, '|')));
            } else if (/\t| {2,}/.test(line)) {
                cells = line.split(/\t+| {2,}/).map(clean);
            }
            if (cells && cells.length >= 3) { add(cells); pending = []; continue; }
            if (header(line)) continue;
            pending.push(clean(line));
            if (pending.length === 5) { add(pending); pending = []; }
        }
        return result;
    }
    function sync() {
        try {
            const app = JSON.parse(localStorage.getItem(APP) || '{"words":{},"cache":{},"days":{},"settings":{}}');
            if (!app || typeof app.words !== 'object' || Array.isArray(app.words) || !app.words) throw Error('Invalid vocabulary data');
            const receipts = JSON.parse(localStorage.getItem(RECEIPTS) || '{}');
            let added = 0, touched = false;
            const keys = Object.keys(localStorage).filter(k => /^eng_day_\d{4}-\d{2}-\d{2}$/.test(k)).sort();
            const now = Date.now();
            for (const key of keys) {
                const seen = new Set(Array.isArray(receipts[key]) ? receipts[key] : []);
                for (const word of parse(localStorage.getItem(key))) {
                    if (seen.has(word.w)) continue;
                    if (!Object.prototype.hasOwnProperty.call(app.words, word.w)) {
                        Object.defineProperty(app.words, word.w, { value: { ...word, status: 'unknown', added: now,
                            updatedAt: now, source: 'daily-english', sourceDate: key.slice(8),
                            note: 'Günlük İngilizce · ' + key.slice(8) }, enumerable: true, configurable: true, writable: true });
                        added++;
                    }
                    seen.add(word.w); touched = true;
                }
                receipts[key] = [...seen];
            }
            if (added) {
                const d = new Date(), day = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                app.days ||= {}; app.days[day] ||= { added: 0, learned: 0 }; app.days[day].added = (Number(app.days[day].added) || 0) + added;
                localStorage.setItem(APP, JSON.stringify(app));
            }
            // Commit receipts only after vocabulary storage succeeds; deletions stay deleted.
            if (touched) localStorage.setItem(RECEIPTS, JSON.stringify(receipts));
            if (added) window.dispatchEvent(new CustomEvent('englishvocabularyimported', { detail: { added } }));
            return added;
        } catch (error) {
            console.error('Daily vocabulary import failed:', error);
            window.dispatchEvent(new CustomEvent('englishvocabularyerror'));
            return -1;
        }
    }
    window.EnglishVocabulary = { parse, sync, version: 2 };
    window.addEventListener('dbsynced', sync);
    window.addEventListener('storage', e => { if (!e.key || e.key.startsWith('eng_day_')) sync(); });
    window.addEventListener('pageshow', sync);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
    else sync();
})();
