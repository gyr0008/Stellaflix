/*!
 * platform-playlist-import.js — 平台歌单导入（Stellaflix）
 * 后端: /api/platform-playlist/import（根目录 platform-playlist-import.js，
 *       自 Mineradio-LX-Music GPL-3.0 移植，九平台：tx/wy/kw/kg/kgc/mg/sp/qs/am）
 * 前端: 本文件。补齐 agent-music-tools.js 预铺的全部钩子：
 *       window.importPlatformPlaylistFromInput（AI import_shared_playlist 工具）
 *       openPlatformPlaylistImport / openLxPlaylistImport / openPlaylistSelection
 *       openLxSourceImport / openLocalFileImport / openLocalFolderImport
 * 存储: 复用 03b-local-playlist-store.js（window.localPlaylistStore），
 *       导入歌单打 platformImportKey 标记，重复导入 = 按 key 替换曲目。
 * 播放: 导入曲目统一 type:'lx-online'，走 playLxMirrorSong →
 *       custom-source 聚合解析（按歌名+歌手跨源匹配），与 AI 搜索播放同链路。
 */
(function (global) {
  'use strict';

  var MAX_SONGS = 1000; // 与 03b-local-playlist-store.js 保持一致
  var IMPORT_ENDPOINT = '/api/platform-playlist/import';
  var PLATFORMS = [
    { code: 'tx', label: '小秋' }, { code: 'wy', label: '小芸' },
    { code: 'kw', label: '小蜗' }, { code: 'kg', label: '小枸' },
    { code: 'kgc', label: '小枸概念版' }, { code: 'mg', label: '小菇' },
    { code: 'sp', label: '小绿' }, { code: 'qs', label: '小水' },
    { code: 'am', label: '小果' },
  ];

  function toast(message) {
    if (typeof global.showToast === 'function') global.showToast(message);
    else console.log('[PlatformPlaylistImport]', message);
  }

  function fetchJSON(path, options) {
    var init = {
      method: options && options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (options && options.body !== undefined) init.body = JSON.stringify(options.body);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) init.signal = controller.signal;
    var timer = controller ? setTimeout(function () { controller.abort(); }, (options && options.timeoutMs) || 90000) : null;
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'BAD_RESPONSE' }; });
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  // ---------- 歌曲转换：导入原始形状 → Stellaflix 队列形状 ----------
  function convertSong(raw) {
    raw = raw || {};
    var id = String(raw.songmid || raw.id || '').trim();
    return {
      type: 'lx-online',
      name: String(raw.name || raw.title || ''),
      singer: String(raw.singer || raw.artist || ''),
      artist: String(raw.singer || raw.artist || ''),
      songmid: id,
      id: id,
      source: String(raw.source || ''),
      interval: raw.interval || 0,
      albumName: String(raw.albumName || raw.album || ''),
      cover: raw.picUrl || raw.cover || '',
      needsCrossPlatformMatch: raw.needsCrossPlatformMatch === true,
    };
  }

  function convertImported(imported) {
    return {
      id: String(imported.id || ''),
      name: String(imported.name || '导入歌单'),
      cover: imported.cover || '',
      source: String(imported.source || ''),
      sourceListId: String(imported.sourceListId || ''),
      totalTracks: Number(imported.totalTracks) || 0,
      partial: imported.partial === true,
      importLimitReason: String(imported.importLimitReason || ''),
      songs: (Array.isArray(imported.songs) ? imported.songs : []).slice(0, MAX_SONGS).map(convertSong)
        .filter(function (song) { return song.name && song.songmid; }),
    };
  }

  // ---------- 存储：localPlaylistStore upsert ----------
  function upsertImportedPlaylist(converted) {
    var store = global.localPlaylistStore;
    if (!store || typeof store.create !== 'function') {
      return { ok: false, error: 'STORE_NOT_READY', message: '本地歌单存储尚未初始化' };
    }
    var existing = null;
    store.list().forEach(function (pl) {
      if (pl && pl.platformImportKey === converted.id) existing = pl;
    });
    var target;
    if (existing) {
      converted.songs.forEach(function (song) { song.lxPlaylistName = converted.name; });
      existing.songs = converted.songs;
      existing.trackCount = converted.songs.length;
      if (converted.cover) existing.cover = converted.cover;
      existing.updatedAt = Date.now();
      target = existing;
      store.save();
    } else {
      var created = store.create(converted.name);
      if (!created || !created.ok) return created;
      target = created.playlist;
      converted.songs.forEach(function (song) { song.lxPlaylistName = converted.name; });
      target.platformImportKey = converted.id;
      target.cover = converted.cover || '';
      target.creator = '平台导入';
      target.imported = true;
      target.importSource = converted.source;
      target.songs = converted.songs;           // 批量写入，绕开逐首 persist
      target.trackCount = converted.songs.length;
      store.save();
    }
    if (typeof global.ensureLocalUserPlaylistsLoaded === 'function') {
      global.ensureLocalUserPlaylistsLoaded(true);
    }
    return { ok: true, updated: !!existing, playlist: target };
  }

  function refreshPlaylistUI() {
    try {
      if (typeof global.renderUserPlaylistsList === 'function') {
        global.renderUserPlaylistsList({ preserveScroll: true });
      }
    } catch (e) { /* 面板未初始化时忽略 */ }
  }

  // ---------- 核心：链接/ID → 导入（AI 与对话框共用） ----------
  function importPlatformPlaylistFromInput(input, source, options) {
    options = options || {};
    var text = String(input || '').trim();
    if (!text) {
      return Promise.resolve({ ok: false, error: 'INPUT_REQUIRED', message: '请提供歌单分享链接或数字歌单 ID' });
    }
    return fetchJSON(IMPORT_ENDPOINT, {
      method: 'POST',
      body: { input: text, source: String(source || '').trim() },
      timeoutMs: 90000,
    }).then(function (result) {
      if (!result || !result.ok || !result.playlist) {
        var message = (result && (result.message || result.error)) || '导入失败，请检查链接后重试';
        if (!options.silent) toast('歌单导入失败：' + message);
        throw { ok: false, error: (result && result.error) || 'IMPORT_FAILED', message: message };
      }
      var converted = convertImported(result.playlist);

      // 重复导入：默认弹确认；AI/静默路径（confirmDuplicate:false）直接替换
      var proceed = function () {
        var stored = upsertImportedPlaylist(converted);
        if (!stored.ok) {
          if (!options.silent) toast('歌单保存失败：' + (stored.message || stored.error));
          throw { ok: false, error: stored.error || 'STORE_FAILED', message: stored.message || '歌单保存失败' };
        }
        refreshPlaylistUI();
        var extra = converted.partial && converted.totalTracks > converted.songs.length
          ? '（平台仅返回 ' + converted.songs.length + ' / ' + converted.totalTracks + ' 首）'
          : '';
        if (!options.silent) toast('已导入歌单：' + converted.name + ' · ' + converted.songs.length + ' 首' + extra);
        return {
          ok: true,
          updated: stored.updated,
          playlist: {
            id: stored.playlist.id,
            name: converted.name,
            songCount: converted.songs.length,
            totalTracks: converted.totalTracks,
            partial: converted.partial,
            platformImportKey: converted.id,
          },
          message: '已导入 ' + converted.name + '，共 ' + converted.songs.length + ' 首' + extra,
        };
      };
      var hasExisting = (global.localPlaylistStore ? global.localPlaylistStore.list() : []).some(function (pl) {
        return pl && pl.platformImportKey === converted.id;
      });
      if (hasExisting && options.confirmDuplicate !== false && !options.silent) {
        return new Promise(function (resolve, reject) {
          if (global.confirm('歌单「' + converted.name + '」已导入过，重新导入将替换现有曲目。继续？')) {
            resolve(proceed());
          } else {
            resolve({ ok: false, canceled: true, message: '已取消导入' });
          }
        });
      }
      return proceed();
    });
  }

  // ---------- 对话框 ----------
  var dialogState = { open: false, busy: false, source: '' };

  function ensureDialogStyles() {
    if (document.getElementById('sf-ppi-style')) return;
    var style = document.createElement('style');
    style.id = 'sf-ppi-style';
    style.textContent = [
      '#sf-ppi-mask{position:fixed;inset:0;z-index:31500;display:none;align-items:center;justify-content:center;background:rgba(10,12,20,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
      '#sf-ppi-mask.open{display:flex}',
      '.sf-ppi-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow-y:auto;box-sizing:border-box;padding:22px 24px;border-radius:22px;background:linear-gradient(155deg,rgba(28,32,44,.92),rgba(12,15,22,.94));border:1px solid rgba(255,255,255,.22);box-shadow:0 22px 64px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.14);color:#e7ecff;font-family:inherit}',
      '.sf-ppi-title{margin:0 0 4px;font-size:17px;font-weight:650;letter-spacing:.02em}',
      '.sf-ppi-sub{margin:0 0 14px;font-size:12px;color:#a9b0d4;line-height:1.6}',
      '.sf-ppi-section-label{font-size:11px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:.6px;margin:12px 0 8px}',
      '.sf-ppi-entry-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}',
      '.sf-ppi-platform-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}',
      '.sf-ppi-btn{height:42px;border-radius:12px;border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.05);color:rgba(255,255,255,.68);font:600 12px/1 inherit;letter-spacing:.3px;cursor:pointer;transition:background .18s,color .18s,transform .18s,border-color .18s}',
      '.sf-ppi-btn:hover{background:rgba(255,255,255,.09);color:#fff;transform:translateY(-1px)}',
      '.sf-ppi-btn.active{color:#fff;border-color:rgba(140,170,255,.55);background:rgba(120,160,255,.16);box-shadow:0 0 18px rgba(120,160,255,.12),inset 0 1px 0 rgba(255,255,255,.1)}',
      '.sf-ppi-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}',
      '.sf-ppi-entry-grid .sf-ppi-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:48px}',
      '.sf-ppi-entry-btn small{font-size:10px;font-weight:500;color:rgba(255,255,255,.42)}',
      '.sf-ppi-textarea{box-sizing:border-box;width:100%;min-height:104px;resize:vertical;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.12);outline:0;background:rgba(0,0,0,.28);color:#fff;font:13px/1.6 inherit;transition:border-color .2s,box-shadow .2s}',
      '.sf-ppi-textarea:focus{border-color:rgba(140,170,255,.56);box-shadow:0 0 0 3px rgba(140,170,255,.1)}',
      '.sf-ppi-hint{min-height:34px;margin-top:9px;color:rgba(255,255,255,.44);font-size:11px;line-height:1.6}',
      '.sf-ppi-hint.error{color:#ff9aa8}.sf-ppi-hint.loading{color:#bcd4e8}',
      '.sf-ppi-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}',
      '.sf-ppi-cancel{height:38px;padding:0 18px;border-radius:11px;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.66);font:600 12.5px inherit;cursor:pointer}',
      '.sf-ppi-cancel:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.sf-ppi-confirm{height:38px;padding:0 22px;border-radius:11px;border:0;background:linear-gradient(150deg,rgba(120,160,255,.9),rgba(90,120,240,.92));color:#fff;font:650 12.5px inherit;cursor:pointer;box-shadow:0 8px 22px rgba(90,120,240,.28)}',
      '.sf-ppi-confirm:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function buildDialog() {
    ensureDialogStyles();
    var mask = document.createElement('div');
    mask.id = 'sf-ppi-mask';
    var entryButtons = [
      { label: '本地文件', small: '多选音频立即播放', action: 'local-file' },
      { label: '本地文件夹', small: '批量扫描子目录', action: 'local-folder' },
      { label: 'LX 歌单', small: '导入 .lxmc 文件', action: 'lxmc' },
      { label: 'LX 桌面版', small: '直读已装落雪曲库', action: 'lx-db' },
    ].map(function (entry) {
      return '<button class="sf-ppi-btn sf-ppi-entry-btn" data-entry="' + entry.action + '" type="button"><span>' + entry.label + '</span><small>' + entry.small + '</small></button>';
    }).join('');
    var platformButtons = PLATFORMS.map(function (platform, index) {
      return '<button class="sf-ppi-btn' + (index === 0 ? ' active' : '') + '" data-source="' + platform.code + '" type="button">' + platform.label + '</button>';
    }).join('');
    mask.innerHTML = [
      '<div class="sf-ppi-dialog" role="dialog" aria-modal="true" aria-label="平台歌单导入">',
      '<h3 class="sf-ppi-title">导入歌单</h3>',
      '<p class="sf-ppi-sub">粘贴手机 / 电脑端歌单分享文案、链接或纯数字歌单 ID；支持 QQ 音乐、网易云、酷我、酷狗（含概念版）、咪咕、Spotify、汽水、Apple 音乐公开歌单与专辑。</p>',
      '<div class="sf-ppi-section-label">本地导入</div>',
      '<div class="sf-ppi-entry-grid">' + entryButtons + '</div>',
      '<div class="sf-ppi-section-label">选择平台（链接已含平台信息时可留空）</div>',
      '<div class="sf-ppi-platform-grid">' + platformButtons + '</div>',
      '<textarea class="sf-ppi-textarea" id="sf-ppi-input" placeholder="粘贴分享文案、https://… 短链接，或纯数字歌单 ID" spellcheck="false"></textarea>',
      '<div class="sf-ppi-hint" id="sf-ppi-hint">默认自动识别平台；识别失败时请手动点选平台后重试。</div>',
      '<div class="sf-ppi-actions">',
      '<button class="sf-ppi-cancel" type="button">取消</button>',
      '<button class="sf-ppi-confirm" type="button">导 入</button>',
      '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(mask);

    mask.addEventListener('click', function (event) {
      if (event.target === mask) closeDialog();
    });
    mask.querySelector('.sf-ppi-cancel').addEventListener('click', closeDialog);
    mask.querySelector('.sf-ppi-confirm').addEventListener('click', onConfirm);
    mask.querySelectorAll('[data-source]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (dialogState.busy) return;
        mask.querySelectorAll('[data-source]').forEach(function (other) { other.classList.remove('active'); });
        button.classList.add('active');
        dialogState.source = button.getAttribute('data-source') || '';
      });
    });
    mask.querySelectorAll('[data-entry]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (dialogState.busy) return;
        var action = button.getAttribute('data-entry');
        closeDialog();
        if (action === 'local-file' && typeof global.toggleUploadPanel === 'function') global.toggleUploadPanel();
        else if (action === 'local-folder' && typeof global.openHomeLocalImport === 'function') global.openHomeLocalImport();
        else if (action === 'lxmc') openLxPlaylistImport();
        else if (action === 'lx-db') importLxDatabases();
      });
    });
    dialogState.source = 'tx';
    return mask;
  }

  function getDialog() {
    return document.getElementById('sf-ppi-mask') || buildDialog();
  }

  function closeDialog() {
    var mask = document.getElementById('sf-ppi-mask');
    if (mask) mask.classList.remove('open');
    dialogState.open = false;
  }

  function setHint(kind, text) {
    var hint = document.getElementById('sf-ppi-hint');
    if (!hint) return;
    hint.className = 'sf-ppi-hint' + (kind ? ' ' + kind : '');
    hint.textContent = text || '';
  }

  function onConfirm() {
    if (dialogState.busy) return;
    var input = document.getElementById('sf-ppi-input');
    var text = input ? input.value.trim() : '';
    if (!text) { setHint('error', '请先粘贴歌单分享链接或数字歌单 ID'); return; }
    dialogState.busy = true;
    var confirmBtn = document.querySelector('#sf-ppi-mask .sf-ppi-confirm');
    if (confirmBtn) confirmBtn.disabled = true;
    setHint('loading', '正在读取歌单…大歌单可能需要数十秒');
    importPlatformPlaylistFromInput(text, dialogState.source, { confirmDuplicate: true })
      .then(function (result) {
        if (result && result.ok) closeDialog();
        else if (result && result.canceled) setHint('', '已取消导入');
        else setHint('error', (result && result.message) || '导入失败');
      })
      .catch(function (error) {
        var message = (error && (error.message || error.error)) || '导入失败';
        if (/HTTP_40[13]/.test(String(message))) message = '平台拒绝访问，请换公开歌单或稍后重试';
        else if (/abort|timeout/i.test(String(message))) message = '读取超时，请检查网络后重试';
        setHint('error', '导入失败：' + message);
      })
      .finally(function () {
        dialogState.busy = false;
        if (confirmBtn) confirmBtn.disabled = false;
      });
  }

  function openPlatformPlaylistImport() {
    var mask = getDialog();
    mask.classList.add('open');
    dialogState.open = true;
    setHint('', '默认自动识别平台；识别失败时请手动点选平台后重试。');
    setTimeout(function () {
      var input = document.getElementById('sf-ppi-input');
      if (input) input.focus();
    }, 0);
    return { ok: true };
  }

  // ---------- .lxmc 文件导入（LX Music 导出格式）----------
  function decodeLxmcFile(file) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('当前系统不支持解压 .lxmc（需要 Chromium 80+）'));
    }
    // pipeThrough 返回 ReadableStream 而非 Promise：须经 Response 消费
    var stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text().then(function (text) {
      return JSON.parse(text);
    });
  }

  function normalizeLxmcPayload(payload) {
    var data = payload && payload.type === 'playListPart_v2' ? payload.data : payload;
    if (!data || !Array.isArray(data.list)) throw new Error('LXMC_FORMAT_UNSUPPORTED');
    return {
      id: 'lxmc_' + String(data.id || (Date.now() + '_' + Math.random().toString(36).slice(2))),
      name: String(data.name || '导入歌单'),
      cover: '',
      source: String(data.source || ''),
      sourceListId: String(data.sourceListId || ''),
      songs: data.list.filter(function (song) { return song && song.name && song.source; }).slice(0, MAX_SONGS).map(function (song) {
        return {
          name: song.name,
          singer: song.singer || '',
          songmid: song.songmid || song.id || '',
          source: song.source || '',
          interval: song.interval || 0,
          albumName: song.albumName || '',
          picUrl: song.picUrl || '',
          // 与平台导入一致：lx-online 让曲目走 custom-source 聚合解析可播
          type: 'lx-online',
        };
      }),
    };
  }

  function openLxPlaylistImport(options) {
    options = options || {};
    // 程序化直通（测试/AI 调用）：传入 files 时跳过文件选择器
    if (Array.isArray(options.files) && options.files.length) {
      return importLxmcFiles(options.files).then(function (summary) {
        refreshPlaylistUI();
        if (summary.imported) {
          toast('已导入 ' + summary.imported + ' 个 LX 歌单' + (summary.failed ? '，失败 ' + summary.failed + ' 个' : '') + '：' + summary.names.join('、'));
        } else {
          toast('LX 歌单导入失败' + (summary.failed ? '（' + summary.failed + ' 个文件）' : ''));
        }
        return { ok: !!summary.imported, imported: summary.imported, failed: summary.failed, names: summary.names };
      });
    }
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = '.lxmc,application/gzip,application/octet-stream';
    picker.style.display = 'none';
    picker.addEventListener('change', function () {
      var files = Array.prototype.slice.call(picker.files || []);
      document.body.removeChild(picker);
      if (!files.length) return;
      importLxmcFiles(files).then(function (summary) {
        refreshPlaylistUI();
        if (summary.imported) {
          toast('已导入 ' + summary.imported + ' 个 LX 歌单' + (summary.failed ? '，失败 ' + summary.failed + ' 个' : '') + '：' + summary.names.join('、'));
        } else {
          toast('LX 歌单导入失败' + (summary.failed ? '（' + summary.failed + ' 个文件）' : ''));
        }
      });
    });
    document.body.appendChild(picker);
    picker.click();
    return { ok: true };
  }

  function importLxmcFiles(files) {
    return new Promise(function (resolve) {
      var done = 0, failed = 0, names = [];
      function finish() {
        if (done < files.length) return;
        resolve({ imported: names.length, failed: failed, names: names });
      }
      if (!files.length) { resolve({ imported: 0, failed: 0, names: [] }); return; }
      files.forEach(function (file) {
        decodeLxmcFile(file).then(function (payload) {
          var converted = normalizeLxmcPayload(payload);
          if (!converted.songs.length) throw new Error('文件中没有可导入的歌曲');
          var stored = upsertImportedPlaylist(converted);
          if (!stored.ok) throw new Error(stored.message || stored.error);
          names.push(converted.name);
        }).catch(function (error) {
          failed += 1;
          console.warn('[LxmcImport]', file && file.name, error);
        }).finally(function () {
          done += 1;
          finish();
        });
      });
    });
  }

  // ---------- LX Music 桌面版数据库直读（LxDatas 借鉴，自 MR /api/lx/playlists 移植）----------
  // 免 .lxmc 手动导出：后端 node:sqlite 只读打开落雪 %APPDATA%/lx-music-desktop/LxDatas/lx.data.db，
  // 拉全部歌单+歌曲，前端按 lx_db_<listId> 键 upsert 到本地歌单库（重复扫描 = 刷新曲目）。
  function importLxDatabases(options) {
    options = options || {};
    return fetchJSON('/api/lx/playlists', { method: 'GET', timeoutMs: options.timeoutMs || 20000 })
      .then(function (result) {
        if (!result || result.ok === false) {
          throw new Error(result && result.message || result && result.error || 'LX_DATABASE_READ_FAILED');
        }
        var playlists = Array.isArray(result.playlists) ? result.playlists : [];
        if (!playlists.length) throw new Error('落雪音乐里没有可导入的歌单');
        var imported = 0, failed = 0, totalSongs = 0, names = [];
        playlists.forEach(function (list) {
          var converted = {
            id: 'lx_db_' + String(list.id || ''),
            name: String(list.name || '落雪歌单'),
            cover: '',
            source: String(list.source || ''),
            sourceListId: String(list.sourceListId || ''),
            totalTracks: (list.songs || []).length,
            partial: false,
            importLimitReason: '',
            songs: (Array.isArray(list.songs) ? list.songs : []).slice(0, MAX_SONGS).map(convertSong)
              .filter(function (song) { return song.name && song.songmid; }),
          };
          if (!converted.songs.length) return;
          var stored = upsertImportedPlaylist(converted);
          if (stored && stored.ok) {
            imported += 1;
            totalSongs += converted.songs.length;
            names.push(converted.name);
          } else {
            failed += 1;
            console.warn('[LxDbImport]', converted.name, stored && stored.message);
          }
        });
        refreshPlaylistUI();
        if (imported) {
          var preservedNote = failed ? '，失败 ' + failed + ' 个' : '';
          toast('已从落雪桌面版导入 ' + imported + ' 个歌单，共 ' + totalSongs + ' 首' + preservedNote);
        } else {
          toast('落雪桌面版歌单导入失败');
        }
        return { ok: !!imported, imported: imported, failed: failed, songCount: totalSongs, names: names };
      })
      .catch(function (error) {
        var message = String(error && error.message || error);
        if (/LX_DATABASE_NOT_FOUND|DATABASE_READ/i.test(message)) {
          message = '未找到落雪音乐数据库；请确认电脑已安装 LX Music 桌面版且至少打开过一次';
        }
        toast('LX 桌面版扫描失败：' + message);
        return { ok: false, error: 'LX_DATABASE_IMPORT_FAILED', message: message };
      });
  }

  // ---------- 其余 opener：委托 Stellaflix 既有入口 ----------
  function openPlaylistSelection() {
    if (typeof global.openPlaylistPanelTab === 'function') {
      global.openPlaylistPanelTab('playlists', true);
      return { ok: true };
    }
    return { ok: false, error: 'PLAYLIST_PANEL_NOT_READY', message: '歌单面板尚未初始化' };
  }

  function openLxSourceImport() {
    if (typeof global.openCustomSourceModal === 'function') {
      global.openCustomSourceModal();
      return { ok: true };
    }
    return { ok: false, error: 'SOURCE_MANAGER_NOT_READY', message: '音源管理器尚未初始化' };
  }

  function openLocalFileImport() {
    if (typeof global.toggleUploadPanel === 'function') { global.toggleUploadPanel(); return { ok: true }; }
    return { ok: false, error: 'UPLOAD_PANEL_NOT_READY', message: '上传面板尚未初始化' };
  }

  function openLocalFolderImport() {
    if (typeof global.openHomeLocalImport === 'function') { global.openHomeLocalImport(); return { ok: true }; }
    return { ok: false, error: 'LOCAL_IMPORT_NOT_READY', message: '本地导入尚未初始化' };
  }

  // ---------- 挂载（覆盖 agent-adapter / agent-music-tools 等待的钩子）----------
  global.importPlatformPlaylistFromInput = importPlatformPlaylistFromInput;
  global.openPlatformPlaylistImport = openPlatformPlaylistImport;
  global.openLxPlaylistImport = openLxPlaylistImport;
  global.openPlaylistSelection = openPlaylistSelection;
  global.openLxSourceImport = openLxSourceImport;
  global.openLocalFileImport = openLocalFileImport;
  global.openLocalFolderImport = openLocalFolderImport;
  global.importLxDatabases = importLxDatabases;
  global.sfPlatformPlaylistImport = {
    importPlatformPlaylistFromInput: importPlatformPlaylistFromInput,
    openPlatformPlaylistImport: openPlatformPlaylistImport,
    openLxPlaylistImport: openLxPlaylistImport,
    importLxDatabases: importLxDatabases,
    convertSong: convertSong,
    convertImported: convertImported,
    upsertImportedPlaylist: upsertImportedPlaylist,
  };
})(window);
