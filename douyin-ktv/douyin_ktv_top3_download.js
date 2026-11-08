/**
 * 抖音 KTV 点歌面板增强 · v7 重写版
 *
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)
 * 环境：QuickHook (QuickJS)
 *
 * ══════════════════════════════════════════════════════
 * v7 的关键改动：不再依赖 QuickHook 的 $fields / $get
 *
 * 上一版 collect() 返回 0/N，原因是 panel.LIZ 读不到。
 * $fields() 和 $get() 是对 Java 反射的封装，对 PPS 动态生成的类
 * （KtvMusic / MusicPanel 都是）可能不生效。
 *
 * 本版直接用 Java 原生反射：
 *   obj.getClass().getDeclaredFields()
 *   field.setAccessible(true); field.get(obj)
 * 这条路绕开了所有封装层，能拿到真实字段名和值。
 * ══════════════════════════════════════════════════════
 */

var BUILD = 'v7-rewrite';
var CFG = {
    /**
     * 'probe' = 只诊断（默认）：打印元素结构，不碰 UI、不下载
     * 'prod'  = 正常功能：注入按钮 + 下载
     */
    mode: 'probe',

    maxRows: 3,          // 只处理前 3 行
    threads: 6,          // 下载并发（API 上限 8）
    retries: 3,
    timeout: 30000,
    ua: 'okhttp/3.12.13',
    referer: 'https://live.douyin.com/',

    btnText: '下载',
    defaultTrack: 'accompaniment',
    defaultExt: '.mp3'
};

/* ===== 常量：反编译确认的资源 id ===== */
var RV_ID = 2131404728;          // zj+  已点列表 RecyclerView
var TRIGGER_HOST_ID = 2131404503; // zeq  一级页签右侧空白区

var PLAYLIST_CLS = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';

function d() { if (CFG.debug !== false) logd.apply(null, arguments); }

log('╔════════════════════════════════════╗');
log('║ KTV 脚本 ' + BUILD + '  mode=' + CFG.mode);
log('╚════════════════════════════════════╝');

/* ================= 全局状态 ================= */
var songs = {};              // key -> info（纯 JS 对象）
var order = [];
var listRv = null;           // 已点列表的 RecyclerView 实例
var targetRv = null;
var armed = false;           // 是否允许注入
var triggerHost = null;      // zeq 容器句柄
var triggerMounted = false;
var lastSig = '';
var dirty = false, flushing = false;
var probeDone = false;

/* ================= 基础工具 ================= */

function listLen(x) {
    if (!x) return 0;
    try { if (x.size) return x.size(); } catch (e) {}
    try { if (typeof x.length === 'number') return x.length; } catch (e) {}
    return 0;
}

function listGet(x, i) {
    if (!x) return null;
    try { if (x.get) return x.get(i); } catch (e) {}
    try { return x[i]; } catch (e) {}
    return null;
}

function asArray(x) {
    if (!x) return [];
    if (Object.prototype.toString.call(x) === '[object Array]') return x;
    var out = [];
    var n = listLen(x);
    for (var i = 0; i < n; i++) out.push(listGet(x, i));
    return out;
}

