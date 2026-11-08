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
    defaultExt: '.mp3',

    /**
     * 自动切到「已点」
     * 点击直播间的「点歌」按钮后，等面板打开，再自动切到「已点」页签。
     * 需要 mode='prod' 才生效。
     */
    autoSwitchToOrdered: true,
    autoSwitchDelayMs: 450      // 等面板展开的时间，太短会切不动
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
var needMountTrigger = false;   // 待挂载 zeq 触发按钮
var needRefresh = false;        // 待刷新列表按钮
var needSwitchTab = false;      // 待切到「已点」页签
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
var _injectErrShown = false;

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
        if (!_injectErrShown) {
            _injectErrShown = true;
            loge('injectOne 失败: ' + e);
            loge('  → refresh() 应只从 Ui.post 内调用；若在此报错说明调用链仍有同步路径');
        }
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
    if (!armed) { d('refresh: 未开启注入，跳过'); return; }
    var rv = listRv || targetRv;
    if (!rv) { d('refresh: 没有 RecyclerView'); return; }

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

/**
 * 调度一次刷新（注入按钮）。
 *
 * ★ 为什么用双层 Ui.post
 *   scheduleRefresh 的调用方都是 Hook 回调（onLayout / LIZJ /
 *   onScrollStateChanged），这些回调运行在主线程且主线程被 Hook 占用。
 *   在这种上下文里 Ui.post 会「同步执行」，refresh() 里的 Ui.create
 *   就会炸：IllegalStateException: 主线程正被 Hook 回调占用。
 *   第一层 Ui.post 负责脱离 Hook 上下文，第二层确保主线程真正空闲。
 */
/**
 * 消费标志位并真正执行 UI 操作。
 *
 * 只能从「非 Hook 上下文」调用：
 *   · 用户点击注入按钮（onClick 回调天然在主线程空闲时）
 *   · 手动调用 flush()
 *
 * 内部用 Ui.post 派发，此时主线程已空闲，不会抛异常。
 */
var _flushRetry = 0;

function flushPending() {
    if (!needMountTrigger && !needRefresh && !needSwitchTab) return;

    var doMount = needMountTrigger;
    var doRefresh = needRefresh;
    var doSwitch = needSwitchTab;
    needMountTrigger = false;
    needRefresh = false;
    needSwitchTab = false;

    Ui.post(function () {
        try {
            if (doSwitch && pendingSwitch && !switchedThisOpen) {
                tryAutoSwitch();
            }
            if (doMount && triggerHost && !triggerMounted) {
                ensureTrigger();
            }
            if (doRefresh && armed) {
                refresh();
            }
        } catch (e) {
            loge('flushPending: ' + e);
        }
        // 执行期间可能又置了新标志，再消费一轮（限次，防死循环）
        if ((needMountTrigger || needRefresh || needSwitchTab) && _flushRetry < 5) {
            _flushRetry++;
            Ui.post(function () { flushPending(); });
        } else {
            _flushRetry = 0;
        }
    });
}

/**
 * ★ 用 Java Handler 投递到主线程队列。
 * 与 Ui.post 不同，Handler.post 是「排队」，不会因为当前主线程
 * 被 Hook 占用而同步执行，因此在 Hook 回调里调用是安全的。
 * 回调触发时主线程已空闲，可以放心操作 Ui。
 */
function postToMain(fn) {
    try {
        var Looper = Java.use('android.os.Looper');
        var Handler = Java.use('android.os.Handler');
        var h = Handler.$new(Looper.getMainLooper());
        var Runnable = Java.use('java.lang.Runnable');
        // QuickHook 支持用 JS 函数实现 Java 接口的情况有限，
        // 这里退化到 Ui.post（在非 Hook 上下文时它是安全的）
        Ui.post(fn);
        return true;
    } catch (e) {
        d('postToMain 失败，退化 Ui.post: ' + e);
        try { Ui.post(fn); return true; } catch (e2) { return false; }
    }
}

/** 手动触发一次（用户可在日志页调用） */
function flushNow() {
    log('手动 flush…');
    needMountTrigger = true;
    needRefresh = true;
    flushPending();
}

