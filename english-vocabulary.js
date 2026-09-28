/* Shared daily English -> article vocabulary bridge. No network translation needed. */
(() => {
    'use strict';
    const APP = 'makale_app_v1', RECEIPTS = 'eng_vocab_imported_v1';
    const clean = value => value.trim().replace(/\*\*|__|`/g, '').replace(/\\\|/g, '|');
    const norm = value => clean(value).toLowerCase().replace(/[‘’]/g, "'")
        .replace(/^[^a-zçğıöşü']+|[^a-zçğıöşü']+$/gi, '').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
    function parse(text) {
        const result = []; let active = false;
        for (const line of String(text).split(/\r?\n/)) {
            if (/^\s*#{1,6}\s/.test(line)) {
                active = /temel\s+kelimeler|\bvocabulary\b/i.test(line.toLocaleLowerCase('tr-TR'));
                continue;
            }
            if (!active || !line.trim().startsWith('|')) continue;
            const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(clean);
            if (cells.length < 3 || cells.every(c => /^:?-+:?$/.test(c))) continue;
            if (/ingilizce\s+kelime|english\s+word/i.test(cells[0].toLocaleLowerCase('tr-TR'))) continue;
            const w = norm(cells[0]);
            if (!w || !cells[2]) continue;
            result.push({ w, tr: cells[2], pronunciation: cells[1] || '', exampleEn: cells[3] || '', exampleTr: cells[4] || '' });
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
    window.EnglishVocabulary = { parse, sync };
    window.addEventListener('dbsynced', sync);
    window.addEventListener('storage', e => { if (!e.key || e.key.startsWith('eng_day_')) sync(); });
    window.addEventListener('pageshow', sync);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
    else sync();
})();