function safeName(s) {
    if (!s) return '';
    return String(s).replace(/[\\\/:*?"<>|\r\n\t]/g, '_').slice(0, 50);
}

function keyOf(t, a) { return (t || '') + '|' + (a || ''); }

var URL_RE = /https?:\/\/[^\s"'\\<>\)\],;]+/g;
function firstUrl(t) {
    if (!t || typeof t !== 'string') return '';
    URL_RE.lastIndex = 0;
    var m = t.match(URL_RE);
    return (m && m.length) ? m[0] : '';
}

function extFromUrl(u) {
    try {
        var clean = String(u).split('?')[0].split('#')[0];
        var m = clean.match(/\.(mp3|m4a|aac|wav|flac|ogg|mp4|m4s)$/i);
        if (m) return '.' + m[1].toLowerCase();
    } catch (e) {}
    return CFG.defaultExt;
}

/* ================= 类型 / 字符串 ================= */

function typeNameOf(o) {
    if (o === null) return 'null';
    if (o === undefined) return 'undefined';
    try { var t = o.$type; if (t) return String(t); } catch (e) {}
    try { var c = o.getClass(); if (c) return String(c.getName()); } catch (e) {}
    return typeof o;
}

function shortType(full) {
    var s = String(full);
    var i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i + 1) : s;
}

function strOf(o, max) {
    if (o === null || o === undefined) return String(o);
    max = max || 300;
    try { var s = o.$str(); if (s) return String(s).slice(0, max); } catch (e) {}
    try { return String(o).slice(0, max); } catch (e) {}
    return '?';
}

/* ================= ★ 核心：Java 原生反射取字段 ================= */
/**
 * 用 getDeclaredFields() 逐层向上遍历，拿真实字段名和值。
 * 这条路不经过 QuickHook 的 $fields/$get 封装，
 * 对 PPS 生成的类（KtvMusic / MusicPanel）更可靠。
 */
function reflectDump(obj, tag, opt) {
    opt = opt || {};
    var maxDepth = opt.depth || 0;      // 0=只当前类, 1=再挖一层
    var out = [];

    if (!obj) {
        log(tag + ': null');
        return out;
    }

    log(tag + '  类型=' + shortType(typeNameOf(obj)));

    var cls = null;
    try { cls = obj.getClass(); } catch (e) {
        loge(tag + ' getClass 失败: ' + e);
        return out;
    }

    var level = 0;
    while (cls && level <= 3) {
        var cname = '';
        try { cname = String(cls.getName()); } catch (e) {}
        if (cname === 'java.lang.Object') break;

        var fields = null;
        try { fields = cls.getDeclaredFields(); } catch (e) {}

        if (fields) {
            var n = 0;
            try { n = fields.length; } catch (e) {}
            for (var i = 0; i < n; i++) {
                var f = fields[i];
                if (!f) continue;
                var fname = '', ftype = '';
                try { fname = String(f.getName()); } catch (e) { continue; }
                try { ftype = shortType(String(f.getType().getName())); } catch (e) {}

                // 跳过编译器生成的
                if (fname.indexOf('$') === 0) continue;
                if (fname === 'Companion' || fname === 'META') continue;

                var val = null;
                try {
                    f.setAccessible(true);
                    val = f.get(obj);
                } catch (e) {
                    // 静态字段用 get(null)，但已 setAccessible，一般能成
                }

                var vs = '';
                var vt = typeNameOf(val);
                if (val === null) {
                    vs = ' = null';
                } else if (typeof val === 'string') {
                    vs = ' = "' + (val.length > 60 ? val.slice(0, 60) + '...' : val) + '"';
                } else if (typeof val === 'number' || typeof val === 'boolean') {
                    vs = ' = ' + val;
                } else {
                    vs = '  →' + shortType(vt);
                }

                log('  ' + tag + ' .' + fname + ' [' + ftype + ']' + vs);
                out.push({ name: fname, type: ftype, value: val });

                // 递归挖一层
                if (maxDepth > 0 && val && typeof val === 'object' && vt !== 'String') {
                    var st = shortType(vt);
                    if (st !== 'String' && st.indexOf('Integer') < 0 && st.indexOf('Long') < 0) {
                        reflectDump(val, tag + '.' + fname, { depth: maxDepth - 1 });
                    }
                }
            }
        }

        try { cls = cls.getSuperclass(); } catch (e) { break; }
        level++;
    }

    return out;
}

/** 从反射结果里按类型找字段 */
function findFieldByType(fields, typeKeyword) {
    for (var i = 0; i < fields.length; i++) {
        if (String(fields[i].type).indexOf(typeKeyword) >= 0) return fields[i];
    }
    return null;
}

/** 从反射结果里按名字找字段 */
function findFieldByName(fields, name) {
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].name === name) return fields[i];
    }
    return null;
}

