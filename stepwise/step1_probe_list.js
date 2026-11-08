/**
 * 抖音 KTV · 第一步：验证能否拿到完整已点列表
 *
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)
 * 环境：QuickHook (QuickJS)
 *
 * ── 本脚本只做一件事 ──────────────────────────────
 * Hook PlayListContainerView.LIZJ(java.util.List) 的 after，
 * 把列表大小、每首歌的基本信息打到日志里。
 *
 * 不含任何 UI 操作、不含下载。
 * 目的是先确认：这个 Hook 能不能命中、list 里到底是什么数据。
 * ─────────────────────────────────────────────────
 */

log('=== 第1步：验证列表获取 ===');

// ── 记录命中次数，方便看 LIZJ 到底被调了多少次 ──
var hitCount = 0;

// ── 收集到的歌曲（纯 JS 对象，不存 Java 句柄） ──
var collected = [];
var collectedKeys = {};

/* ================= 工具 ================= */

/** 安全读字段：句柄 $get → 直接属性 → getter */
function getField(o, n) {
    if (!o) return null;
    try {
        var v = o.$get(n);
        if (v !== undefined && v !== null) return v;
    } catch (e) {}
    try {
        var v2 = o[n];
        if (v2 !== undefined && v2 !== null) return v2;
    } catch (e) {}
    try {
        var g = 'get' + n.charAt(0).toUpperCase() + n.slice(1);
        if (typeof o[g] === 'function') return o[g]();
    } catch (e) {}
    return null;
}

/** List / 数组 统一取长度 */
function listLen(x) {
    if (!x) return 0;
    try { if (x.size) return x.size(); } catch (e) {}
    try { if (typeof x.length === 'number') return x.length; } catch (e) {}
    return 0;
}

/** List / 数组 统一取元素 */
function listGet(x, i) {
    if (!x) return null;
    try { if (x.get) return x.get(i); } catch (e) {}
    try { return x[i]; } catch (e) {}
    return null;
}

