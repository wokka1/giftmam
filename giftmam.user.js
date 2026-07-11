// ==UserScript==
// @name         GiftMAM
// @namespace    https://github.com/Photaz/GiftMAM
// @version      2.2.5
// @description  Scrapes, checks history, and gifts new users directly from the browser.
// @author       Photaz
// @license      MIT
// @match        https://www.myanonamouse.net/*
// @updateURL    https://raw.githubusercontent.com/wokka1/giftmam/main/giftmam.user.js
// @downloadURL  https://raw.githubusercontent.com/wokka1/giftmam/main/giftmam.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

/* global $, updateTimer, submitShout, sbLoad, startSBupdate, hideSBmenu */

(function() {
    'use strict';

    // === CONFIGURATION ===
    const DB_KEY = 'mam_gift_history_v1';
    const ARCHIVE_KEY = 'mam_gift_archive_count';
    const PRUNE_DAYS = 30;

    const cfg = {
        get: (k, def) => { const v = GM_getValue('mam_cfg_'+k); return v === undefined ? def : v; },
        set: (k, v) => GM_setValue('mam_cfg_'+k, v)
    };

    // --- DATA MIGRATIONS ---
    if (cfg.get('newsTweak') === 'dismissible') {
        cfg.set('newsTweak', 'click');
    }

    function applyTheme() {
        const theme = cfg.get('theme', 'auto');
        const isLight = (theme === 'light') || (theme === 'auto' && document.getElementById('ICGstation.css'));
        if (isLight) document.body.classList.add('mam-light-theme');
        else document.body.classList.remove('mam-light-theme');
    }

    applyTheme();

    let stopRequested = false;
    let isMinimized = false;
    let heartbeatTimer = null;
    let isAutoActive = false;
    let isRunning = false;
    let isRemoteRunning = false;
    let isSoftPaused = false;
    let currentBP = 0;
    let lastHeartbeatTime = Date.now();
    let virtualQueue = [];
    const targetUIDs = {};
    let giftTimestamps = []; // Rolling window array for API rate limits

    window.updateUIBP = () => {
        let shortBP = currentBP;
        if (currentBP >= 1000) shortBP = Math.ceil(currentBP / 1000) + 'K';

        // Update GiftMAM UI
        const customUiBp = document.getElementById('ui-bp');
        if (customUiBp) {
            customUiBp.textContent = shortBP;
            if (customUiBp.parentElement) {
                customUiBp.parentElement.title = `Bonus Points: ${currentBP.toLocaleString('en-US')}`;
            }
        }

        // Update Native Site UI
        const siteBP = document.getElementById('tmBP');
        if (siteBP) {
            siteBP.dataset.exactBP = currentBP;
            siteBP.textContent = `Bonus: ${currentBP}`;
        }
    };

    function broadcastState() {
        if (window.mamSyncChannel) {
            window.mamSyncChannel.postMessage({
                type: 'SYNC_STATE',
                data: { isRunning, isAutoActive, isSoftPaused }
            });
        }
    }

    // Release the lock for other tabs if this tab is closed while running
    window.addEventListener('beforeunload', () => {
        if (isRunning || isAutoActive || isSoftPaused) {
            isRunning = false;
            isAutoActive = false;
            isSoftPaused = false;
            broadcastState();
        }
    });

    if (window.mamSyncChannel) window.mamSyncChannel.close();
    const syncChannel = new BroadcastChannel('mam_gift_sync');
    window.mamSyncChannel = syncChannel;

    syncChannel.onmessage = (e) => {
        const { type, data } = e.data;
        if (type === 'SYNC_UPDATE') {
            virtualQueue = [...new Set([...virtualQueue, ...data.virtualQueue])].filter(u => db.isEligible(u));
            currentBP = data.currentBP;
            lastHeartbeatTime = data.timestamp;
            if (typeof window.updateUICounts === 'function') window.updateUICounts();
            if (typeof window.updateUIBP === 'function') window.updateUIBP();
            if (data.htmlUpdate && (location.pathname === '/' || location.pathname === '/index.php')) {
                const liveContainer = document.querySelector('#newestMembers');
                if (liveContainer) { liveContainer.innerHTML = data.htmlUpdate; visualizeAll(); }
            }
            if (isAutoActive && !isRunning && virtualQueue.length > 0) {
                if (typeof window.mamRunBatch === 'function') window.mamRunBatch(true);
            }
        } else if (type === 'SYNC_GIFTED') {
            db.add(data.username, true);
            currentBP = data.currentBP;
            virtualQueue = virtualQueue.filter(u => u !== data.username);
            if (typeof window.updateUICounts === 'function') window.updateUICounts();
            if (typeof window.updateUIBP === 'function') window.updateUIBP();
            markUserAsGifted(data.username);
        } else if (type === 'SYNC_REQUEST_STATE') {
            if (isRunning || isAutoActive || isSoftPaused) {
                broadcastState();
            }
        } else if (type === 'SYNC_STATE') {
            const remoteIsBusy = data.isRunning || data.isAutoActive || data.isSoftPaused;
            isRemoteRunning = remoteIsBusy;

            if (remoteIsBusy) {
                if (isAutoActive || isRunning) {
                    isAutoActive = false;
                    stopRequested = true;
                    const btnRun = document.querySelector('#btn-run');
                    if (btnRun) btnRun.classList.remove('stopping');
                }
                if (typeof window.applyRemoteState === 'function') window.applyRemoteState(true, data);
            } else {
                if (typeof window.applyRemoteState === 'function') window.applyRemoteState(false, data);
            }
        }
    };

    // === UI STYLES ===
    document.getElementById('mam-gift-styles')?.remove();
    const style = document.createElement('style');
    style.id = 'mam-gift-styles';
    style.textContent = `
        /* --- VISUAL MARKS --- */
        label.mam-gifted-user { display: inline-flex !important; align-items: center; white-space: nowrap; vertical-align: bottom; }
        label.mam-gifted-user input { flex-shrink: 0; margin-top: 0; }
        label.mam-gifted-user a { display: inline-flex; align-items: center; overflow: hidden; flex: 1; margin-left: 4px; }
        label.mam-gifted-user a span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        a.mam-gifted-inline { opacity: 0.35 !important; transition: opacity 0.2s; }
        a.mam-gifted-inline:hover { opacity: 1 !important; }

        .mam-locked-cb { cursor: default !important; accent-color: #0075FF !important; opacity: 1 !important; }

        /* --- PANEL --- */
        #mam-gift-panel {
            position: fixed; width: 300px; height: auto;
            background: var(--secondary-background, #131313); color: var(--main-text-color, #eee);
            border: 1px solid var(--secondary-border, #111); border-radius: 8px; padding: 0;
            z-index: 9999; box-shadow: 0 4px 15px rgba(0,0,0,0.6);
            font-family: 'Segoe UI', sans-serif; font-size: 13px;
            transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
            overflow: hidden; display: flex; flex-direction: column;
        }

        .mam-pos-br { bottom: 20px; right: calc(1% + 15px); top: auto; left: auto; }
        .mam-pos-bl { bottom: 20px; left: calc(1% + 15px); top: auto; right: auto; }
        .mam-pos-tr { top: 308px; right: calc(1% + 15px); bottom: auto; left: auto; }
        .mam-pos-tl { top: 308px; left: calc(1% + 15px); bottom: auto; right: auto; }

        /* --- WIDGET POS SELECTOR --- */
        .mam-pos-grid { display: flex; gap: 4px; background: var(--main-background, #333); padding: 3px; border-radius: 4px; border: 1px solid var(--container-border, #555); }
        .mam-pos-btn { width: 16px; height: 16px; background: transparent; border: 1px solid var(--container-border, #666); border-radius: 2px; cursor: pointer; position: relative; opacity: 0.5; transition: all 0.2s; padding: 0; display: flex; align-items: center; justify-content: center; }
        .mam-pos-btn:hover { opacity: 0.8; background: rgba(128,128,128,0.1); }
        .mam-pos-btn.active { opacity: 1; border-color: #4CAF50; background: rgba(76, 175, 80, 0.15); }
        .mam-pos-btn::after { content: ''; position: absolute; width: 4px; height: 4px; background: currentColor; border-radius: 1px; }
        .mam-pos-btn[data-pos="tl"]::after { top: 2px; left: 2px; }
        .mam-pos-btn[data-pos="tr"]::after { top: 2px; right: 2px; }
        .mam-pos-btn[data-pos="bl"]::after { bottom: 2px; left: 2px; }
        .mam-pos-btn[data-pos="br"]::after { bottom: 2px; right: 2px; }
        .mam-light-theme .mam-pos-btn.active { border-color: #2e7d32; background: rgba(46, 125, 50, 0.1); }

        /* --- MINIMIZED STATE --- */
        #mam-gift-panel.mam-minimized {
            width: 60px; height: 60px; padding: 0; border-radius: 50%;
            cursor: pointer; overflow: visible;
            display: flex; align-items: center; justify-content: center;
            background: var(--secondary-background, #131313); border: 1px solid var(--secondary-border, #111);
            box-shadow: 0 4px 8px rgba(0,0,0,0.4);
        }
        #mam-gift-panel.mam-minimized .panel-content { display: none; }
        #mam-gift-panel.mam-minimized .minimized-icon { display: flex; }
        #mam-gift-panel.mam-minimized .progress-ring { display: block; }

        .minimized-icon {
            display: none; width: 100%; height: 100%; align-items: center; justify-content: center;
            font-size: 24px; position: absolute; top: 0; left: 0; z-index: 2;
            text-shadow: -1px -1px 0 #111, 1px -1px 0 #111, -1px 1px 0 #111, 1px 1px 0 #111, 0 3px 4px rgba(0,0,0,0.6);
            transition: opacity 2s ease-in-out;
        }

        .progress-ring { display: none; position: absolute; top: -5px; left: -5px; width: 70px; height: 70px; transform: rotate(-90deg); z-index: 1; pointer-events: none; }
        .progress-ring__circle { stroke: #777; stroke-width: 4; fill: transparent; stroke-dasharray: 200; stroke-dashoffset: 200; transition: stroke-dashoffset 0.5s ease-in-out, stroke 0.3s ease; }
        .progress-ring__bg { stroke: var(--container-border, #444); stroke-width: 4; fill: var(--secondary-background, #131313); }
        .mam-gifting .progress-ring__circle { stroke: #4CAF50; }
        .mam-sleeping .progress-ring__circle { stroke: #5EB9FF; }

        @keyframes mam-breathe-sleep { 0%, 100% { transform: scale(0.8); opacity: 0.6; } 50% { transform: scale(1.1); opacity: 1; } }
        .mam-sleeping .minimized-icon { animation: mam-breathe-sleep 3s ease-in-out infinite; }
        @keyframes pulse-gift { 0% { transform: scale(1); } 50% { transform: scale(1.2); } 100% { transform: scale(1); } }
        .mam-gift-pulse .minimized-icon { animation: pulse-gift 0.3s ease-out; }
        .error-badge { position: absolute; top: 0; right: 0; color: #ff9800; font-size: 16px; background: #222; border-radius: 50%; padding: 2px; display: none; z-index: 3; }

        /* --- MAXIMIZED UI --- */
        .mam-panel-title { margin: 0; color: var(--text-important, #eee); font-size: 15px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.8); }
        .title-emoji { text-shadow: -1px -1px 0 #111, 1px -1px 0 #111, -1px 1px 0 #111, 1px 1px 0 #111, 0 3px 4px rgba(0,0,0,0.6); margin-right: 4px; }

        .dialog-header {
            background: var(--secondary-background, #252525); padding: 8px 8px; margin: 0;
            border: none !important; border-bottom: 1px solid rgba(128, 128, 128, 0.2) !important; border-radius: 0;
            display: flex; justify-content: space-between; align-items: center;
        }
.toolbar { display: flex; gap: 8px; align-items: center; justify-content: space-between; background: var(--secondary-background, #252525); padding: 4px 8px; margin: 0; border-top: 1px solid rgba(128, 128, 128, 0.2); position: relative; }
        .toolbar select { background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; width: 75px; }
        .toolbar select:disabled { opacity: 0.5; cursor: not-allowed; }

        .btn-refresh { background: none; border: none; font-size: 16px; color: inherit; opacity: 0.6; cursor: pointer; padding: 0 4px; transition: transform 0.2s, opacity 0.2s; display: flex; align-items: center; justify-content: center; }
        .btn-refresh:hover { transform: rotate(180deg); opacity: 1; }
        .log-refresh-btn { position: absolute; top: 6px; right: 8px; opacity: 0.3; background: transparent; padding: 2px 4px; border-radius: 4px; z-index: 5; }
        .log-refresh-btn:hover { opacity: 1; background: var(--main-background, #222); }

        #mam-log { height: 128px; box-sizing: border-box; line-height: 14px; overflow-y: auto; background: var(--secondary-background, #000); box-shadow: inset 0 2px 5px rgba(0,0,0,0.3); border: none; padding: 8px 15px; font-family: monospace; font-size: 11px; margin: 0; }
        .log-success { color: #66bb6a; } .log-error { color: #ef5350; } .log-info { color: #bbb; } .log-warn { color: #ffca28; }
        #fpNM .blockFoot #mam-log { background: transparent; color: #aaa; text-shadow: 1px 1px 1px rgba(0,0,0,0.5); }

        /* Light Theme Overrides */
        .mam-light-theme .log-success, .mam-light-theme .sb-log-success { color: #1b5e20 !important; font-weight: 800; text-shadow: 0 1px 1px rgba(255,255,255,0.8) !important; }
        .mam-light-theme .log-error, .mam-light-theme .sb-log-error { color: #b71c1c !important; font-weight: 800; text-shadow: 0 1px 1px rgba(255,255,255,0.8) !important; }
        .mam-light-theme .log-info, .mam-light-theme .sb-log-info { color: #222 !important; font-weight: 600; text-shadow: none !important; }
        .mam-light-theme .log-warn, .mam-light-theme .sb-log-warn { color: #bf360c !important; font-weight: 800; text-shadow: none !important; }
        .mam-light-theme #mam-log { box-shadow: inset 0 2px 4px rgba(0,0,0,0.1); border: 1px solid var(--container-border); text-shadow: none !important; color: #222; }
        .mam-light-theme #fpNM .blockFoot #mam-log { background: transparent !important; text-shadow: none !important; color: #222; }
        .mam-light-theme .mam-floating-log { background: rgba(240, 240, 240, 0.95); color: #222; border: 1px solid rgba(0,0,0,0.15); box-shadow: 0 4px 10px rgba(0,0,0,0.15); }
        .mam-light-theme #mam-gift-panel { border: 1px solid var(--main-border, #ccc); }
        .mam-light-theme .mam-panel-title { color: var(--main-text-color, #222); text-shadow: none; }
        .mam-light-theme #ui-db-count { color: #2e7d32 !important; font-weight: 800 !important; text-shadow: 0 1px 1px rgba(255,255,255,0.8) !important; }
        .mam-light-theme .stat-text span[style*="#00bcd4"] { color: #00838f !important; font-weight: 800 !important; text-shadow: 0 1px 1px rgba(255,255,255,0.8) !important; }
        .mam-light-theme span[title^="Bonus Points"] { color: #c67100 !important; font-weight: 800 !important; text-shadow: 0 1px 1px rgba(255,255,255,0.8) !important; }

        /* --- GLOBAL BUTTON & STAT STYLES --- */
        .toolbar .btn-start { width: 36px; padding: 4px 0; font-size: 14px; margin: 0; display: flex; align-items: center; justify-content: center; background: #4CAF50 !important; border-radius: 4px; cursor: pointer; border: none; text-shadow: -1px -1px 0 #111, 1px -1px 0 #111, -1px 1px 0 #111, 1px 1px 0 #111, 0 3px 4px rgba(0,0,0,0.6); box-shadow: 0 2px 4px rgba(0,0,0,0.3); transition: background 0.2s; }
        .toolbar .btn-start:hover { background: #45a049 !important; }
        .toolbar .btn-start.stopping { background: #d32f2f !important; }
        .stat-text { display: flex; gap: 10px; font-size: 12px; font-weight: bold; white-space: nowrap; flex: 1; justify-content: center; align-items: center; }
        .stat-emoji { font-size: 14px; text-shadow: -1px -1px 0 #111, 1px -1px 0 #111, -1px 1px 0 #111, 1px 1px 0 #111, 0 3px 4px rgba(0,0,0,0.6); }

        .mam-heartbeat-wrap { position: absolute; top: 0; left: 0; width: 100%; height: 1px; background: rgba(128, 128, 128, 0.2); display: block !important; z-index: 10; }
        .mam-heartbeat-bar { height: 100%; width: 0%; background: #5EB9FF; transition: none; }
        .mam-heartbeat-bar.mam-animating { transition: width 1s linear; }

        /* --- INLINE UI & MAM+ OVERRIDES --- */
        #fpNM input#mp_giftAmounts, #fpNM button[id^="mp_gift"], #fpNM button[id^="mp_openTabs"], #fpNM span#mp_giftAllMsg, #fpNM a:last-of-type ~ br { display: none !important; }
        #sbMenuMain #giftButton { display: none !important; }
        .inline-gift-ui { margin-top: 10px; padding-top: 0; border-top: none; display: flex; flex-direction: column; gap: 6px; font-family: 'Segoe UI', sans-serif; box-sizing: border-box; width: 100%; max-width: 100%; overflow: visible; position: relative; }
        .inline-gift-ui .toolbar { background: none; padding: 8px 0 0 0; border: none; margin-top: 0; }

        @keyframes mamFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .inline-gift-ui #mam-log { height: 50px; overflow-y: auto; background: #000; border: 1px solid #333; padding: 4px; font-family: monospace; font-size: 11px; margin: 0; text-align: left; }

        /* --- SHOUTBOX LOG --- */
        /* --- SHOUTBOX FLOATING LOGS --- */
        .mam-floating-log { position: absolute; right: 20px; background: rgba(20, 20, 20, 0.85); padding: 8px 14px; border-radius: 20px; font-family: 'Segoe UI', sans-serif; font-size: 12px; font-weight: 600; z-index: 9999; pointer-events: none; backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 4px 10px rgba(0,0,0,0.5); animation: floatUpFade 5s ease-out forwards; display: flex; align-items: center; gap: 6px; }
        .mam-floating-log.log-success { border-color: rgba(76, 175, 80, 0.5); color: #81c784; }
        .mam-floating-log.log-error { border-color: rgba(244, 67, 54, 0.5); color: #e57373; }
        .mam-floating-log.log-info { border-color: rgba(94, 185, 255, 0.5); color: #90caf9; }

        @keyframes floatUpFade {
            0% { opacity: 0; transform: translateY(15px) scale(0.9); }
            10% { opacity: 1; transform: translateY(0) scale(1); }
            85% { opacity: 1; transform: translateY(-25px); }
            100% { opacity: 0; transform: translateY(-40px); }
        }

        .mam-settings-view input[type="number"]::-webkit-inner-spin-button,
        .mam-settings-view input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
        .mam-settings-view input[type="number"] { -moz-appearance: textfield !important; appearance: textfield !important; }

        /* --- DAILIES BUTTONS --- */
        .mam-daily-btn { font-size: 16px; line-height: 1; cursor: pointer; transition: all 0.2s ease-in-out; display: inline-flex; align-items: center; transform: translateY(-2px); text-decoration: none !important; vertical-align: middle; }
        .mam-daily-btn:hover { opacity: 1 !important; filter: none !important; text-decoration: none !important; }
        .mam-daily-btn[data-active="true"] { opacity: 1; filter: none; }
        .mam-daily-btn[data-active="false"] { opacity: 0.4; filter: grayscale(100%); }
    `;
    document.head.appendChild(style);

    // === IN-MEMORY DATABASE MANAGER ===
    let dbCache = null;
    let archiveCountCache = null;

    const db = {
        load: () => {
            if (dbCache === null) {
                const raw = GM_getValue(DB_KEY);
                if (typeof raw === 'string') {
                    try { dbCache = JSON.parse(raw); } catch(e) { dbCache = {}; }
                } else if (typeof raw === 'object' && raw !== null) {
                    dbCache = raw;
                } else {
                    dbCache = {};
                }
            }
            return dbCache;
        },
        save: () => GM_setValue(DB_KEY, dbCache),
        add: (username, skipSave = false) => {
            db.load();
            dbCache[username] = Date.now();
            if (!skipSave) db.save();
        },
        has: (username) => {
            db.load();
            return !!dbCache[username];
        },
        isEligible: (username) => {
            db.load();
            if (!dbCache[username]) return true;
            const cooldown = cfg.get('cooldownDays', 0);
            if (cooldown === 0) return false; // 0 means 'Once', so never regift
            const elapsedDays = (Date.now() - dbCache[username]) / (1000 * 60 * 60 * 24);
            return elapsedDays >= cooldown;
        },
        getArchivedCount: () => {
            if (archiveCountCache === null) {
                const raw = GM_getValue(ARCHIVE_KEY, 0);
                archiveCountCache = parseInt(raw, 10) || 0;
            }
            return archiveCountCache;
        },
        prune: () => {
            db.load();
            const now = Date.now();
            const cutoff = PRUNE_DAYS * 24 * 60 * 60 * 1000;
            let removed = 0;
            for (const [user, timestamp] of Object.entries(dbCache)) {
                if (now - timestamp > cutoff) {
                    delete dbCache[user];
                    removed++;
                }
            }
            if (removed > 0) {
                db.save();
                archiveCountCache = db.getArchivedCount() + removed;
                GM_setValue(ARCHIVE_KEY, archiveCountCache.toString());
            }
            return removed;
        },
        count: () => {
            db.load();
            return Object.keys(dbCache).length + db.getArchivedCount();
        }
    };

    const spendLog = {
        add: (msg) => {
            let logs = [];
            try { logs = JSON.parse(GM_getValue('mam_spend_log', '[]')); } catch(e){}
            logs.unshift({ t: Date.now(), m: msg });
            const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
            // Retain last 7 days, cap at 150 entries to prevent storage bloat
            logs = logs.filter(x => x.t > cutoff).slice(0, 150);
            GM_setValue('mam_spend_log', JSON.stringify(logs));
        },
        get: () => {
            try {
                const logs = JSON.parse(GM_getValue('mam_spend_log', '[]'));
                const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
                return logs.filter(x => x.t > cutoff);
            } catch(e){ return []; }
        }
    };

    // --- VISUAL HELPERS ---
    function markUserAsGifted(usernameOrElement) {
        const process = (link) => {
            if (link.classList.contains('mp_gifted')) return;
            link.classList.add('mp_gifted');
            const label = link.closest('label');

            if (label) {
                const cb = label.querySelector('input[type="checkbox"]');
                if (cb) {
                    cb.checked = true;
                    cb.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    };
                    label.classList.add('mam-gifted-user');
                    cb.classList.add('mam-locked-cb');
                }
            } else {
                link.classList.add('mam-gifted-inline');
            }
        };

        if (typeof usernameOrElement === 'string') {
            const links = document.querySelectorAll('.blockBodyCon label a, #fpNM a[href^="/u/"], #newestMembers a[href^="/u/"]');
            links.forEach(link => {
                if (link.textContent.trim().split(' ')[0] === usernameOrElement) process(link);
            });
        } else {
            process(usernameOrElement);
        }
    }

    function visualizeAll() {
        const links = document.querySelectorAll('.blockBodyCon label a:not(.mp_gifted), #fpNM a[href^="/u/"]:not(.mp_gifted), #newestMembers a[href^="/u/"]:not(.mp_gifted)');
        links.forEach(link => {
            const name = link.textContent.trim().split(' ')[0];
            const label = link.closest('label');
            const cb = label ? label.querySelector('input[type="checkbox"]') : null;

            if ((db.has(name) && !db.isEligible(name)) || link.classList.contains('mam-gifted-inline') || (cb && cb.checked)) {
                markUserAsGifted(link);
                if (!db.has(name)) db.add(name);
            }
        });
    }

    // --- Data Fetching ---
    function getNextLottoResetTime() {
        const d = new Date();
        const day = d.getUTCDay();
        let daysUntilMonday = (1 + 7 - day) % 7;
        if (daysUntilMonday === 0) daysUntilMonday = 7;
        d.setUTCDate(d.getUTCDate() + daysUntilMonday);
        d.setUTCHours(0, 0, 0, 0);
        return d.getTime();
    }

    function getRecentMidnightUTC() {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d.getTime();
    }

    const workers = {
        isProcessingStats: false,
        isProcessingDailies: false,

        vitalStats: async () => {
            if (workers.isProcessingStats) return;
            workers.isProcessingStats = true;

            try {
                const resp = await fetch('/jsonLoad.php');
                if (!resp.ok) throw new Error("Network response failed");
                const data = await resp.json();

                if (data.seedbonus !== undefined) {
                    currentBP = parseInt(data.seedbonus, 10);
                    if (typeof window.updateUIBP === 'function') window.updateUIBP();
                }

                const safeBuffer = 18000;
                const bpFloor = cfg.get('bpFloor', 5000);
                const hasSafePoints = currentBP > (bpFloor + safeBuffer);

                // Auto-VIP
                if (cfg.get('autoVip', 'off') === 'on' && data.vip_until) {
                    const vipEnd = new Date(data.vip_until).getTime();
                    const sevenDays = 7 * 24 * 60 * 60 * 1000;
                    if (vipEnd - Date.now() < sevenDays && hasSafePoints) {
                        const vResp = await fetch(`/json/bonusBuy.php/?spendtype=VIP&duration=max`);
                        const vData = await vResp.json();
                        if (vData.success) {
                            window.log && window.log("� Auto-renewed VIP status!", "success");
                            spendLog.add("Renewed VIP status (Max)");
                            if (vData.seedbonus) currentBP = parseInt(vData.seedbonus, 10);
                        }
                    }
                }

                // Auto-Upload Buy
                const tier = cfg.get('uploadTier', 'off');
                if (tier !== 'off' && currentBP >= cfg.get('uploadTrigger', 85000)) {
                    const amountGB = parseInt(tier, 10) / 500;
                    const uResp = await fetch(`/json/bonusBuy.php/?spendtype=upload&amount=${amountGB}`);
                    const uData = await uResp.json();
                    if (uData.success) {
                        window.log && window.log(`� Auto-bought ${amountGB}GB upload credit!`, 'success');
                        spendLog.add(`Bought ${amountGB}GB upload credit`);
                        if (uData.seedbonus) currentBP = parseInt(uData.seedbonus, 10);
                    }
                }

                if (typeof window.updateUIBP === 'function') window.updateUIBP();

            } catch (e) {
                console.error("[GiftMAM] Vital Stats worker failed", e);
            } finally {
                workers.isProcessingStats = false;
            }
        },

        dailies: async () => {
            if (workers.isProcessingDailies) return;
            workers.isProcessingDailies = true;
            const now = Date.now();

            try {
                const alertContainer = document.getElementById('mam-panel-actions');
                if (!alertContainer) return;

                // --- Vault Reminder (Persistent UI) ---
                const vMode = cfg.get('vaultMode', 'off');
                let existingVaultBtn = document.getElementById('mam-vault-donate-btn');
                const nextVaultReset = parseInt(GM_getValue('mam_vault_next_reset', '0'), 10);

                if (vMode === 'off') {
                    if (existingVaultBtn) existingVaultBtn.remove();
                } else {
                    let shouldDonate = false;
                    const millionInfo = document.getElementById('millionInfo');
                    window.mamPageLoadTime = window.mamPageLoadTime || Date.now();
                    const isStaleDOM = window.mamPageLoadTime < getRecentMidnightUTC();

                    if (millionInfo) {
                        if (!millionInfo.title.includes("not donated today") && !isStaleDOM) {
                            // Authoritative state: Donation is complete. Lock timer to tomorrow.
                            GM_setValue('mam_vault_next_reset', (getRecentMidnightUTC() + 86400000).toString());
                            shouldDonate = false;
                        } else if (now > nextVaultReset) {
                            shouldDonate = true;
                        }
                    } else if (now > nextVaultReset) {
                        shouldDonate = true;
                    }

                    if (!existingVaultBtn) {
                        existingVaultBtn = document.createElement('a');
                        existingVaultBtn.id = 'mam-vault-donate-btn';
                        existingVaultBtn.className = 'mam-daily-btn';
                        existingVaultBtn.innerHTML = '�';
                        existingVaultBtn.href = '/millionaires/donate.php';
                        existingVaultBtn.target = '_blank';

                        existingVaultBtn.onclick = () => {
                            existingVaultBtn.dataset.active = 'false';
                            existingVaultBtn.title = 'Vault (Snoozed/Completed)';
                            GM_setValue('mam_vault_next_reset', (Date.now() + 300000).toString());
                        };
                        alertContainer.appendChild(existingVaultBtn);
                    }

                    if (shouldDonate) {
                        existingVaultBtn.dataset.active = 'true';
                        existingVaultBtn.title = 'Vault Reminder (Click to donate)';
                    } else {
                        existingVaultBtn.dataset.active = 'false';
                        existingVaultBtn.title = 'Vault (Completed)';
                    }
                }

                // --- Lotto Reminder (Persistent UI) ---
                const lMode = cfg.get('lottoMode', 'off');
                let existingLottoBtn = document.getElementById('mam-lotto-enter-btn');
                const nextLotto = parseInt(GM_getValue('mam_lotto_next_check', '0'), 10);

                if (lMode === 'off') {
                    if (existingLottoBtn) existingLottoBtn.remove();
                } else {
                    const needsLotto = now > nextLotto;

                    if (!existingLottoBtn) {
                        existingLottoBtn = document.createElement('a');
                        existingLottoBtn.id = 'mam-lotto-enter-btn';
                        existingLottoBtn.className = 'mam-daily-btn';
                        existingLottoBtn.innerHTML = '�';
                        existingLottoBtn.href = '/play_lotto.php';
                        existingLottoBtn.target = '_blank';

                        existingLottoBtn.onclick = () => {
                            existingLottoBtn.dataset.active = 'false';
                            existingLottoBtn.title = 'Lotto (Completed)';
                            GM_setValue('mam_lotto_next_check', getNextLottoResetTime().toString());
                        };
                        alertContainer.appendChild(existingLottoBtn);
                    }

                    if (needsLotto) {
                        existingLottoBtn.dataset.active = 'true';
                        existingLottoBtn.title = 'Lotto Reminder (Click to enter)';
                    } else {
                        existingLottoBtn.dataset.active = 'false';
                        existingLottoBtn.title = 'Lotto (Completed)';
                    }
                }

            } catch (e) {
                console.error("[GiftMAM] Dailies worker failed", e);
            } finally {
                workers.isProcessingDailies = false;
            }
        }
    };

    function getTargetsFromDOM(doc = document) {
        const links = doc.querySelectorAll('.blockBodyCon label a, #fpNM a[href^="/u/"], #newestMembers a[href^="/u/"]');
        const found = [];
        links.forEach(link => {
            let name = link.textContent.trim().split(' ')[0];
            const isGifted = link.classList.contains('mp_gifted') || link.classList.contains('mam-gifted-inline');

            // Extract UID for Just-In-Time JSON lookups
            const hrefMatch = link.href.match(/\/u\/(\d+)/);
            if (hrefMatch) targetUIDs[name] = hrefMatch[1];

            if (name && db.isEligible(name) && !isGifted) {
                found.push(name);
            }
        });
        return [...new Set(found)];
    }

    const syncEngine = {
        isLeader: false,
        syncPromise: null,

        attemptElection: () => {
            const now = Date.now();
            const lockTime = parseInt(GM_getValue('mam_leader_lock', '0'), 10);
            // Lock expires after 15 seconds to prevent dead tabs from stalling the script
            if (now - lockTime > 15000) {
                GM_setValue('mam_leader_lock', now.toString());
                syncEngine.isLeader = true;
                return true;
            }
            // If we are already the leader, extend our lock
            if (syncEngine.isLeader) {
                GM_setValue('mam_leader_lock', now.toString());
                return true;
            }
            return false;
        },

        pulseCheck: async () => {
            if (!syncEngine.attemptElection()) return 0;

            try {
                const resp = await fetch('/json/newestMembers.php');
                if (!resp.ok) return 0;
                const html = await resp.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const links = Array.from(doc.querySelectorAll('a'));

                if (links.length === 0) return 0;

                const currentSet = new Set(virtualQueue);
                let addedCount = 0;

                // Process widget users directly to save hits
                links.forEach(link => {
                    const name = link.textContent.trim().split(' ')[0];
                    const hrefMatch = link.href.match(/\/u\/(\d+)/);
                    if (hrefMatch) targetUIDs[name] = hrefMatch[1];

                    if (name && !currentSet.has(name) && db.isEligible(name) && !db.has(name)) {
                        virtualQueue.push(name);
                        currentSet.add(name);
                        addedCount++;
                    }
                });

                // Gap Detection: Is the oldest user in the sliding window unknown to us?
                const oldestName = links[links.length - 1].textContent.trim().split(' ')[0];
                const gapDetected = !db.has(oldestName) && db.isEligible(oldestName);

                const lastMacro = parseInt(GM_getValue('mam_last_macro', '0'), 10);
                const macroNeeded = gapDetected || (Date.now() - lastMacro > 43200000); // 12 hour safety net

                if (macroNeeded) {
                    if (gapDetected) window.log && window.log("�️ Gap detected in widget. Triggering deep sync...", "warn");
                    return await syncEngine.macroSync(false);
                }

                // If no macro is needed but we found users, update state normally
                if (addedCount > 0) {
                    if (typeof window.updateUICounts === 'function') window.updateUICounts();
                    if (location.pathname === '/' || location.pathname === '/index.php') {
                        const liveContainer = document.querySelector('#newestMembers');
                        if (liveContainer) { liveContainer.innerHTML = html; visualizeAll(); }
                    }
                    syncChannel.postMessage({
                        type: 'SYNC_UPDATE',
                        data: { virtualQueue, currentBP, timestamp: Date.now(), htmlUpdate: html }
                    });
                }

                return addedCount;
            } catch (e) {
                console.error("[GiftMAM] Pulse failed", e);
                return 0;
            }
        },

        macroSync: async (isManual = false) => {
            if (syncEngine.syncPromise) {
                if (isManual) window.log && window.log("� Sync already in progress...", "info");
                return syncEngine.syncPromise;
            }

            syncEngine.syncPromise = (async () => {
                if (isManual) {
                    window.log && window.log("� Deep Syncing...", "info");
                    lastHeartbeatTime = Date.now();
                }

                try {
                    // Fetch full list to catch overflow, and widget to keep UI up to date
                    const [response, widgetResp] = await Promise.all([
                        fetch('/newUsers.php'),
                        fetch('/json/newestMembers.php')
                    ]);
                    const text = await response.text();
                    const htmlUpdate = widgetResp.ok ? await widgetResp.text() : null;
                    const doc = new DOMParser().parseFromString(text, 'text/html');

                    const currentSet = new Set(virtualQueue);
                    const newTargets = getTargetsFromDOM(doc); // This will also capture UIDs
                    const addedCount = newTargets.filter(u => !currentSet.has(u) && db.isEligible(u)).length;

                    virtualQueue = [...new Set([...virtualQueue, ...newTargets])].filter(u => db.isEligible(u));
                    if (typeof window.updateUICounts === 'function') window.updateUICounts();

                    if (htmlUpdate && (location.pathname === '/' || location.pathname === '/index.php')) {
                        const liveContainer = document.querySelector('#newestMembers');
                        if (liveContainer) { liveContainer.innerHTML = htmlUpdate; visualizeAll(); }
                    }

                    syncChannel.postMessage({
                        type: 'SYNC_UPDATE',
                        data: { virtualQueue, currentBP, timestamp: lastHeartbeatTime, htmlUpdate }
                    });

                    GM_setValue('mam_last_macro', Date.now().toString());

                    if (addedCount > 0) {
                        const mouseWord = addedCount === 1 ? 'mouse' : 'mice';
                        window.log && window.log(`� Recovered ${addedCount} overflow ${mouseWord}!`, "success");
                    } else if (isManual) {
                        window.log && window.log(`� No new mice...`, "info");
                    }

                    return virtualQueue.length;
                } catch (e) {
                    if (isManual) window.log && window.log("� Sync failed.", "error");
                    return 0;
                } finally {
                    syncEngine.syncPromise = null;
                }
            })();

            return syncEngine.syncPromise;
        }
    };

    async function sendGift(username) {
        let amtSetting = cfg.get('giftAmt', '100').toString().toLowerCase();
        let parsedAmt = parseInt(amtSetting, 10);
        let finalAmt = 100;
        const uid = targetUIDs[username];

        // Optimized execution: Only perform a JSON class lookup if attempting to send > 100 points
        if (amtSetting === 'max' || (parsedAmt && parsedAmt > 100)) {
            if (uid) {
                try {
                    const classResp = await fetch(`/jsonLoad.php?id=${uid}`);
                    if (classResp.ok) {
                        const classData = await classResp.json();
                        const cName = classData.classname || '';
                        const maxAllowed = (cName === 'Mouse' || cName === 'User') ? 100 : 1000;
                        finalAmt = (amtSetting === 'max') ? maxAllowed : Math.min(parsedAmt, maxAllowed);
                    }
                } catch (e) {
                    window.log && window.log(`⚠️ Class check failed for ${username}. Defaulting to 100 BP.`, 'warn');
                }

                // Rate Limit Mitigation: 3-3.5s delay separating the class check from the gift action
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 500));
            }
        } else {
            finalAmt = parsedAmt || 100;
        }

        try {
            // Send via UID directly to bypass username encoding risks
            const target = uid ? uid : encodeURIComponent(username);
            const url = `https://www.myanonamouse.net/json/bonusBuy.php?spendtype=gift&amount=${finalAmt}&giftTo=${target}`;
            const resp = await fetch(url);
            if (!resp.ok) return { success: false, error: `HTTP ${resp.status}`, amount: finalAmt };
            const data = await resp.json();
            return data.success ? { success: true, amount: finalAmt } : { success: false, error: data.error || "Unknown API error", amount: finalAmt };
        } catch (e) {
            return { success: false, error: e.message, amount: finalAmt };
        }
    }

    // === UI MANAGER ===
    function createPanel(isInline = false) {
        document.getElementById('mam-gift-panel')?.remove();
        document.querySelector('.inline-gift-ui')?.remove();

        const div = document.createElement('div');
        const radius = 32;
        const circumference = 2 * Math.PI * radius;

       const settingsHTML = `<div class="mam-settings-view" style="display: none; padding: 10px; background: var(--secondary-background, #1a1a1a); border: 1px solid var(--container-border, #444); border-radius: 4px; font-size: 11px; height: 128px; width: 100%; box-sizing: border-box; overflow-y: auto; text-align: left; margin: 0;"><div class="mam-setting-group" style="color: var(--text-important, #ddd); margin: 0 0 4px; border-bottom: 1px solid var(--container-border, #444); padding-bottom: 2px;"><strong>� BP Management</strong></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Default Gift (5-1000 or max):</label><input type="text" id="cfg-gift-amt" value="100" placeholder="max" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Stop Gifting When BP Below:</label><input type="number" id="cfg-bp-floor" value="5000" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"></div><div class="mam-setting-group" style="color: var(--text-important, #ddd); margin: 6px 0 4px; border-bottom: 1px solid var(--container-border, #444); padding-bottom: 2px;"><strong>� Auto-Spend Options</strong></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Auto-Buy Amount:</label><select id="cfg-auto-upload-tier" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off" selected>Off</option><option value="10000">20G/10k</option><option value="25000">50G/25k</option><option value="50000">100G/50k</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Buy When BP Above:</label><input type="number" id="cfg-auto-upload-trigger" value="85000" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Auto-Renew VIP:</label><select id="cfg-auto-vip" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off" selected>Off</option><option value="on">Weekly</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Vault Reminder:</label><select id="cfg-vault-mode" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off">Off</option><option value="on">On</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Lotto Reminder:</label><select id="cfg-lotto-mode" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off" selected>Off</option><option value="on">On</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><button id="btn-spend-log" style="background: #333; color: #eee; border: 1px solid #555; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex: 1; text-align: center;">View 7-Day Spend Log</button></div><div id="spend-log-container" style="display: none; background: var(--secondary-background, #111); border: 1px inset var(--container-border, #444); padding: 6px; margin-bottom: 4px; max-height: 120px; overflow-y: auto; font-family: monospace; font-size: 10px; color: #bbb; line-height: 1.4;"></div><div class="mam-setting-group" style="color: var(--text-important, #ddd); margin: 6px 0 4px; border-bottom: 1px solid var(--container-border, #444); padding-bottom: 2px;"><strong>� Automation</strong></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Gift Cooldown:</label><select id="cfg-cooldown-days" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="0" selected>Once</option><option value="1">1 Day</option><option value="2">2 Days</option><option value="3">3 Days</option><option value="7">7 Days</option></select></div><div class="mam-setting-group" style="color: var(--text-important, #ddd); margin: 6px 0 4px; border-bottom: 1px solid var(--container-border, #444); padding-bottom: 2px;"><strong>� Data & UI</strong></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Widget Position:</label><div class="mam-pos-grid" id="cfg-widget-pos"><button class="mam-pos-btn" data-pos="tl" title="Top-Left"></button><button class="mam-pos-btn" data-pos="tr" title="Top-Right"></button><button class="mam-pos-btn" data-pos="bl" title="Bottom-Left"></button><button class="mam-pos-btn" data-pos="br" title="Bottom-Right"></button></div></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Theme:</label><select id="cfg-theme" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Hide News:</label><div style="display: flex; justify-content: flex-end; align-items: center; width: 85px; gap: 4px;"><button id="btn-reset-news" style="background: none; border: none; padding: 0; cursor: pointer; font-size: 13px; opacity: 0.5; transition: opacity 0.2s;" title="Unhide all news" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.5'">↩️</button><select id="cfg-news-tweak" style="width: 65px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off">Off</option><option value="click">Click</option><option value="on">On</option></select></div></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;"><label style="flex: 1; text-align: left; color: var(--main-text-color, #ccc); white-space: nowrap;">Compact Layout:</label><select id="cfg-shrink-blocks" style="width: 85px; flex-shrink: 0; background: var(--main-background, #333); color: var(--main-text-color, #eee); border: 1px solid var(--container-border, #555); padding: 2px; border-radius: 3px; font-size: 11px; text-align: right; box-sizing: border-box;"><option value="off">Off</option><option value="on">On</option></select></div><div class="mam-setting-row" style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 8px; border-top: 1px solid rgba(128,128,128,0.2); gap: 4px;"><button id="btn-export-db" style="background: #333; color: #eee; border: 1px solid #555; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex: 1; text-align: center;">Export</button><button id="btn-import-db" style="background: #333; color: #eee; border: 1px solid #555; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex: 1; text-align: center;">Import</button><button id="btn-wipe-db" style="background: #8b0000; color: #fff; border: 1px solid #600; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; flex: 1; text-align: center;">Wipe</button></div></div>`;

        if (isInline) {
            const targetContainer = document.querySelector('#fpNM .blockBodyCon');
            if (!targetContainer) {
                console.warn("[GiftMAM] Target container missing. Falling back to floating panel.");
                isInline = false;
            } else {
                div.className = 'inline-gift-ui';
                div.innerHTML = `<div class="toolbar"><div class="mam-heartbeat-wrap"><div class="mam-heartbeat-bar"></div></div><div style="flex: 1; display: flex; justify-content: flex-start;"><select id="gift-limit" title="Batch Limit"><option value="VISIBLE">Newest</option><option value="BOT">� Auto</option></select></div><div class="stat-text" style="flex: 0 1 auto;"><span title="Mice Gifted"><span class="stat-emoji">�</span> <span id="ui-db-count" style="color:#66BB6A;">${db.count()}</span></span></div><div class="stat-text" style="flex: 0 1 auto;"><span title="Bonus Points" style="color:#CCAC5B;"><span class="stat-emoji">�</span> <span id="ui-bp">...</span></span></div><div style="flex: 1; display: flex; justify-content: flex-end; gap: 6px;"><button id="btn-run" class="btn-start" title="Start Gifting">�</button></div></div><div class="mam-main-view" style="display: none;"></div>${settingsHTML}`;
                targetContainer.appendChild(div);

                const footer = document.querySelector('#fpNM .blockFoot');
                if (footer) {
                    footer.style.setProperty('position', 'relative', 'important');
                    footer.style.setProperty('min-height', '26px', 'important');
                    const logDiv = document.createElement('div');
                    logDiv.id = 'mam-log';
                    logDiv.style.cssText = 'position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; display: flex !important; align-items: center !important; justify-content: center !important; border: none !important; font-family: monospace !important; font-size: 11px !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important; z-index: 99 !important; overflow: hidden !important;';
                    footer.appendChild(logDiv);
                } else {
                    const logDiv = document.createElement('div');
                    logDiv.id = 'mam-log';
                    div.appendChild(logDiv);
                }

                const blockHead = document.querySelector('#fpNM .blockHeadCon h4');
                if (blockHead && !document.querySelector('#btn-settings')) {
                    const actionContainer = document.createElement('span');
                    actionContainer.id = 'mam-panel-actions';
                    actionContainer.style.cssText = 'display: inline-flex; gap: 8px; margin-left: 10px; vertical-align: middle; transform: translateY(1px);';
                    blockHead.appendChild(actionContainer);

                    const cogBtn = document.createElement('a');
                    cogBtn.id = 'btn-settings';
                    cogBtn.className = 'cursor';
                    cogBtn.title = "Settings";
                    cogBtn.style.cssText = 'margin-left: 6px; opacity: 0.6; transition: opacity 0.2s; display: inline-block; width: 18px; height: 18px;';
                    cogBtn.innerHTML = '<img class="invertBlue" style="width: 100%; height: 100%; display: block;" src="data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%3E%3C%2Fcircle%3E%3Cpath%20d%3D%22M19.4%2015a1.65%201.65%200%200%200%20.33%201.82l.06.06a2%202%200%200%201%200%202.83%202%202%200%200%201-2.83%200l-.06-.06a1.65%201.65%200%200%200-1.82-.33%201.65%201.65%200%200%200-1%201.51V21a2%202%200%200%201-2%202%202%202%200%200%201-2-2v-.09A1.65%201.65%200%200%200%209%2019.4a1.65%201.65%200%200%200-1.82.33l-.06.06a2%202%200%200%201-2.83%200%202%202%200%200%201%200-2.83l.06-.06a1.65%201.65%200%200%200%20.33-1.82%201.65%201.65%200%200%200-1.51-1H3a2%202%200%200%201-2-2%202%202%200%200%201%202-2h.09A1.65%201.65%200%200%200%204.6%209a1.65%201.65%200%200%200-.33-1.82l-.06-.06a2%202%200%200%201%200-2.83%202%202%200%200%201%202.83%200l.06.06a1.65%201.65%200%200%200%201.82.33H9a1.65%201.65%200%200%200%201-1.51V3a2%202%200%200%201%202-2%202%202%200%200%201%202%202v.09a1.65%201.65%200%200%200%201%201.51%201.65%201.65%200%200%200%201.82-.33l.06-.06a2%202%200%200%201%202.83%200%202%202%200%200%201%200%202.83l-.06.06a1.65%201.65%200%200%200-.33%201.82V9a1.65%201.65%200%200%200%201.51%201H21a2%202%200%200%201%202%202%202%202%200%200%201-2%202h-.09a1.65%201.65%200%200%200-1.51%201z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E" alt="settings">';
                    cogBtn.onmouseout = () => { if (div.querySelector('.mam-settings-view').style.display === 'none') cogBtn.style.opacity = '0.6'; };
                    blockHead.appendChild(cogBtn);
                }

                // The native #newestMembers DOM updates are no longer actively observed.
                // Visual states and queue ingestion are handled by the background pulse/macro sync loop.
            }
        }

        if (!isInline) {
            div.id = 'mam-gift-panel';
            div.innerHTML = `<svg class="progress-ring" width="70" height="70"><circle class="progress-ring__bg" stroke="black" stroke-width="4" fill="transparent" r="${radius}" cx="35" cy="35"/><circle class="progress-ring__circle" stroke="#4CAF50" stroke-width="4" fill="transparent" r="${radius}" cx="35" cy="35" style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${circumference}"/></svg><div class="minimized-icon">�<div class="error-badge">⚠️</div></div><div class="panel-content"><div class="dialog-header"><div style="display:flex; align-items: center;"><h3 class="mam-panel-title"><span class="title-emoji">�</span> GiftMAM</h3><div id="mam-panel-actions" style="display:flex; gap: 8px; align-items: center; margin-left: 10px; transform: translateY(1px);"></div></div><div style="display:flex; gap: 8px; align-items: center; margin-left: auto;"><button id="btn-settings" style="background:none; border:none; color:var(--main-text-color, #aaa); font-size:16px; cursor:pointer; padding:0; line-height:1;" title="Settings">⚙️</button><button id="btn-min" style="background:none; border:none; color:var(--main-text-color, #aaa); font-size:16px; cursor:pointer; padding:0; line-height:1;">—</button></div></div><div class="mam-main-view"><div style="position: relative; margin: 0;"><button class="btn-refresh log-refresh-btn" id="btn-refresh" title="Soft Refresh"><img class="invertBlue" src="/pic/refresh.svg" alt="refresh" style="width: 16px; height: 16px;"></button><div id="mam-log"></div></div></div>${settingsHTML}<div class="toolbar"><div class="mam-heartbeat-wrap"><div class="mam-heartbeat-bar"></div></div><div style="flex: 1; display: flex; justify-content: flex-start;"><select id="gift-limit" title="Batch Limit"><option value="5">5</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="ALL">ALL</option><option value="BOT">� Auto</option></select></div><div class="stat-text" style="flex: 0 1 auto;"><span title="Mice Gifted/Queue"><span class="stat-emoji">�</span> <span id="ui-db-count" style="color:#66BB6A;">${db.count()}</span></span></div><div class="stat-text" style="flex: 0 1 auto;"><span title="Bonus Points" style="color:#CCAC5B;"><span class="stat-emoji">�</span> <span id="ui-bp">...</span></span></div><div style="flex: 1; display: flex; justify-content: flex-end; gap: 6px;"><button id="btn-run" class="btn-start" title="Start Gifting">�</button></div></div></div>`;
            document.body.appendChild(div);
        }

        const logBox = isInline ? document.querySelector('#fpNM .blockFoot #mam-log') : div.querySelector('#mam-log');
        const uiDb = div.querySelector('#ui-db-count');
        const uiBp = div.querySelector('#ui-bp');
        const ring = div.querySelector('.progress-ring__circle');
        const linearBar = div.querySelector('.mam-heartbeat-bar');
        const linearWrap = div.querySelector('.mam-heartbeat-wrap');
        const btnRun = div.querySelector('#btn-run');
        const errorBadge = div.querySelector('.error-badge');
        const selectLimit = div.querySelector('#gift-limit');
        const minIcon = div.querySelector('.minimized-icon');
        const btnSettings = isInline ? document.querySelector('#fpNM #btn-settings') : div.querySelector('#btn-settings');
        const mainView = div.querySelector('.mam-main-view');
        const settingsView = div.querySelector('.mam-settings-view');

        if (btnSettings && mainView && settingsView) {
            btnSettings.onclick = (e) => {
                e.stopPropagation();
                const isHidden = settingsView.style.display === 'none';
                settingsView.style.display = isHidden ? 'block' : 'none';
                mainView.style.display = isHidden ? 'none' : 'block';
                if (isInline) {
                    btnSettings.style.opacity = isHidden ? '1' : '0.6';
                } else {
                    btnSettings.style.color = isHidden ? '#4CAF50' : 'var(--main-text-color, #aaa)';
                }
            };
        }

        // Bind Settings Inputs
        const bindCfg = (id, key, type = 'value') => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            if (type === 'checkbox') el.checked = cfg.get(key, el.checked);
            else el.value = cfg.get(key, el.value);
            el.addEventListener('change', () => {
                if (type === 'checkbox') cfg.set(key, el.checked);
                else cfg.set(key, type === 'number' ? Number(el.value) : el.value);
                if (key === 'theme' && typeof applyTheme === 'function') applyTheme();
            });
        };

        bindCfg('cfg-gift-amt', 'giftAmt', 'text');
        bindCfg('cfg-bp-floor', 'bpFloor', 'number');
        bindCfg('cfg-auto-upload-trigger', 'uploadTrigger', 'number');
        bindCfg('cfg-auto-upload-tier', 'uploadTier', 'text');
        bindCfg('cfg-auto-vip', 'autoVip', 'text');
        bindCfg('cfg-vault-mode', 'vaultMode', 'text');
        bindCfg('cfg-lotto-mode', 'lottoMode', 'text');
        div.querySelector('#cfg-lotto-mode')?.addEventListener('change', () => {
            GM_setValue('mam_lotto_next_check', '0');
        });
        bindCfg('cfg-cooldown-days', 'cooldownDays', 'number');
        bindCfg('cfg-theme', 'theme', 'text');
        bindCfg('cfg-news-tweak', 'newsTweak', 'text');
        bindCfg('cfg-shrink-blocks', 'shrinkBlocks', 'text');

        // Determine which page we are on to create a unique save key
        const getPageKey = () => {
            if (location.pathname.includes('newUsers')) return 'newusers';
            if (location.pathname.includes('shoutbox')) return 'shoutbox';
            return 'index';
        };
        const posKey = 'widgetPos_' + getPageKey();

        // Custom binder for the visual grid
        const updateWidgetPos = (newPos = null) => {
            if (isInline) return;

            const currentPos = newPos || cfg.get(posKey, 'br');
            if (newPos) cfg.set(posKey, currentPos);

            div.classList.remove('mam-pos-br', 'mam-pos-bl', 'mam-pos-tr', 'mam-pos-tl');
            div.classList.add('mam-pos-' + currentPos);

            // Update button UI
            div.querySelectorAll('.mam-pos-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.pos === currentPos);
            });
        };

        div.querySelectorAll('.mam-pos-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                updateWidgetPos(e.target.dataset.pos);
            });
        });
        updateWidgetPos(); // Apply on load

        const btnResetNews = div.querySelector('#btn-reset-news');
        if (btnResetNews) {
            btnResetNews.onclick = (e) => {
                e.stopPropagation();
                GM_setValue('mam_dismissed_news', '[]');
                if (confirm('News cache cleared. Reload page to unhide items?')) location.reload();
            };
        }

        const reloadPrompt = () => { if(confirm('Reload page to apply layout changes?')) location.reload(); };
        div.querySelector('#cfg-news-tweak')?.addEventListener('change', reloadPrompt);
        div.querySelector('#cfg-shrink-blocks')?.addEventListener('change', reloadPrompt);
        div.querySelector('#cfg-vault-mode')?.addEventListener('change', reloadPrompt);
        div.querySelector('#cfg-lotto-mode')?.addEventListener('change', reloadPrompt);

        const tierSelect = div.querySelector('#cfg-auto-upload-tier');
        const triggerInput = div.querySelector('#cfg-auto-upload-trigger');
        if (tierSelect && triggerInput) {
            const updateTriggerState = () => {
                const isOff = tierSelect.value === 'off';
                triggerInput.disabled = isOff;
                triggerInput.style.opacity = isOff ? '0.4' : '1';
                triggerInput.style.cursor = isOff ? 'not-allowed' : 'text';
            };
            tierSelect.addEventListener('change', updateTriggerState);
            updateTriggerState(); // Trigger immediately to set initial visual state
        }

        // Auto-Spend Log Toggle
        const btnSpendLog = div.querySelector('#btn-spend-log');
        const spendLogContainer = div.querySelector('#spend-log-container');
        if (btnSpendLog && spendLogContainer) {
            btnSpendLog.onclick = (e) => {
                e.stopPropagation();
                if (spendLogContainer.style.display === 'block') {
                    spendLogContainer.style.display = 'none';
                    return;
                }
                const logs = spendLog.get();
                if (logs.length === 0) {
                    spendLogContainer.innerHTML = '<i>No auto-spend activity in the last 7 days.</i>';
                } else {
                    let htmlOut = '';
                    let lastDateStr = '';
                    logs.forEach(l => {
                        const d = new Date(l.t);
                        const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                        if (dateStr !== lastDateStr) {
                            const margin = htmlOut === '' ? '0' : '6px';
                            htmlOut += `<div style="color: var(--text-important, #ddd); font-weight: bold; margin: ${margin} 0 2px 0; border-bottom: 1px solid var(--container-border, #444); padding-bottom: 2px;">${dateStr}</div>`;
                            lastDateStr = dateStr;
                        }
                        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        htmlOut += `<div style="display: flex; gap: 6px;"><span style="color:#777; flex-shrink: 0;">[${timeStr}]</span> <span style="color:var(--main-text-color, #eee);">${l.m}</span></div>`;
                    });
                    spendLogContainer.innerHTML = htmlOut;
                }
                spendLogContainer.style.display = 'block';
            };
        }

        // Data Tools
        const btnExport = div.querySelector('#btn-export-db');
        if (btnExport) {
            btnExport.onclick = (e) => {
                e.stopPropagation();
                const data = JSON.stringify({ db: db.load(), archived: db.getArchivedCount() });
                navigator.clipboard.writeText(data).then(() => {
                    btnExport.textContent = 'Copied!';
                    setTimeout(() => btnExport.textContent = 'Export', 2000);
                });
            };
        }

        const btnImport = div.querySelector('#btn-import-db');
        if (btnImport) {
            btnImport.onclick = (e) => {
                e.stopPropagation();
                const input = window.prompt("Paste your exported GiftMAM data here:");
                if (input) {
                    try {
                        const parsed = JSON.parse(input);
                        if (parsed && typeof parsed.db === 'object') {
                            dbCache = parsed.db;
                            db.save();
                            if (parsed.archived !== undefined) {
                                GM_setValue(ARCHIVE_KEY, parsed.archived.toString());
                                archiveCountCache = parsed.archived;
                            }
                            window.updateUICounts();
                            window.log && window.log("� Database imported successfully.", "success");
                        } else {
                            throw new Error("Invalid format");
                        }
                    } catch (err) {
                        alert("Failed to import. Invalid data format.");
                    }
                }
            };
        }

        const btnWipe = div.querySelector('#btn-wipe-db');
        if (btnWipe) {
            btnWipe.onclick = (e) => {
                e.stopPropagation();
                if (btnWipe.textContent === 'Wipe') {
                    btnWipe.textContent = 'Sure?';
                    btnWipe.style.background = '#ff0000';
                    setTimeout(() => { btnWipe.textContent = 'Wipe'; btnWipe.style.background = '#8b0000'; }, 3000);
                } else if (btnWipe.textContent === 'Sure?') {
                    dbCache = {}; db.save();
                    GM_setValue(ARCHIVE_KEY, "0"); archiveCountCache = 0;
                    window.updateUICounts();
                    window.log && window.log("�️ Database wiped clean.", "warn");
                    btnWipe.textContent = 'Wiped!';
                    setTimeout(() => { btnWipe.textContent = 'Wipe'; btnWipe.style.background = '#8b0000'; }, 2000);
                }
            };
        }

        if (selectLimit) {
            const savedVal = isInline ? GM_getValue('mam_gift_limit_inline', 'VISIBLE') : GM_getValue('mam_gift_limit_floating', 'ALL');
            if (selectLimit.querySelector(`option[value="${savedVal}"]`)) {
                selectLimit.value = savedVal;
            }
            selectLimit.addEventListener('change', (e) => {
                if (isInline) {
                    GM_setValue('mam_gift_limit_inline', e.target.value);
                } else {
                    GM_setValue('mam_gift_limit_floating', e.target.value);
                }
            });
        }

        window.applyRemoteState = (remoteIsActive, remoteData) => {
            if (remoteIsActive) {
                if (selectLimit) selectLimit.disabled = true;
                if (btnRun) {
                    btnRun.textContent = "�";

                    let titleStr = "Locked by another tab";
                    if (remoteData && remoteData.isRunning) titleStr = "Another tab is gifting...";
                    else if (remoteData && remoteData.isAutoActive) titleStr = "Another tab is monitoring...";
                    else if (remoteData && remoteData.isSoftPaused) titleStr = "Another tab is paused...";

                    btnRun.title = titleStr;
                    btnRun.style.opacity = "0.5";
                    btnRun.style.cursor = "not-allowed";
                }
                updateMinimizedState('sleeping');
            } else {
                if (selectLimit) selectLimit.disabled = isAutoActive;
                if (btnRun) {
                    btnRun.textContent = isAutoActive ? "�" : "�";
                    btnRun.title = isAutoActive ? "Click to Stop" : "Start Gifting";
                    btnRun.style.opacity = "1";
                    btnRun.style.cursor = "pointer";
                    if (isAutoActive) btnRun.classList.add('stopping');
                    else btnRun.classList.remove('stopping');
                }
                updateMinimizedState(isAutoActive ? 'sleeping' : 'stopped');
            }
        };

        let currentBaseIcon = '�';
        let miniIconIndex = 0;

        const updateMinimizedState = (state) => {
            div.classList.remove('mam-gifting', 'mam-sleeping');
            if (state === 'gifting') {
                div.classList.add('mam-gifting');
                currentBaseIcon = '�';
            } else if (state === 'sleeping') {
                div.classList.add('mam-sleeping');
                currentBaseIcon = '�';
            } else {
                currentBaseIcon = '�';
                setProgress(0);
            }

            // Snap to base icon immediately on state change for clear feedback
            if (minIcon) {
                minIcon.style.opacity = '1';
                minIcon.childNodes[0].textContent = currentBaseIcon;
                miniIconIndex = 0;
            }
        };

        // Languid Carousel for Minimized Alerts
        setInterval(() => {
            if (!isMinimized || !minIcon) return;

            const icons = [currentBaseIcon];
            const lottoBtn = document.getElementById('mam-lotto-enter-btn');
            const vaultBtn = document.getElementById('mam-vault-donate-btn');

            if (lottoBtn && lottoBtn.dataset.active === 'true') icons.push('�');
            if (vaultBtn && vaultBtn.dataset.active === 'true') icons.push('�');

            if (icons.length <= 1) {
                if (minIcon.childNodes[0].textContent !== currentBaseIcon && minIcon.style.opacity !== '0') {
                    minIcon.childNodes[0].textContent = currentBaseIcon;
                }
                return;
            }

            miniIconIndex = (miniIconIndex + 1) % icons.length;
            const nextIcon = icons[miniIconIndex];

            minIcon.style.opacity = '0'; // 2-second fade out

            setTimeout(() => {
                if (!isMinimized) {
                    minIcon.style.opacity = '1';
                    return; // Cancel if user maximized the panel mid-fade
                }
                minIcon.childNodes[0].textContent = nextIcon;
                minIcon.style.opacity = '1'; // 2-second fade in
            }, 2000);

        }, 14000); // Trigger every 14 seconds (10s hold + 4s total fade cycle)

        window.log = (msg, type='info') => {
            const timeStr = `[${new Date().toLocaleTimeString()}] `;
            if (!logBox) {
                console.log(`[GiftMAM] ${msg}`);
                return;
            }

            const isFooterLog = logBox.parentElement && logBox.parentElement.classList.contains('blockFoot');

            if (isFooterLog) logBox.innerHTML = '';

            const p = document.createElement('div');
            p.textContent = timeStr + msg;
            p.className = `log-${type}`;
            if (isFooterLog) {
                p.style.cssText = 'display: block !important; width: 100% !important; text-align: center !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; animation: mamFadeIn 0.3s ease-in !important;';
            }
            logBox.appendChild(p);
            logBox.scrollTop = logBox.scrollHeight;
        };

        window.updateUICounts = () => {
            const count = db.count();
            const qCount = virtualQueue.length;
            if (uiDb) {
                const isAuto = selectLimit && selectLimit.value === 'BOT';
                const showQueue = isAuto || qCount > 0;
                const queueStr = showQueue ? ` (${qCount})` : '';
                let displayCount = count.toLocaleString();

                if ((displayCount + queueStr).length > 12) {
                    displayCount = Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(count);
                }
                const queueHtml = showQueue ? `<span style="color:#00bcd4; font-weight:bold; margin-left:3px;">(${qCount})</span>` : '';
                uiDb.innerHTML = `${displayCount}${queueHtml}`;

                if (uiDb.parentElement) {
                    uiDb.parentElement.title = `Total Gifted: ${count.toLocaleString()} | In Queue: ${qCount}`;
                }
            }
        };

        const setProgress = (percent, immediate = false) => {
            if (ring) {
                const offset = circumference - (percent / 100) * circumference;
                ring.style.strokeDashoffset = offset;
            }
            if (linearBar) {
                if (immediate) {
                    linearBar.classList.remove('mam-animating');
                    linearBar.style.width = `${percent}%`;
                    void linearBar.offsetWidth;
                } else {
                    linearBar.classList.add('mam-animating');
                    linearBar.style.width = `${percent}%`;
                }
                if (linearWrap) linearWrap.classList.toggle('mam-hb-active', isAutoActive && !isRunning);
                linearBar.style.background = isRunning ? '#4CAF50' : '#5EB9FF';
            }
        };

        const btnMin = div.querySelector('#btn-min');
        if (btnMin) {
            btnMin.onclick = (e) => {
                e.stopPropagation();
                div.classList.add('mam-minimized');
                isMinimized = true;
            };
            div.onclick = (e) => {
                if (div.classList.contains('mam-minimized')) {
                    div.classList.remove('mam-minimized');
                    isMinimized = false;
                    setTimeout(() => { if (logBox) logBox.scrollTop = logBox.scrollHeight; }, 50);
                }
            };
        }

        const btnRefresh = div.querySelector('#btn-refresh');
        if (btnRefresh) {
            btnRefresh.onclick = async (e) => {
                e.stopPropagation();
                const count = await syncEngine.macroSync(true);
                if (isAutoActive && count > 0 && !isRunning) {
                    if (typeof window.mamRunBatch === 'function') window.mamRunBatch(true);
                }
            };
        }

        let backoffLevels = [12, 15, 30, 60, 120];
        let currentBackoffIndex = 0;
        let nextPulseTarget = 0;

        function getJitteredTime(minutes) {
            const ms = minutes * 60 * 1000;
            return ms * (0.9 + Math.random() * 0.2); // +/- 10%
        }

        function startHeartbeat() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);

            lastHeartbeatTime = Date.now();
            nextPulseTarget = lastHeartbeatTime + getJitteredTime(backoffLevels[currentBackoffIndex]);

            heartbeatTimer = setInterval(async () => {
                if (isRunning || isRemoteRunning || isSoftPaused) return;

                const now = Date.now();
                let elapsed = now - lastHeartbeatTime;
                let duration = nextPulseTarget - lastHeartbeatTime;

                if (isAutoActive) {
                    const percent = Math.min(100, (elapsed / duration) * 100);
                    setProgress(percent);
                }

                if (now >= nextPulseTarget) {
                    // Fire background workers on wake
                    workers.vitalStats();
                    workers.dailies();

                    const newCount = await syncEngine.pulseCheck();

                    lastHeartbeatTime = Date.now();

                    if (newCount > 0) {
                        currentBackoffIndex = 0;
                        nextPulseTarget = lastHeartbeatTime + getJitteredTime(backoffLevels[currentBackoffIndex]);

                        if (isAutoActive && !isRunning) {
                            runBatch(true);
                        }
                    } else {
                        currentBackoffIndex = Math.min(currentBackoffIndex + 1, backoffLevels.length - 1);
                        nextPulseTarget = lastHeartbeatTime + getJitteredTime(backoffLevels[currentBackoffIndex]);
                        if (currentBackoffIndex > 0) {
                            window.log && window.log(`� Site quiet. Backing off checks to ~${backoffLevels[currentBackoffIndex]}m`, "info");
                        }
                    }
                }
            }, 1000);
        }

        async function runBatch(forceStart = false) {
            if (isRemoteRunning && !forceStart) return;
            const isSystemTrigger = forceStart === true;

            if (isRunning) {
                if (isSystemTrigger) return;

                stopRequested = true;
                if (btnRun) btnRun.textContent = "⏳";

                if (isAutoActive) {
                    isAutoActive = false;
                    isSoftPaused = false;
                    updateMinimizedState('stopped');
                    window.log && window.log("� Auto Mode stopped.", "warn");
                }
                broadcastState();
                return;
            }
            else if (isSystemTrigger) {
                 if (!isAutoActive) return;
            }
            else if (isAutoActive) {
                isAutoActive = false;
                isSoftPaused = false;
                if (selectLimit) selectLimit.disabled = false;
                updateMinimizedState('stopped');
                if (btnRun) {
                    btnRun.textContent = "�";
                    btnRun.title = "Start Gifting";
                    btnRun.classList.remove('stopping');
                }
                window.log && window.log("� Auto Mode stopped.", "warn");
                broadcastState();
                return;
            }

            const limitVal = selectLimit ? selectLimit.value : 'ALL';

            if (limitVal === 'BOT') {
                if (!isAutoActive) {
                    isAutoActive = true;
                    window.log && window.log("� Auto Mode Engaged.", "info");
                }
            } else {
                isAutoActive = false;
            }

            isRunning = true;
            isSoftPaused = false;
            broadcastState();
            lastHeartbeatTime = Date.now();
            stopRequested = false;
            if (errorBadge) errorBadge.style.display = 'none';
            if (selectLimit) selectLimit.disabled = true;

            if (btnRun) {
                btnRun.classList.add('stopping');
                btnRun.textContent = "�";
                btnRun.title = "Click to Stop";
            }

            if (virtualQueue.length === 0) await syncEngine.macroSync();

            const maxGifts = (limitVal === 'ALL' || limitVal === 'BOT' || limitVal === 'VISIBLE') ? Infinity : parseInt(limitVal, 10);
            let processed = 0;
            let totalToProcess = Math.min(virtualQueue.length, maxGifts);

            setProgress(0);
            const bpFloor = cfg.get('bpFloor', 5000);

            // Using a dynamic while-loop allows parallel soft-refreshes to seamlessly feed new users into the active run
            while (virtualQueue.length > 0 && processed < maxGifts) {
                if (stopRequested) break;

                if (currentBP < bpFloor) {
                    window.log && window.log(`� BP hit safety floor (${bpFloor}). Stopping.`, 'warn');
                    stopRequested = true;
                    break;
                }

                const username = virtualQueue[0]; // Peek at the top of the queue

                // --- Client-Side Rolling Window Limiter ---
                const now = Date.now();
                giftTimestamps = giftTimestamps.filter(t => now - t < 120000); // Drop timestamps older than 120s

                if (giftTimestamps.length >= 10) {
                    // Calculate exact time needed to age out the oldest request, plus a 2s safety buffer
                    const waitTime = 120000 - (now - giftTimestamps[0]) + 2000;
                    window.log && window.log(`⏳ Burst limit reached. Dynamic pause for ${Math.ceil(waitTime/1000)}s...`, 'warn');

                    isSoftPaused = true;
                    updateMinimizedState('sleeping');
                    await new Promise(r => setTimeout(r, waitTime));
                    isSoftPaused = false;

                    // Re-sync timestamps after waking up
                    giftTimestamps = giftTimestamps.filter(t => Date.now() - t < 120000);
                }

                giftTimestamps.push(Date.now());
                // ------------------------------------------

                updateMinimizedState('gifting');

                const result = await sendGift(username);

                if (result.success || (result.error && result.error.includes("daily cap"))) {
                    db.add(username);
                    processed++;

                    const deducted = result.amount || 100;
                    currentBP -= deducted;
                    if (typeof window.updateUIBP === 'function') window.updateUIBP();

                    virtualQueue = virtualQueue.filter(u => u !== username);
                    if (typeof window.updateUICounts === 'function') window.updateUICounts();
                    markUserAsGifted(username);

                    syncChannel.postMessage({
                        type: 'SYNC_GIFTED',
                        data: { username, currentBP }
                    });

                    window.log && window.log(`✅ Gifted ${username} (${result.amount})`, 'success');
                    div.classList.add('mam-gift-pulse');
                    setTimeout(() => div.classList.remove('mam-gift-pulse'), 300);

                    // Dynamically expand the progress ring total if we picked up new targets mid-run
                    if (virtualQueue.length + processed > totalToProcess) {
                        totalToProcess = virtualQueue.length + processed;
                    }
                    if (totalToProcess > 0) setProgress((processed / totalToProcess) * 100);

                } else {
                    const errStr = String(result.error).toLowerCase();
                    window.log && window.log(`❌ Error ${username}: ${result.error}`, 'error');
                    if (errorBadge) errorBadge.style.display = 'block';

                    if (errStr.includes("insufficient points")) {
                    stopRequested = true;
                } else if (errStr.includes("rate limit")) {
                    // Pause in place (like the burst-limit wait above) instead of breaking the loop,
                    // so the batch resumes automatically regardless of Auto/manual mode.
                    window.log && window.log(`⏳ Rate Limit hit. Pausing for 180 seconds...`, 'warn');
                    isSoftPaused = true;
                    updateMinimizedState('sleeping');
                    await new Promise(r => setTimeout(r, 180 * 1000));
                    isSoftPaused = false;
                    window.log && window.log(`▶️ Resuming after rate limit pause...`, 'info');
                    // The user stays at the front of the queue, so the next loop iteration retries them
                } else if (errStr.includes("http ") || errStr.includes("fetch")) {
                    // Pause in place (like the rate-limit wait above) instead of breaking the loop,
                    // so the batch resumes automatically regardless of Auto/manual mode.
                    window.log && window.log(`⏳ Server error. Pausing for 5 minutes...`, 'warn');
                    isSoftPaused = true;
                    updateMinimizedState('sleeping');
                    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                    isSoftPaused = false;
                    window.log && window.log(`▶️ Resuming after server error pause...`, 'info');
                    // The user stays at the front of the queue, so the next loop iteration retries them
                } else if (errStr.includes("invalid") || errStr.includes("disabled") || errStr.includes("not found")) {
                        db.add(username);
                        virtualQueue = virtualQueue.filter(u => u !== username);
                        if (typeof window.updateUICounts === 'function') window.updateUICounts();
                    } else {
                        // Catch-all for strange API rejections to prevent infinite loops
                        virtualQueue = virtualQueue.filter(u => u !== username);
                        if (typeof window.updateUICounts === 'function') window.updateUICounts();
                    }
                }

                if (!stopRequested && virtualQueue.length > 0) {
                    let amtSetting = cfg.get('giftAmt', '100').toString().toLowerCase();
                    let parsedAmt = parseInt(amtSetting, 10);
                    let isHighAmt = amtSetting === 'max' || (parsedAmt && parsedAmt > 100);

                    if (isHighAmt) {
                        // ~17s delay to balance the 3-3.5s delay already injected inside sendGift, for a ~20s total cadence
                        await new Promise(r => setTimeout(r, 17000 + Math.random() * 500));
                    } else {
                        // ~20s delay between gifts; rolling window array handles the hard limits
                        await new Promise(r => setTimeout(r, 20000 + Math.random() * 2000));
                    }
                }
            }

            isRunning = false;
            const wasAborted = stopRequested;
            stopRequested = false;
            broadcastState();
            if (btnRun) btnRun.classList.remove('stopping');

            if (!wasAborted) setProgress(0, true);

            if (isAutoActive) {
                if (isSoftPaused) {
                    updateMinimizedState('stopped'); // Fallback to base icon with empty ring
                    if (btnRun) btnRun.textContent = "⏳";
                } else {
                    updateMinimizedState('sleeping');
                    if (btnRun) {
                        btnRun.textContent = "�";
                        btnRun.title = "Auto Active (Click to Stop)";
                        btnRun.classList.add('stopping');
                    }
                    if (!wasAborted) window.log && window.log(`� Batch done. Monitoring...`, 'info');
                }
            } else {
                updateMinimizedState('stopped');
                if (btnRun) {
                    btnRun.textContent = "�";
                    btnRun.title = "Start Gifting";
                }
                if (selectLimit) selectLimit.disabled = false;

                if (wasAborted && !isSoftPaused) {
                    window.log && window.log(`� Batch aborted.`, 'warn');
                } else if (!wasAborted) {
                    window.log && window.log(`� Batch Complete.`, 'success');
                }
            }
        }

        if (btnRun) btnRun.onclick = runBatch;
        window.mamRunBatch = runBatch;

        startHeartbeat();
        workers.vitalStats();
        workers.dailies();
    }

    // === INIT ===
    db.prune();

    if (GM_getValue(DB_KEY) === undefined) db.save();
    if (GM_getValue(ARCHIVE_KEY) === undefined) GM_setValue(ARCHIVE_KEY, "0");

    virtualQueue = getTargetsFromDOM(document);

    // --- GLOBAL SITE-WIDE EXECUTION ---
    workers.vitalStats();
    workers.dailies();

    // Universal background heartbeat to maintain state on pages without the active UI panel
    setInterval(() => {
        if (!isRunning && !isRemoteRunning) {
            workers.vitalStats();
            workers.dailies();
        }
    }, 15 * 60 * 1000);

    const validPaths = ['/', '/index.php', '/newUsers.php', '/shoutbox/index.php'];
    if (validPaths.some(p => location.pathname === p)) {

        // Ensure floating panel is strictly used everywhere
        createPanel(false);
        window.updateUICounts();

        if (!location.pathname.includes('/shoutbox/')) {
            visualizeAll();
        }

        // Initialize queue silently on load
        if (virtualQueue.length === 0) {
            syncEngine.macroSync();
        }

        // --- SHOUTBOX FLOATING LOGS ---
        const sbLog = (msg, type = 'info') => {
            // Bind to #shoutbox to keep the popup strictly inside the chat UI container
            const shoutBoxWrap = document.getElementById('shoutbox') || document.getElementById('fpShout') || document.body;

            if (window.getComputedStyle(shoutBoxWrap).position === 'static') {
                shoutBoxWrap.style.position = 'relative';
            }

            const floater = document.createElement('div');
            floater.className = `mam-floating-log log-${type}`;

            // Start at 80px to safely clear the input box & Quickshout UI, then stack
            const existingFloaters = shoutBoxWrap.querySelectorAll('.mam-floating-log');
            const offset = 80 + (existingFloaters.length * 35);
            floater.style.bottom = `${offset}px`;

            // Raw message only (no timestamp)
            floater.innerHTML = msg;

            shoutBoxWrap.appendChild(floater);

            setTimeout(() => {
                if (floater && floater.parentNode) {
                    floater.parentNode.removeChild(floater);
                }
            }, 4900); // 4.9s (Removes node just as 5s fade animation finishes)
        };

        // --- MANUAL SHOUTBOX RECONNECT BUTTON ---
        const sbTabs = document.getElementById('sbMenuTabs');
        if (sbTabs && !document.getElementById('mam-sb-reconnect')) {
            const reconnectLi = document.createElement('li');
            reconnectLi.style.cssText = 'float: right; list-style: none; margin: 4px 10px 0 0;';

            const reconnectBtn = document.createElement('a');
            reconnectBtn.id = 'mam-sb-reconnect';
            reconnectBtn.className = 'cursor';
            reconnectBtn.innerHTML = '<img class="invertBlue" src="/pic/refresh.svg" alt="refresh" style="width: 14px; height: 14px; display: block;">';
            reconnectBtn.title = "Reconnect Shoutbox";
            reconnectBtn.style.cssText = 'opacity: 0.6; transition: transform 0.2s, opacity 0.2s; display: block; transform-origin: center;';

            reconnectBtn.onmouseover = () => { reconnectBtn.style.opacity = '1'; reconnectBtn.style.transform = 'rotate(180deg)'; };
            reconnectBtn.onmouseout = () => { reconnectBtn.style.opacity = '0.6'; reconnectBtn.style.transform = 'rotate(0deg)'; };

            reconnectBtn.onclick = (e) => {
                e.preventDefault();
                sbLog("� Reconnecting...", "info");

                try {
                    const liveSbf = document.querySelector('#sbf .blockBodyCon');

                    if (liveSbf) {
                        const scrollObserver = new MutationObserver((mutations, obs) => {
                            for (let m of mutations) {
                                if (m.addedNodes.length > 0) {
                                    const chatContainer = document.querySelector('#sbf');
                                    if (chatContainer) {
                                        setTimeout(() => {
                                            chatContainer.scrollTop = chatContainer.scrollHeight;
                                            sbLog("� Shoutbox reconnected.", "success");
                                        }, 100);
                                    }
                                    obs.disconnect();
                                    break;
                                }
                            }
                        });
                        scrollObserver.observe(liveSbf, { childList: true });
                    }

                    const resetScript = document.createElement('script');
                    resetScript.textContent = `
                        (() => {
                            if (typeof updateTimer !== 'undefined') clearInterval(updateTimer);
                            if (typeof sbLoadAjax !== 'undefined' && sbLoadAjax !== null) {
                                try { sbLoadAjax.abort(); } catch(err) {}
                            }
                            if (typeof $ !== 'undefined' && $.fn && $.fn.dialog) {
                                try { $('.ui-dialog-content').dialog('close'); } catch(err) {}
                            }

                            minID = 0;
                            maxID = 0;
                            shoutboxInitial = true;
                            sbLastAction = null;
                            if (typeof sb_paused !== 'undefined') sb_paused = false;

                            const sbfCon = document.querySelector('#sbf .blockBodyCon');
                            if (sbfCon) sbfCon.innerHTML = '<a id="loadMore" class="loadMore" onclick="sbLoad(\\'append\\')">Load Older</a>';

                            document.querySelectorAll('#sbform input').forEach(el => el.disabled = false);
                            if (typeof $ !== 'undefined') {
                                $('#sbform').off('submit').on('submit', function() { return submitShout(); });
                            }

                            if (typeof startSBupdate === 'function') {
                                startSBupdate();
                            }
                        })();
                    `;
                    document.body.appendChild(resetScript);
                    resetScript.remove();

                } catch (err) {
                    sbLog("❌ Reconnect failed. Please refresh.", "error");
                }
            };

            reconnectLi.appendChild(reconnectBtn);
            sbTabs.appendChild(reconnectLi);
        }

        // --- SHOUTBOX CUSTOM CONTEXT MENU ---
        const sbMenuMain = document.getElementById('sbMenuMain');
        if (sbMenuMain) {
            if (window.mamMenuObserver) window.mamMenuObserver.disconnect();

            const modifyMenu = () => {
                const ul = sbMenuMain.querySelector('ul[data-uid]');
                if (ul && !ul.dataset.mpModified) {
                    ul.dataset.mpModified = "true";
                            ul.style.position = 'relative';

                            const uid = ul.dataset.uid;
                            const sbunLi = ul.querySelector('#sbun');

                            if (sbunLi) {
                                sbunLi.style.setProperty('padding-top', '4px', 'important');
                                sbunLi.style.setProperty('padding-bottom', '4px', 'important');

                                const usernameSpan = sbunLi.querySelector('span[data-uc]');
                                const username = usernameSpan ? usernameSpan.textContent.trim() : "User";
                                if (usernameSpan && !usernameSpan.parentElement.matches('a')) {
                                    const userLink = document.createElement('a');
                                    userLink.href = `/u/${uid}`;
                                    userLink.target = "_blank";
                                    userLink.style.textDecoration = "none";
                                    usernameSpan.replaceWith(userLink);
                                    userLink.appendChild(usernameSpan);
                                }

                                const pmIcon = sbunLi.querySelector('a[href^="/sendmessage.php"]');
                                if (pmIcon) {
                                    const actionRow = document.createElement('li');
                                    actionRow.style.cssText = 'display: flex; gap: 12px; align-items: center; margin-top: 4px; padding-left: 0px; list-style: none;';

                                    actionRow.appendChild(pmIcon);

                                    // --- GIFT POINTS ---
                                    const giftPointsBtn = document.createElement('span');
                                    giftPointsBtn.innerHTML = '�';
                                    giftPointsBtn.style.cssText = 'cursor: pointer; font-size: 14px; line-height: 1;';
                                    giftPointsBtn.title = "Gift Points";
                                    giftPointsBtn.onclick = async (e) => {
                                        e.stopPropagation();

                                        let defaultPoints = cfg.get("giftAmt", "100").toString().toLowerCase() === "max" ? "1000" : cfg.get("giftAmt", "100");
                                        defaultPoints = Math.min(1000, Math.max(5, Number(defaultPoints))) || 100;

                                        const amount = window.prompt(`Enter points to gift ${username} (5-1000):`, defaultPoints);
                                        if (amount !== null) {
                                            const numAmount = parseInt(amount, 10);
                                            if (numAmount >= 5 && numAmount <= 1000) {
                                                if (typeof hideSBmenu === 'function') hideSBmenu(); // Close immediately so user can keep chatting
                                                try {
                                                    const resp = await fetch(`/json/bonusBuy.php?spendtype=gift&amount=${numAmount}&giftTo=${uid}`);
                                                    const data = await resp.json();
                                                    if (data.success) {
                                                        sbLog(`� ${numAmount} BP to ${username}`, 'success');
                                                        if (data.seedbonus !== undefined) {
                                                            currentBP = parseInt(data.seedbonus, 10);
                                                            if (typeof window.updateUIBP === 'function') window.updateUIBP();
                                                        }
                                                    } else {
                                                        let errStr = data.error;
                                                        if (errStr.toLowerCase().includes('daily cap')) {
                                                            const timeMatch = errStr.match(/next possible in (\d{1,2}:\d{2}:\d{2})/);
                                                            errStr = timeMatch ? `Daily Cap: ${timeMatch[1]} till reset` : `Daily Cap Reached`;
                                                        }
                                                        sbLog(`❌ ${errStr}`, 'error');
                                                    }
                                                } catch (err) {
                                                    sbLog(`❌ Network error`, 'error');
                                                }
                                            } else {
                                                alert("Invalid amount. Must be between 5 and 1000.");
                                            }
                                        }
                                    };
                                    actionRow.appendChild(giftPointsBtn);

                                    // --- GIFT WEDGE ---
                                    const giftWedgeBtn = document.createElement('span');
                                    giftWedgeBtn.innerHTML = '�';
                                    giftWedgeBtn.style.cssText = 'cursor: pointer; font-size: 14px; line-height: 1;';
                                    giftWedgeBtn.title = "Gift Freeleech Wedge";
                                    giftWedgeBtn.onclick = async (e) => {
                                        e.stopPropagation();
                                        if (window.confirm(`Send 1 Freeleech Wedge to ${username}?`)) {
                                            if (typeof hideSBmenu === 'function') hideSBmenu(); // Close immediately so user can keep chatting
                                            try {
                                                const resp = await fetch(`/json/bonusBuy.php?spendtype=sendWedge&giftTo=${uid}`);
                                                const data = await resp.json();
                                                if (data.success) {
                                                    sbLog(`� Wedge to ${username}`, 'success');
                                                    if (data.seedbonus !== undefined) {
                                                        currentBP = parseInt(data.seedbonus, 10);
                                                        if (typeof window.updateUIBP === 'function') window.updateUIBP();
                                                    }
                                                } else {
                                                    let errStr = data.error;
                                                    if (errStr.toLowerCase().includes('daily cap')) {
                                                        const timeMatch = errStr.match(/next possible in (\d{1,2}:\d{2}:\d{2})/);
                                                        errStr = timeMatch ? `Daily Cap: ${timeMatch[1]} till reset` : `Daily Cap Reached`;
                                                    }
                                                    sbLog(`❌ ${errStr}`, 'error');
                                                }
                                            } catch (err) {
                                                sbLog(`❌ Network error`, 'error');
                                            }
                                        }
                                    };
                                    actionRow.appendChild(giftWedgeBtn);

                                    sbunLi.insertAdjacentElement('afterend', actionRow);
                                }
                            }

                            const sbQuote = ul.querySelector('#sbQuote');
                            if (sbQuote) {
                                sbQuote.style.cssText = 'display: block !important; width: fit-content !important; padding-right: 10px !important; margin-bottom: 2px !important; border-bottom: none !important;';
                            }

                            ul.querySelectorAll('li').forEach(li => {
                                if (li.innerHTML.trim() === '') li.remove();
                            });

                            if (!ul.querySelector('.mam-close-menu')) {
                                const closeBtn = document.createElement('div');
                                closeBtn.className = 'mam-close-menu';
                                closeBtn.innerHTML = '✖';
                                closeBtn.style.cssText = 'position: absolute !important; top: 4px !important; right: 2px !important; cursor: pointer !important; color: #ff4c4c !important; font-weight: bold !important; font-size: 14px !important; z-index: 1000 !important; line-height: 1 !important; padding: 2px 6px !important; margin: 0 !important; border: none !important; background: transparent !important; display: block !important;';
                                closeBtn.title = "Close Menu";
                                closeBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    if (typeof hideSBmenu === 'function') {
                                        hideSBmenu();
                                    } else {
                                        sbMenuMain.classList.add('hideMe');
                                        const clickedRow = document.querySelector('.sb_clicked_row');
                                        if (clickedRow) clickedRow.classList.remove('sb_clicked_row');
                                    }
                                };
                                ul.appendChild(closeBtn);
                            }
                        }
            };

            window.mamMenuObserver = new MutationObserver((mutations) => {
                if (mutations.some(m => m.addedNodes.length > 0)) modifyMenu();
            });
            window.mamMenuObserver.observe(sbMenuMain, { childList: true });

            modifyMenu();
        }
    }

    function applyFrontPageTweaks() {
        if (window.location.pathname !== '/' && window.location.pathname !== '/index.php') return;

        // 1. Compact Layout (CSS Injection)
        if (cfg.get('shrinkBlocks', 'off') === 'on') {
            const style = document.createElement('style');
            style.textContent = `
                /* Hide table headers for Last Torrents and Last Forum Posts */
                #fp_lt table thead, table:has(td.tabletitle) thead { display: none !important; }

                /* Hide "Please welcome our newest members:" heading */
                #fpNM h3, #newestMembers h3 { display: none !important; }

                /* Restore vertical alignment lost from hiding the h3 */
                #newestMembers { margin-top: 2px !important; }

                /* Prevent long names from overflowing into adjacent columns */
                #newestMembers a {
                    display: inline-block;
                    max-width: 100%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    vertical-align: bottom;
                }

                /* Strip extra fat padding */
                #fp_lt table td { padding: 4px 6px !important; }

                /* Hide the massive description blocks taking up vertical space */
                #fp_lt .torRowDesc, #fp_lt .torRowMediaInfo { display: none !important; }

                /* Tighten the block container itself */
                #fp_lt { overflow: hidden !important; padding-bottom: 5px !important; }
            `;
            document.head.appendChild(style);
        }

        // 2. Smart Tooltips for Truncated Names
        const nmContainer = document.getElementById('newestMembers');
        if (nmContainer) {
            nmContainer.addEventListener('mouseover', (e) => {
                const link = e.target.closest('a');
                if (!link) return;

                // If the true width of the text is larger than the visible container, it's truncated
                if (link.scrollWidth > link.clientWidth) {
                    link.title = link.textContent.trim();
                } else {
                    link.removeAttribute('title'); // Keep it clean if not truncated
                }
            });
        }

        // 3. Hideable News & Time
        const newsTweak = cfg.get('newsTweak', 'off');

        if (newsTweak === 'click' || newsTweak === 'on') {
            const fpTime = document.querySelector('.fpTime');
            if (fpTime) fpTime.style.display = 'none';

            const newsItems = document.querySelectorAll('.mainPageNews, .mainPageNewsSub');
            const newsHeader = document.querySelector('.mainPageNewsHead');

            if (newsTweak === 'on') {
                if (newsHeader) newsHeader.style.display = 'none';
                newsItems.forEach(item => item.style.display = 'none');
            } else {
                const dismissedNewsKey = 'mam_dismissed_news';
                let dismissedNews = [];
                try { dismissedNews = JSON.parse(GM_getValue(dismissedNewsKey, '[]')); } catch (e) {}

                let visibleCount = 0;

                newsItems.forEach(item => {
                    const itemHash = item.textContent.trim();

                    if (dismissedNews.includes(itemHash)) {
                        item.style.display = 'none';
                    } else {
                        visibleCount++;

                        let html = item.innerHTML;
                        if (!item.querySelector('.mam-news-date-dismiss') && html.match(/^\[\d{4}-\d{2}-\d{2}\]/)) {

                            item.innerHTML = html.replace(/^(\[\d{4}-\d{2}-\d{2}\])/, `<span class="mam-news-date-dismiss" title="Click to dismiss this news" style="cursor: pointer; transition: color 0.2s;">$1</span>`);

                            const dateSpan = item.querySelector('.mam-news-date-dismiss');
                            dateSpan.onmouseover = () => dateSpan.style.color = '#ff4444';
                            dateSpan.onmouseout = () => dateSpan.style.color = '';

                            dateSpan.onclick = (e) => {
                                e.preventDefault();
                                dismissedNews.push(itemHash);
                                GM_setValue(dismissedNewsKey, JSON.stringify(dismissedNews));
                                item.style.display = 'none';
                                visibleCount--;
                                if (visibleCount <= 0 && newsHeader) newsHeader.style.display = 'none';
                            };
                        }
                    }
                });

                if (visibleCount <= 0 && newsHeader) newsHeader.style.display = 'none';
            }
        }
    }

    applyFrontPageTweaks();

    // --- Page-Specific Observers ---
    if (location.pathname === '/millionaires/donate.php') {
        // Check the page content directly instead of assuming form submission success
        const mainBody = document.getElementById('mainBody');
        if (mainBody && mainBody.textContent.includes('You have not donated today')) {
            // If the user landed here and hasn't donated, clear the 5-minute snooze instantly
            // so the diamond widget stays lit and active.
            GM_setValue('mam_vault_next_reset', '0');
        }
    }

    if (location.pathname === '/play_lotto.php') {
        const mainBody = document.getElementById('mainBody');
        if (mainBody) {
            if (mainBody.textContent.includes('You have already played this week')) {
                // Authoritative state: Lotto entry is confirmed. Lock until Monday reset.
                GM_setValue('mam_lotto_next_check', getNextLottoResetTime().toString());
            } else {
                // User landed here but hasn't successfully played. Clear the snooze.
                GM_setValue('mam_lotto_next_check', '0');
            }
        }
    }

    if (window.mamSyncChannel) {
        window.mamSyncChannel.postMessage({ type: 'SYNC_REQUEST_STATE' });
    }

})();