/* ================= 数据解析（基于反射） ================= */

/** 从 KtvMusic 取音频 URL —— 多路尝试 */
function pickUrlFromMusic(music) {
    // ① 官方路径：TC()/WC() 返回 AudioInfo，再 MC()
    var pairs = [['TC', 'accompaniment'], ['WC', 'fullTrack']];
    for (var i = 0; i < pairs.length; i++) {
        try {
            var fn = music[pairs[i][0]];
            if (typeof fn !== 'function') continue;
            var ai = fn.call(music);
            if (!ai) continue;
            var u = null;
            try { u = ai.MC(); } catch (e) {}
            if (u && String(u).length > 10) {
                var h = '';
                try { h = ai.KC(); } catch (e) {}
                return { url: String(u), track: pairs[i][1], hash: h ? String(h) : '' };
            }
        } catch (e) {}
    }

    // ② 直给 String 的方法
    var dirs = [['sD', 'extra_s'], ['iD', 'extra_i']];
    for (var j = 0; j < dirs.length; j++) {
        try {
            var f2 = music[dirs[j][0]];
            if (typeof f2 !== 'function') continue;
            var s = f2.call(music);
            if (s && /^https?:/i.test(String(s))) {
                return { url: String(s), track: dirs[j][1], hash: '' };
            }
        } catch (e) {}
    }

    // ③ 反射：扫所有 String 字段，找 http
    var fs = reflectFieldsOnly(music);
    for (var k = 0; k < fs.length; k++) {
        if (fs[k].type === 'String' && typeof fs[k].value === 'string') {
            var uu = firstUrl(fs[k].value);
            if (uu) {
                return { url: uu, track: 'reflect:' + fs[k].name, hash: '' };
            }
        }
    }

    // ④ 兜底：toString 里捞
    var tu = firstUrl(strOf(music, 3000));
    if (tu) return { url: tu, track: 'toString', hash: '' };

    return null;
}

/** 只取字段，不打印（给 pickUrl 用） */
function reflectFieldsOnly(obj) {
    var out = [];
    if (!obj) return out;
    var cls = null;
    try { cls = obj.getClass(); } catch (e) { return out; }
    var level = 0;
    while (cls && level <= 3) {
        var cname = '';
        try { cname = String(cls.getName()); } catch (e) {}
        if (cname === 'java.lang.Object') break;
        var fields = null;
        try { fields = cls.getDeclaredFields(); } catch (e) {}
        if (fields) {
            var n = 0;
            try { n = fields.length; } catch (e) {}
            for (var i = 0; i < n; i++) {
                var f = fields[i];
                if (!f) continue;
                var fname = '';
                try { fname = String(f.getName()); } catch (e) { continue; }
                if (fname.indexOf('$') === 0) continue;
                var ftype = '';
                try { ftype = shortType(String(f.getType().getName())); } catch (e) {}
                var val = null;
                try { f.setAccessible(true); val = f.get(obj); } catch (e) {}
                out.push({ name: fname, type: ftype, value: val });
            }
        }
        try { cls = cls.getSuperclass(); } catch (e) { break; }
        level++;
    }
    return out;
}

/** 从 KtvMusic 取歌名 */
function pickTitle(music) {
    var methods = ['getTitle', 'fD'];
    for (var i = 0; i < methods.length; i++) {
        try {
            var fn = music[methods[i]];
            if (typeof fn !== 'function') continue;
            var v = fn.call(music);
            if (v) return String(v);
        } catch (e) {}
    }
    // 反射找 String 字段（排除 url 类）
    var fs = reflectFieldsOnly(music);
    for (var j = 0; j < fs.length; j++) {
        var f = fs[j];
        if (f.type !== 'String') continue;
        if (typeof f.value !== 'string' || !f.value) continue;
        if (/^https?:/i.test(f.value)) continue;
        if (f.value.length < 40) return f.value;
    }
    return '';
}