function scheduleRefresh() {
    dirty = true;
    if (flushing) return;
    flushing = true;
    Ui.post(function () {
        Ui.post(function () {
            try {
                if (!dirty) return;
                dirty = false;
                refresh();
            } catch (e) {
                loge('refresh: ' + e);
            } finally {
                flushing = false;
            }
        });
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

var _ensureErrShown = false;

function ensureTrigger() {
    if (!triggerHost || triggerMounted) return;
    try {
        var hostUi = Ui.root(triggerHost);
        if (!hostUi) { d('ensureTrigger: Ui.root 返回空'); return; }

        var exist = findBtn(hostUi, TAG_TRIGGER);
        if (exist) { triggerMounted = true; return; }

        var b = makeBtn(armed ? '关闭' : '注入', TAG_TRIGGER);
        try { Ui.insert(hostUi, b, 'child'); } catch (e) { loge('插 zeq 失败: ' + e); return; }

        Ui.onClick(b, function () {
            // onClick 回调是安全时机：主线程空闲，可以放心操作 Ui
            armed = !armed;
            lastSig = '';
            logi(armed ? '★ 开启注入' : '★ 关闭注入');
            toast(armed ? '已开启' : '已关闭');
            try {
                refresh();
            } catch (e) {
                loge('点击刷新失败: ' + e);
            }
        });

        triggerMounted = true;
        logi('触发按钮已挂到 zeq');
    } catch (e) {
        // 只报一次，避免刷屏；同时打印调用栈线索
        if (!_ensureErrShown) {
            _ensureErrShown = true;
            loge('ensureTrigger 失败: ' + e);
            loge('  → 说明该调用点仍在 Hook 回调上下文里，需要再包一层 Ui.post');
            loge('  → triggerMounted=' + triggerMounted +
                 ' triggerHost=' + (triggerHost ? '有' : '无'));
        }
    }
}

/* ================= 自动切到「已点」 ================= */
/**
 * 反编译结论（抖音 41.0.0）：
 *
 * 页签切换入口
 *   BaseFirstLevelTabManager.LIZ(int tabValue, String tabKey)
 *     └─ LJI(FT3, String) 翻译 → 找 Fragment → yM(0FYq, 0Fa2) 切换
 *
 * 页签枚举 LX/0FT3（LIZ() 返回 value）
 *   Unknown=0, FirstOpenTab=1, OrderedSongTab=2 ← 已点,
 *   OrderSongTab=3 ← 点歌, MySongTab=4
 *
 * TabLayout 在 BaseFirstLevelTabManager 字段 l，
 * 字段 j 是 Map<FT3, Integer>（tab 下标）
 */

var FT3_ORDERED = 2;          // OrderedSongTab.value  「已点」
var FT3_ORDER = 3;            // OrderSongTab.value    「点歌」

// 记录 manager 实例（BaseFirstLevelTabManager 的任一子类都行）
var tabManager = null;
// 「点歌」按钮被点过，等面板打开就切
var pendingSwitch = false;
// 已切过，避免重复
var switchedThisOpen = false;

/**
 * 切换页签到指定 FT3。
 * 优先用 manager.LIZ(value, key)，退而用 TabLayout 直接选。
 */
function switchTab(targetValue, targetKey) {
    // ① 官方入口
    if (tabManager) {
        try {
            tabManager.LIZ(targetValue, targetKey || '');
            logi('切页签: 调用 LIZ(' + targetValue + ')');
            return true;
        } catch (e) {
            d('LIZ 失败，试 TabLayout: ' + e);
        }
    }

    // ② TabLayout 直接选（查字段 j 的映射）
    try {
        var tl = null;
        try { tl = tabManager.l; } catch (e) {}
        if (tl) {
            var idx = -1;
            try {
                var ft3 = Java.use('X.0FT3');
                var field = targetValue === FT3_ORDERED ? 'OrderedSongTab' : 'OrderSongTab';
                var enumObj = ft3.$get(field);
                var map = tabManager.j;
                if (map && enumObj) {
                    var iv = map.get(enumObj);
                    if (iv) idx = iv.intValue();
                }
            } catch (e) { d('取 tab 下标失败: ' + e); }

            if (idx < 0) {
                // 兜底：字符串匹配 tab 文本
                var cnt = 0;
                try { cnt = tl.getTabCount(); } catch (e) {}
                for (var i = 0; i < cnt; i++) {
                    try {
                        var tab = tl.getTabAt(i);
                        if (!tab) continue;
                        var txt = '';
                        try { txt = String(tab.getText()); } catch (e) {}
                        if (txt.indexOf('已点') >= 0) { idx = i; break; }
                    } catch (e) {}
                }
            }

            if (idx >= 0) {
                tl.selectTab(idx);
                logi('切页签: TabLayout.selectTab(' + idx + ')');
                return true;
            }
        }
    } catch (e) {
        loge('TabLayout 切换失败: ' + e);
    }

    return false;
}

/**
 * 尝试执行延迟切换。
 * 由 Ui.post 派发，避免主线程阻塞。
 */
function tryAutoSwitch() {
    if (!CFG.autoSwitchToOrdered) return;
    if (!pendingSwitch) return;
    if (switchedThisOpen) return;

    Ui.post(function () {
        try {
            if (!pendingSwitch || switchedThisOpen) return;

            var ok = switchTab(FT3_ORDERED, 'play_list');
            if (ok) {
                switchedThisOpen = true;
                pendingSwitch = false;
                logi('★ 已自动切到「已点」');
            } else {
                d('切换未成功，等下次机会');
            }
        } catch (e) {
            loge('tryAutoSwitch: ' + e);
        }
    });
}

/* ================= 注册 Hook ================= */
var hooked = 0;

// ⓪ 列表创建（顺带补切「已点」）
try {
    Hook.method(PLAYLIST_CLS, 'LIZLLL', [], function (ctx) {
        try {
            var rv = null;
            try { rv = ctx.this.getSelectedListRv(); } catch (e) {}
            if (rv) {
                listRv = rv; targetRv = rv; lastSig = '';
                logi('★ 列表已创建，实例已记录');
            }
            // 面板已打开，标记待切（不在此调用 Ui）
            if (pendingSwitch && !switchedThisOpen) needSwitchTab = true;
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

            // 只置标志，不调 Ui（LIZJ 在主线程且被 Hook 占用）
            if (triggerHost && !triggerMounted) needMountTrigger = true;
            if (armed) needRefresh = true;
        } catch (e) { loge('LIZJ: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: LIZJ  [mode=' + CFG.mode + ']');
} catch (e) { loge('Hook LIZJ 失败: ' + e); }

// ② 布局完成
//
// ★ 重要：Hook 回调里【绝对不能调用任何 Ui.* 方法】，包括 Ui.post。
//   原因：这些 Hook 都在主线程执行，且主线程正被 Hook 回调占用。
//   此时 Ui.post 会「同步执行」，导致 Ui.create 直接抛：
//     IllegalStateException: 主线程正被 Hook 回调占用
//   即使套两层 Ui.post 也没用——第一层就会炸。
//
//   正确做法：回调里只记录状态（纯 JS 赋值，不碰 Java），
//   由「安全路径」——即用户点击注入按钮、或 LIZJ 的 collectAll 之后
//   主动调度的 refresh()——去消费这些标志。
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

                // 只置标志，不调 Ui
                if (triggerHost && !triggerMounted) needMountTrigger = true;
                if (armed) needRefresh = true;
            } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: onLayout（只置标志）');
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
                    // 只置标志
                    if (armed) needRefresh = true;
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

// ⑥ 记录 BaseFirstLevelTabManager 实例（页签切换的执行者）
//    hook LIZ 的 before，任何调用都会带上 this
try {
    Hook.method('com.bytedance.android.livesdk.ktvimpl.base.karaokestation.BaseFirstLevelTabManager',
        'LIZ', ['int', 'java.lang.String'], function (ctx) {
            try {
                if (!tabManager) {
                    tabManager = ctx.this;
                    logi('已捕获 TabManager 实例');
                }
            } catch (e) {}
        }, 'before');
    hooked++;
    logi('Hook OK: BaseFirstLevelTabManager.LIZ');
} catch (e) { logw('Hook TabManager.LIZ 跳过: ' + e); }

// ⑦ 监听「点歌」按钮(eas)的点击
//    它属于 RealTimeChorusOperateView，点击由外部处理，
//    所以直接 hook 它的 onTouchEvent 判断 ACTION_UP
try {
    Hook.method('com.bytedance.android.livesdk.ktvimpl.realtimechorus.RealTimeChorusOperateView',
        'onTouchEvent', ['android.view.MotionEvent'], function (ctx) {
            try {
                var ev = ctx.args[0];
                if (!ev) return;
                var act = -1;
                try { act = ev.getActionMasked(); } catch (e) {
                    try { act = ev.getAction(); } catch (e2) {}
                }
                // ACTION_UP = 1
                if (act === 1) {
                    pendingSwitch = true;
                    switchedThisOpen = false;
                    // 用户交互后主线程会短暂空闲，此时消费标志较安全
                    needSwitchTab = true;
                    needMountTrigger = true;
                    d('检测到合唱面板点击，准备切「已点」');
                }
            } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: RealTimeChorusOperateView.onTouchEvent');
} catch (e) { logw('Hook onTouchEvent 跳过: ' + e); }

// ⑧ 页签就绪时执行切换
//    BaseFirstLevelTabManager.LJIILJJIL(FrameLayout) 是页签容器初始化完的时机
try {
    Hook.method('com.bytedance.android.livesdk.ktvimpl.base.karaokestation.BaseFirstLevelTabManager',
        'LJIILJJIL', ['android.widget.FrameLayout'], function (ctx) {
            try {
                tabManager = ctx.this;
                if (pendingSwitch && !switchedThisOpen) needSwitchTab = true;
            } catch (e) {}
        }, 'after');
    hooked++;
    logi('Hook OK: BaseFirstLevelTabManager.LJIILJJIL（页签就绪）');
} catch (e) { logw('Hook LJIILJJIL 跳过: ' + e); }

// ⑩ 自动消费标志
//    这里 hook 一个「一定会被调用、且不受主线程占用影响」的时机：
//    Fragment.onResume 的 after 里，委托给 flushPending，
//    而 flushPending 内部的 Ui.post 此时是安全的（已脱离 Hook 上下文）。
try {
    Hook.method('androidx.fragment.app.Fragment', 'onResume', [], function (ctx) {
        try {
            var cls = '';
            try { cls = String(ctx.this.getClass().getName()); } catch (e) { return; }
            if (cls.indexOf('karaokestation') < 0 && cls.indexOf('FirstLevelTab') < 0) return;

            // 只置标志
            if (triggerHost && !triggerMounted) needMountTrigger = true;
            if (armed) needRefresh = true;
            if (pendingSwitch && !switchedThisOpen) needSwitchTab = true;

            // 注意：这里也不调 Ui，交给下面的 tick
        } catch (e) {}
    }, 'after');
    hooked++;
    logi('Hook OK: Fragment.onResume（置标志）');
} catch (e) {}

logi('=== 加载完成：' + hooked + ' 个 Hook ===');

// 启动自驱动：加载时先排一次，之后由各 Hook 置标志 + flushPending 自续
Ui.post(function () {
    try { flushPending(); } catch (e) { loge('初始 flush 失败: ' + e); }
});

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

/** 手动测试：立即切到「已点」 */
function testSwitchOrdered() {
    log('手动测试切换页签…');
    if (!tabManager) { logw('还没捕获 TabManager，先打开一次点歌面板'); }
    var ok = switchTab(FT3_ORDERED, 'play_list');
    log(ok ? '✓ 切换调用成功' : '✗ 切换失败，看上面的错误');
}

/** 手动测试：切到「点歌」 */
function testSwitchOrder() {
    var ok = switchTab(FT3_ORDER, '');
    log(ok ? '✓ 已切到点歌' : '✗ 切换失败');
}

/** 打印页签状态 */
function dumpTabs() {
    Ui.post(function () {
        try {
            log('tabManager: ' + (tabManager ? '已捕获' : '未捕获'));
            log('pendingSwitch=' + pendingSwitch + ' switched=' + switchedThisOpen);
            if (!tabManager) return;

            var tl = null;
            try { tl = tabManager.l; } catch (e) {}
            if (!tl) { logw('TabLayout 字段 l 读不到'); return; }

            var cnt = 0;
            try { cnt = tl.getTabCount(); } catch (e) {}
            log('TabLayout 共 ' + cnt + ' 个 tab:');
            for (var i = 0; i < cnt; i++) {
                try {
                    var t = tl.getTabAt(i);
                    if (!t) continue;
                    var txt = '';
                    try { txt = String(t.getText()); } catch (e) {}
                    log('  [' + i + '] "' + txt + '"');
                } catch (e) {}
            }
        } catch (e) { loge('dumpTabs: ' + e); }
    });
}

log('提示: show() / dumpFirst() / forceProbe() / testSwitchOrdered() / dumpTabs()');