/** 从任意文本里抓第一个 http(s) 链接 */
var URL_RE = /https?:\/\/[^\s"'\\<>\)\],;]+/g;
function firstUrl(t) {
    if (!t || typeof t !== 'string') return '';
    URL_RE.lastIndex = 0;
    var m = t.match(URL_RE);
    return (m && m.length) ? m[0] : '';
}

function flatten(o, depth) {
    depth = depth || 0;
    if (o === null || o === undefined) return '';
    if (typeof o === 'string') return o;
    if (typeof o === 'number' || typeof o === 'boolean') return String(o);
    if (depth > 2) return '';
    var b = '';
    try { b += String(o.$str()) + '\n'; } catch (e) {}
    return b;
}

/* ================= 取音频信息（分级尝试） ================= */

/**
 * 返回 {url, track, hash}，取不到则 url=''
 * 顺序：伴奏 TC() → 全轨 WC() → sD() → iD() → aD()
 */
function pickAudio(music) {
    // ① 伴奏：TC() → AudioInfo.MC()=url, KC()=hash
    try {
        var ai = music.TC();
        if (ai) {
            var u = ai.MC();
            if (u && String(u).length > 10) {
                var h = '';
                try { h = ai.KC(); } catch (e) {}
                return { url: String(u), track: 'accompaniment', hash: h ? String(h) : '' };
            }
        }
    } catch (e) {}

    // ② 全轨：WC()
    try {
        var af = music.WC();
        if (af) {
            var u2 = af.MC();
            if (u2 && String(u2).length > 10) {
                var h2 = '';
                try { h2 = af.KC(); } catch (e) {}
                return { url: String(u2), track: 'fullTrack', hash: h2 ? String(h2) : '' };
            }
        }
    } catch (e) {}

    // ③ 直给 String
    var direct = [{ m: 'sD', t: 'extra_s' }, { m: 'iD', t: 'extra_i' }];
    for (var i = 0; i < direct.length; i++) {
        try {
            var fn = music[direct[i].m];
            if (typeof fn !== 'function') continue;
            var s = fn.call(music);
            if (s && /^https?:/i.test(String(s))) {
                return { url: String(s), track: direct[i].t, hash: '' };
            }
        } catch (e) {}
    }

    // ④ URL 列表
    try {
        var lst = music.aD();
        var n = listLen(lst);
        for (var k = 0; k < n && k < 5; k++) {
            var el = listGet(lst, k);
            if (el && /^https?:/i.test(String(el))) {
                return { url: String(el), track: 'list', hash: '' };
            }
        }
    } catch (e) {}

    return { url: '', track: '', hash: '' };
}

/* ================= 采集单首 ================= */
function parsePanel(panel) {
    try {
        // MusicPanel.LIZ = KtvMusic
        var music = getField(panel, 'LIZ');
        if (!music) return null;

        // 歌名
        var title = '';
        try { var t = music.getTitle(); if (t) title = String(t); } catch (e) {}
        if (!title) { try { var t2 = music.fD(); if (t2) title = String(t2); } catch (e) {} }
        if (!title) { var t3 = getField(music, 'd'); if (typeof t3 === 'string') title = t3; }
        if (!title) title = '(无标题)';

        // 歌手
        var artist = '';
        try { var a = music.YC(); if (a && String(a).length < 50) artist = String(a); } catch (e) {}
        if (!artist) {
            var b = getField(music, 'b');
            if (typeof b === 'string' && b.length < 50) artist = b;
        }

        // musicId
        var musicId = 0;
        try { musicId = music.XC(); } catch (e) {}
        if (!musicId) { try { musicId = music.getId(); } catch (e) {} }

        var audio = pickAudio(music);

        return {
            title: title,
            artist: artist,
            musicId: String(musicId || ''),
            url: audio.url,
            track: audio.track,
            hash: audio.hash
        };
    } catch (e) {
        loge('parsePanel 异常: ' + e);
        return null;
    }
}

/* ================= 核心 Hook ================= */
var PLAY_LIST = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';

try {
    Hook.method(PLAY_LIST, 'LIZJ', ['java.util.List'], function (ctx) {
        hitCount++;

        try {
            var list = ctx.args[0];

            // ── 1) 先确认参数本身 ──
            var n = listLen(list);
            log('──────── LIZJ 第 ' + hitCount + ' 次 ────────');
            log('参数类型: ' + (list ? (list.$type || (typeof list)) : 'null'));
            log('列表长度: ' + n);

            if (!list) {
                logw('参数为 null，跳过');
                return;
            }

            // ── 2) 逐个解析 ──
            var okCount = 0;
            var urlCount = 0;

            for (var i = 0; i < n; i++) {
                var panel = listGet(list, i);
                if (!panel) { log('  [' + i + '] 元素为 null'); continue; }

                var info = parsePanel(panel);
                if (!info) { log('  [' + i + '] 解析失败'); continue; }

                okCount++;
                if (info.url) urlCount++;

                var line = '  [' + i + '] ' + info.title;
                if (info.artist) line += ' - ' + info.artist;
                line += '  id=' + info.musicId;
                line += '  ' + (info.url ? ('✔' + info.track) : '✘无URL');
                log(line);

                // 存进池子（纯 JS，不存句柄）
                var key = info.title + '|' + info.artist;
                if (!collectedKeys[key]) {
                    collectedKeys[key] = true;
                    collected.push(info);
                }
            }

            log('小结: 解析成功 ' + okCount + '/' + n + '，其中有 URL 的 ' + urlCount + ' 首');
            log('累计去重后共 ' + collected.length + ' 首');

            // ── 3) 第一首的 URL 完整打出来，方便确认格式 ──
            if (collected.length > 0 && collected[0].url) {
                log('首曲 URL 示例: ' + collected[0].url);
            }

        } catch (e) {
            loge('LIZJ 回调异常: ' + e);
        }
    }, 'after');

    logi('✓ Hook 已挂: PlayListContainerView.LIZJ(java.util.List)');
} catch (e) {
    loge('✗ Hook 失败: ' + e);
    loge('可能原因：类名变了 / 方法签名不对 / 类还没加载');
}

/* ================= 手动诊断 ================= */

/** 打印累计采集结果 */
function show() {
    log('===== 累计采集 ' + collected.length + ' 首 =====');
    for (var i = 0; i < collected.length; i++) {
        var s = collected[i];
        log((i + 1) + '. ' + s.title + ' - ' + s.artist
            + '  id=' + s.musicId
            + '  ' + (s.url ? s.track : '无URL'));
        if (s.url) log('    ' + s.url);
    }
}

/** 打印 Hook 命中情况 */
function stat() {
    log('LIZJ 命中次数: ' + hitCount);
    log('累计歌曲数: ' + collected.length);
}

log('提示：点歌面板打开后 → show() 看结果 / stat() 看命中次数');