/** 从 KtvMusic 取歌手 */
function pickArtist(music) {
    try {
        var fn = music.YC;
        if (typeof fn === 'function') {
            var v = fn.call(music);
            if (v && String(v).length < 50) return String(v);
        }
    } catch (e) {}
    return '';
}

/** 从 KtvMusic 取 musicId */
function pickMusicId(music) {
    try { var v = music.XC(); if (v) return String(v); } catch (e) {}
    try { var v2 = music.getId(); if (v2) return String(v2); } catch (e) {}
    return '';
}

/* ================= 解析一个 MusicPanel ================= */
var failShown = false;

function parsePanel(panel, idx) {
    if (!panel) return null;

    // 定位 KtvMusic：反射按类型找，不用猜字段名
    var pfields = reflectFieldsOnly(panel);
    var music = null, byField = '';

    // ① 按类型名含 KtvMusic
    var mf = findFieldByType(pfields, 'KtvMusic');
    if (mf && mf.value) {
        music = mf.value;
        byField = mf.name;
    }

    // ② 兜底：试常见字段名
    if (!music) {
        var cands = ['LIZ', 'a', 'music', 'musicInfo'];
        for (var i = 0; i < cands.length; i++) {
            var cf = findFieldByName(pfields, cands[i]);
            if (cf && cf.value) { music = cf.value; byField = cf.name; break; }
        }
    }

    if (!music) {
        if (!failShown) {
            failShown = true;
            loge('【解析失败】panel 里找不到 KtvMusic 类型字段');
            log('  panel 字段共 ' + pfields.length + ' 个:');
            for (var k = 0; k < pfields.length && k < 25; k++) {
                var f = pfields[k];
                var vs = '';
                if (typeof f.value === 'string') vs = ' = "' + f.value.slice(0, 50) + '"';
                else if (typeof f.value === 'number' || typeof f.value === 'boolean') vs = ' = ' + f.value;
                else vs = '  →' + shortType(typeNameOf(f.value));
                log('    ' + f.name + ' [' + f.type + ']' + vs);
            }
        }
        return null;
    }

    var title = pickTitle(music);
    var artist = pickArtist(music);
    var musicId = pickMusicId(music);
    var audio = pickUrlFromMusic(music);

    var info = {
        key: keyOf(title, artist),
        title: title || ('#' + (musicId || idx)),
        artist: artist,
        musicId: musicId,
        url: audio ? audio.url : '',
        track: audio ? audio.track : CFG.defaultTrack,
        hash: audio ? audio.hash : '',
        ext: audio ? extFromUrl(audio.url) : CFG.defaultExt,
        viaField: byField
    };

    return info;
}

/** 批量采集 */
var _lastCount = -1;
function collectAll(list) {
    var n = listLen(list);
    if (!n) return 0;

    var ok = 0, hasUrl = 0;
    for (var i = 0; i < n; i++) {
        var info = parsePanel(listGet(list, i), i);
        if (!info) continue;
        ok++;
        if (info.url) hasUrl++;

        if (!songs[info.key]) order.push(info.key);
        songs[info.key] = info;
    }

    logi('采集 ' + ok + '/' + n + ' 首，有 URL ' + hasUrl + ' 首');
    if (ok > 0 && _lastCount < 0) {
        _lastCount = ok;
        // 第一次成功时，打一首样例
        log('样例: ' + songs[order[0]].title
            + '  via=' + songs[order[0]].viaField
            + '  ' + (songs[order[0]].url ? 'URL✔' : 'URL✘'));
    }
    return ok;
}

/* ================= PROBE 诊断 ================= */

function probeOnce(list) {
    if (probeDone) return false;

    log('');
    log('╔══════════ PROBE ══════════╗');

    var n = listLen(list);
    log('列表长度: ' + n);
    log('List 类型: ' + shortType(typeNameOf(list)));

    if (!n) {
        log('列表为空，等下次');
        return false;
    }

    probeDone = true;

    var first = listGet(list, 0);
    log('');
    log('--- 第 0 个元素 完整结构 ---');
    reflectDump(first, '[0]', { depth: 1 });

    log('');
    log('--- 用反射解析试试 ---');
    var info = parsePanel(first, 0);
    if (info) {
        log('✓ 解析成功');
        log('  歌名: ' + info.title);
        log('  歌手: ' + info.artist);
        log('  id  : ' + info.musicId);
        log('  来源: ' + info.viaField);
        log('  URL : ' + (info.url ? info.url.slice(0, 150) : '(无)'));
        log('  音轨: ' + info.track);
    } else {
        loge('✗ 解析失败，看上面的字段列表');
    }

    log('');
    log('--- 其余元素类型速览 ---');
    var max = Math.min(n, 4);
    for (var i = 1; i < max; i++) {
        log('  [' + i + '] ' + shortType(typeNameOf(listGet(list, i))));
    }

    log('╚══════════ PROBE ══════════╝');
    log('');
    return true;
}

/* ================= UI 注入 ================= */
var TAG_DL = 'qh_dl', TAG_MORE = 'qh_more', TAG_INFO = 'qh_info', TAG_TRIGGER = 'qh_trig';

function makeBtn(text, tag) {
    var b = Ui.create('button', text);
    try { b.setContentDescription(tag); } catch (e) {}
    try { b.setTextSize(11); } catch (e) {}
    try { b.setPadding(22, 6, 22, 6); } catch (e) {}
    return b;
}

function findBtn(root, tag) {
    try {
        var a = asArray(Ui.find(root, { desc: tag }));
        return a.length ? a[0] : null;
    } catch (e) { return null; }
}

function insertAfter(anchor, btn, fallback) {
    try { Ui.insert(anchor, btn, 'after'); return true; } catch (e) {}
    try { Ui.insert(fallback, btn, 'child'); return true; } catch (e) {}
    return false;
}

/** 下载 */
function startDownload(info) {
    if (!info || !info.url) { toast('无可用地址'); return false; }

    var path = buildPath(info);
    var dir = path.substring(0, path.lastIndexOf('/'));

    try { File.mkdir(dir); } catch (e) { loge('建目录失败: ' + e); return false; }

    try {
        if (File.exists(path) && File.size(path) > 1024) {
            toast('已缓存: ' + info.title);
            return true;
        }
    } catch (e) {}

    logi('下载 [' + info.title + '] → ' + path);

    try {
        download({
            url: info.url,
            path: path,
            threads: CFG.threads,
            retries: CFG.retries,
            timeout: CFG.timeout,
            headers: { 'User-Agent': CFG.ua, 'Referer': CFG.referer },
            onDone: function (s) {
                logi('完成 [' + info.title + '] ' + (s && s.done ? s.done : '?') + 'B');
                toast('完成: ' + info.title);
            },
            onError: function (e) {
                loge('失败 [' + info.title + ']: ' + e);
            }
        });
        return true;
    } catch (e) {
        loge('download 异常: ' + e);
        return false;
    }
}

/** 落盘：<root>/musicPack/<musicId>/<track>/<file> */
function buildPath(info) {
    var root = '';
    try { root = String(Java.use('X.0FKH').LIZ()); } catch (e) { loge('取根目录失败: ' + e); }
    if (!root) root = '/sdcard';
    if (root.charAt(root.length - 1) === '/') root = root.slice(0, -1);

    var id = info.musicId || '0';
    var track = info.track || CFG.defaultTrack;

    var base = info.hash ? safeName(info.hash)
                         : safeName(info.title) + '_' + id;
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += info.ext || CFG.defaultExt;

    return root + '/musicPack/' + safeName(id) + '/' + track + '/' + base;
}

function injectOne(itemUi, info) {
    try {
        var dl = findBtn(itemUi, TAG_DL);
        if (dl) {
            Ui.onClick(dl, function () { startDownload(info); });
            var more = findBtn(itemUi, TAG_MORE);
            if (more) Ui.onClick(more, function () { showInfo(itemUi, info); });
            return false;
        }

        var btn = makeBtn(CFG.btnText, TAG_DL);
        if (!insertAfter(null, btn, itemUi)) return false;

        try {
            var LP = Java.use('androidx.constraintlayout.widget.ConstraintLayout$LayoutParams');
            var lp = LP.$new(-2, -2);
            lp.topToTop = 0; lp.endToEnd = 0; lp.bottomToBottom = 0;
            try { lp.setMarginEnd(14); } catch (e) {}
            btn.setLayoutParams(lp);
        } catch (e) {}

        Ui.onClick(btn, function () { startDownload(info); });

        var m = makeBtn('更多', TAG_MORE);
        if (insertAfter(btn, m, itemUi)) {
            Ui.onClick(m, function () { showInfo(itemUi, info); });
        }

        logi('注入 [' + info.title + ']' + (info.url ? '✔' : '✘'));
        return true;
    } catch (e) {
        loge('injectOne: ' + e);
        return false;
    }
}

function showInfo(itemUi, info) {
    Ui.alert('歌曲信息',
        '歌名：' + info.title +
        '\n歌手：' + (info.artist || '-') +
        '\nID：' + (info.musicId || '-') +
        '\n音轨：' + info.track +
        '\n\n' + (info.url || '(无地址)'));
}

function visibleItems(rv) {
    var out = [];
    if (!rv) return out;
    var n = 0;
    try { n = rv.getChildCount(); } catch (e) { return out; }
    if (!n) return out;

    var rvTop = 0, rvBottom = 0;
    try { rvTop = rv.getTop(); rvBottom = rv.getBottom(); } catch (e) {}

    for (var i = 0; i < n; i++) {
        var c = null;
        try { c = rv.getChildAt(i); } catch (e) { continue; }
        if (!c) continue;

        var shown = true;
        try { shown = c.isShown(); } catch (e) {}
        if (!shown) continue;

        var h = 0;
        try { h = c.getHeight(); } catch (e) {}
        if (h <= 0) continue;

        var top = 0, bottom = 0;
        try { top = c.getTop(); bottom = c.getBottom(); } catch (e) {}
        if (rvBottom > rvTop && (bottom <= rvTop || top >= rvBottom)) continue;

        var pos = -1;
        try { pos = rv.getChildAdapterPosition(c); } catch (e) {}
        if (pos < 0) { try { pos = rv.getChildLayoutPosition(c); } catch (e) {} }

        out.push({ view: c, pos: pos });
    }
    return out;
}

function labelOf(itemUi) {
    try {
        var tvs = asArray(Ui.find(itemUi, { cls: 'TextView' }));
        var fb = '';
        for (var i = 0; i < tvs.length; i++) {
            var t = Ui.text(tvs[i]);
            if (!t) continue;
            t = String(t).trim();
            if (t.length < 1 || t.length > 40) continue;
            if (/^\d+$/.test(t)) continue;
            if (/^\d{1,2}:\d{2}$/.test(t)) continue;
            if (findSongByLabel(t)) return t;
            if (!fb) fb = t;
        }
        return fb;
    } catch (e) { return ''; }
}

function findSongByLabel(label) {
    if (!label) return null;
    label = String(label).trim();
    for (var k in songs) {
        if (!songs.hasOwnProperty(k)) continue;
        if (songs[k].title === label) return songs[k];
    }
    for (var k2 in songs) {
        if (!songs.hasOwnProperty(k2)) continue;
        if (songs[k2].title.indexOf(label) >= 0 || label.indexOf(songs[k2].title) >= 0) return songs[k2];
    }
    return null;
}

function refresh() {
    if (!armed) return;
    var rv = listRv || targetRv;
    if (!rv) return;

    var items = visibleItems(rv);
    if (!items.length) { d('无可视 item'); return; }

    var picked = [];
    for (var i = 0; i < items.length; i++) {
        if (items[i].pos >= 0 && items[i].pos < CFG.maxRows) picked.push(items[i]);
    }
    if (!picked.length) return;
    picked.sort(function (a, b) { return a.pos - b.pos; });

    var sigParts = [], todo = [];
    for (var j = 0; j < picked.length; j++) {
        var p = picked[j];
        var itemUi = null;
        try { itemUi = Ui.root(p.view); } catch (e) {}
        if (!itemUi) continue;

        var label = labelOf(itemUi);
        if (!label) continue;

        var info = findSongByLabel(label);
        if (!info) continue;

        sigParts.push(p.pos + ':' + label);
        todo.push({ ui: itemUi, info: info });
    }

    var sig = sigParts.join('|');
    if (sig && sig === lastSig) return;
    lastSig = sig;

    var n = 0;
    for (var t = 0; t < todo.length; t++) {
        if (injectOne(todo[t].ui, todo[t].info)) n++;
    }
    if (n) logi('注入完成 ' + n + ' 个按钮');
}

function scheduleRefresh() {
    dirty = true;
    if (flushing) return;
    flushing = true;
    Ui.post(function () {
        try {
            if (!dirty) return;
            dirty = false;
            refresh();
        } catch (e) { loge('refresh: ' + e); }
        finally { flushing = false; }
    });
}

/** 触发按钮 */
function rememberHost(rootView) {
    try {
        if (!rootView || triggerHost) return;
        var h = rootView.findViewById(TRIGGER_HOST_ID);
        if (!h) return;
        triggerHost = h;
        triggerMounted = false;
        logi('已捕获 zeq 容器');
    } catch (e) {}
}

function ensureTrigger() {
    if (!triggerHost || triggerMounted) return;
    try {
        var hostUi = Ui.root(triggerHost);
        if (!hostUi) return;

        var exist = findBtn(hostUi, TAG_TRIGGER);
        if (exist) { triggerMounted = true; return; }

        var b = makeBtn(armed ? '关闭' : '注入', TAG_TRIGGER);
        try { Ui.insert(hostUi, b, 'child'); } catch (e) { loge('插 zeq 失败: ' + e); return; }

        Ui.onClick(b, function () {
            armed = !armed;
            lastSig = '';
            logi(armed ? '★ 开启注入' : '★ 关闭注入');
            toast(armed ? '已开启' : '已关闭');
            scheduleRefresh();
        });

        triggerMounted = true;
        logi('触发按钮已挂到 zeq');
    } catch (e) { loge('ensureTrigger: ' + e); }
}

/* ================= 注册 Hook ================= */
var hooked = 0;

// ⓪ 列表创建
try {
    Hook.method(PLAYLIST_CLS, 'LIZLLL', [], function (ctx) {
        try {
            var rv = null;
            try { rv = ctx.this.getSelectedListRv(); } catch (e) {}
            if (!rv) return;
            listRv = rv; targetRv = rv; lastSig = '';
            logi('★ 列表已创建，实例已记录');
        } catch (e) { loge('LIZLLL: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: LIZLLL');
} catch (e) { loge('Hook LIZLLL 失败: ' + e); }

// ① 数据更新
try {
    var lizjHook = Hook.method(PLAYLIST_CLS, 'LIZJ', ['java.util.List'], function (ctx) {
        try {
            var list = ctx.args[0];

            // probe 模式
            if (CFG.mode === 'probe') {
                if (probeOnce(list)) {
                    try { lizjHook.off(); } catch (e) {}
                    logi('probe 结束，Hook 已解除');
                }
                return;
            }

            // prod 模式
            collectAll(list);
            var rv = null;
            try { rv = ctx.this.getSelectedListRv(); } catch (e) {}
            if (rv) { listRv = rv; targetRv = rv; }
            scheduleRefresh();
        } catch (e) { loge('LIZJ: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: LIZJ  [mode=' + CFG.mode + ']');
} catch (e) { loge('Hook LIZJ 失败: ' + e); }

// ② 布局完成
try {
    Hook.method('androidx.recyclerview.widget.RecyclerView', 'onLayout',
        ['boolean', 'int', 'int', 'int', 'int'], function (ctx) {
            try {
                var v = ctx.this;
                var ok = false;
                if (listRv) { try { ok = (v === listRv || v.equals(listRv)); } catch (e) {} }
                if (!ok) { try { ok = v.getId() === RV_ID; } catch (e) {} }
                if (!ok) return;
                if (!listRv) listRv = v;
                targetRv = v;
                if (triggerHost) { Ui.post(ensureTrigger); }
                if (armed) scheduleRefresh();
            } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: onLayout');
} catch (e) { logw('Hook onLayout 跳过'); }

// ③ 滚动停止
try {
    Hook.method('androidx.recyclerview.widget.RecyclerView', 'onScrollStateChanged', ['int'],
        function (ctx) {
            try {
                var v = ctx.this;
                var ok = false;
                if (listRv) { try { ok = (v === listRv || v.equals(listRv)); } catch (e) {} }
                if (!ok) { try { ok = v.getId() === RV_ID; } catch (e) {} }
                if (!ok) return;
                if (ctx.args[0] === 0) {
                    lastSig = '';
                    if (armed) scheduleRefresh();
                }
            } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: onScrollStateChanged');
} catch (e) { logw('Hook onScroll 跳过'); }

// ④ zeq 容器
try {
    Hook.method('com.bytedance.android.live.ktv.common.karaokestation.view.firstleveltab.CommonOrderedFirstLevelTabFragment',
        'mM', ['android.view.View'], function (ctx) {
            try { rememberHost(ctx.args[0]); } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: mM（记录 zeq）');
} catch (e) { loge('Hook mM 失败: ' + e); }

// ⑤ Fragment 兜底
try {
    Hook.method('androidx.fragment.app.Fragment', 'onResume', [], function (ctx) {
        try {
            var cls = '';
            try { cls = String(ctx.this.getClass().getName()); } catch (e) { return; }
            if (cls.indexOf('karaokestation') < 0 && cls.indexOf('FirstLevelTab') < 0) return;
            var v = null;
            try { v = ctx.this.getView(); } catch (e) {}
            if (v) rememberHost(v);
        } catch (e) {}
    }, 'after');
    hooked++;
    logi('Hook OK: Fragment.onResume（zeq 兜底）');
} catch (e) { logw('Hook Fragment.onResume 跳过'); }

logi('=== 加载完成：' + hooked + ' 个 Hook ===');

/* ================= 手动诊断 ================= */
function show() {
    log('=== 已采集 ' + order.length + ' 首 ===');
    for (var i = 0; i < order.length; i++) {
        var s = songs[order[i]];
        log((i + 1) + '. ' + s.title + ' - ' + s.artist
            + '  id=' + s.musicId + '  ' + (s.url ? s.track : '无URL'));
        if (s.url) log('    ' + buildPath(s));
    }
}

function dumpFirst() {
    Ui.post(function () {
        try {
            var rv = listRv || targetRv;
            if (!rv) { logw('还没捕获 RecyclerView'); return; }
            log('rv childCount=' + rv.getChildCount());
            var items = visibleItems(rv);
            items.forEach(function (it) {
                log('  pos=' + it.pos + ' h=' + it.view.getHeight());
            });
        } catch (e) { loge('dumpFirst: ' + e); }
    });
}

function forceProbe() {
    probeDone = false;
    logw('已重置 probe 标记，下次 LIZJ 会重新诊断');
}

log('提示: show() 看采集 / dumpFirst() 看可见项 / forceProbe() 重新诊断');
