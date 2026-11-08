/**
 * h.js —— KTV 音轨 URL 探针（X.0FTP 六槽位）
 * ════════════════════════════════════════════════════════════════
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)
 * 环境：QuickHook (QuickJS)
 *
 * 作用：hook 以下 LX 类，把每次取到的 (音轨, URL, 保存路径) 打成 list
 *
 *   X.0FT6.LIZJ(MusicPanel)              ← 6 槽位总调度，列表渲染/下载时必走
 *   X.0FTP.LIZ(int, X.0FTH, MusicPanel)  ← 单个槽位真正开始下载
 *   X.0FTK.LIZLLL(KtvMusic)              ← 伴奏  = TC().MC()
 *   X.0FTL.LIZLLL(KtvMusic)              ← 全轨  = WC().MC()
 *   X.0FTM.LIZLLL(KtvMusic)              ← 人声  = sD()
 *   X.0FTN.LIZLLL(KtvMusic)              ← MIDI  = iD()
 *   X.0FTh.LIZLLL(KtvMusic)              ← 歌词  = aD()[0]
 *   X.0FTW.LIZLLL(KtvMusic)              ← MV    = ""（预留槽位）
 *
 * ────────────────────────────────────────────────────────────────
 * 结构（dex classes57/54 逐条核对）
 *
 *   X.0FT6  (MusicPanelDownloader)
 *     LIZ/X.0FTP  LIZIZ/X.0FTP  LIZJ/X.0FTP
 *     LIZLLL/X.0FTP  LJ/X.0FTP  LJFF/X.0FTP     ← 6 个槽位
 *     LJI  CopyOnWriteArrayList<MusicDownloadCallback>
 *
 *   X.0FTP  (单槽位)
 *     LIZ    X.0FUj          ← 取值策略（就是 6 个子类之一）
 *     LIZIZ  Z               ← isDownloading
 *     LIZJ   MusicPanel      ← 当前下载的面板
 *     LIZLLL DownloadTask
 *     LIZ(I, X.0FTH, MusicPanel)V
 *        v6 = LIZ.LIZLLL(music)          ← 唯一取 URL 的地方
 *        v2 = LIZIZ(music)               ← 目录
 *        DownloadTask.url(v6).name(LJ(v6)).savePath(LJII(v6))
 *
 *   X.0FUj  (取值策略抽象基类，4 个抽象方法)
 *     LIZ(music)    文件名
 *     LIZIZ(music)  目录
 *     LIZJ()        音轨名
 *     LIZLLL(music) URL   ★ 真正拿下载链接的方法
 *
 *   X.0FTO  (路径拼装)
 *     LIZLLL(id) → <X.0FKH.LIZ()>/musicPack/<id>
 *     LJ(url)    → url.substring(url.lastIndexOf("/"))   文件名
 *     LJII(url)  → url.substring(0, url.lastIndexOf("/")) 目录
 *
 *   X.0FKH.LIZ() → 根目录（getExternalFilesDir）
 *
 *   KtvMusic 字段（X.0FKH 同级，classes54）
 *     p → 伴奏 AudioInfo   TC()
 *     o → 全轨 AudioInfo   WC()
 *     r → String          sD()
 *     q → String          iD()
 *     i → List            aD()
 *     b → String          YC()   歌手
 *     d → String          getTitle()
 *     a → long            XC()   musicId
 *     LX/09qV: MC()=meta_url  KC()=meta_file_hash  LC()=meta_audio_id
 * ════════════════════════════════════════════════════════════════
 *
 * ★ 铁律：Hook 回调里不调任何 Ui.*（含 Ui.post），只写日志。
 */

var BUILD = 'h1';

var CFG = {
    debug: true,

    /** 打印 URL 时截断长度 */
    urlMax: 150,

    /** 同一个 musicId 只打一次表（避免列表滚动刷屏） */
    oncePerMusic: true,

    /** 校验目录：调用官方 LIZIZ(music)。
     *  ⚠ 会有副作用（mkdirs 建空目录），默认关闭 */
    verifyWithApp: false
};

function L(s) { try { log(String(s)); } catch (e) {} }
function d(s) { if (CFG.debug !== false) L(s); }
function W(s) { try { logw(String(s)); } catch (e) { L('[W] ' + s); } }
function E(s) { try { loge(String(s)); } catch (e) { L('[E] ' + s); } }

L('╔═════════════════════════════════════════════╗');
L('║ h.js  ' + BUILD + '   X.0FTP 六槽位音轨探针');
L('╚═════════════════════════════════════════════╝');

/* ================================================================
 * 0. 常量
 * ================================================================ */
var KTVMUSIC = 'com.bytedance.android.livesdk.message.model.KtvMusic';
var PANEL = 'com.bytedance.android.livesdk.message.model.MusicPanel';

/**
 * 6 个槽位。
 * cls    = Java.use 用的类名
 * slug   = 反编译里的真实混淆名（打日志用）
 * track  = 官方 LIZIZ() 拼进路径的目录名
 * via    = 取值表达式（对照用）
 * field  = KtvMusic 里的字段
 */
var SLOTS = [
    { cls: 'X.0FTK', slug: 'LX/0FTK', label: '伴奏', track: 'accompaniment', via: 'TC().MC()', field: 'p', ap: 'TC' },
    { cls: 'X.0FTL', slug: 'LX/0FTL', label: '全轨', track: 'fullTrack', via: 'WC().MC()', field: 'o', ap: 'WC' },
    { cls: 'X.0FTM', slug: 'LX/0FTM', label: '人声', track: 'vocal', via: 'sD()', field: 'r', ap: 'sD' },
    { cls: 'X.0FTN', slug: 'LX/0FTN', label: 'MIDI', track: 'midi', via: 'iD()', field: 'q', ap: 'iD' },
    { cls: 'X.0FTh', slug: 'LX/0FTh', label: '歌词', track: 'lyric', via: 'aD()[0]', field: 'i', ap: 'aD' },
    { cls: 'X.0FTW', slug: 'LX/0FTW', label: 'MV', track: 'video', via: '""（预留）', field: '-', ap: '' }
];

/* ================================================================
 * 1. 反射工具（Hook 里也要用，所以只用 Java API，不碰 Ui）
 * ================================================================ */

function str(v) {
    if (v === null || v === undefined) return '';
    try {
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v.$str === 'function') return String(v.$str());
        return String(v);
    } catch (e) { return ''; }
}

/** 把 QuickHook 降级代理 {@,h,c,s} 还原成可操作句柄 */
function resolveHandle(x) {
    if (!x) return null;
    try { if (typeof x.$get === 'function' || typeof x.$call === 'function') return x; } catch (e) {}
    var h = null;
    try { h = x.h; } catch (e) {}
    if (typeof Java.ref === 'function') {
        try { var a = Java.ref(x); if (a && a !== x) return a; } catch (e) {}
        if (h !== undefined && h !== null) {
            try { var b = Java.ref(h); if (b && b !== h) return b; } catch (e) {}
        }
    }
    return x;
}

/** 调方法：直调 → $call → 反射（沿父类链 + 按参数个数匹配） */
function call(obj, name, args) {
    if (!obj) return null;
    obj = resolveHandle(obj);
    args = args || [];

    try {
        var fn = obj[name];
        if (typeof fn === 'function') {
            var r = fn.apply(obj, args);
            if (r !== undefined && r !== null) return r;
        }
    } catch (e) {}

    try {
        if (typeof obj.$call === 'function') {
            var r2 = obj.$call(name, args);
            if (r2 !== undefined && r2 !== null) return r2;
        }
    } catch (e) {}

    try {
        var c = obj.getClass();
        var guard = 0;
        while (c && guard++ < 12) {
            var ms = null;
            try { ms = c.getDeclaredMethods(); } catch (e) {}
            if (ms) {
                for (var i = 0; i < ms.length; i++) {
                    var m = ms[i];
                    var mn = '';
                    try { mn = String(m.getName()); } catch (e) { continue; }
                    if (mn !== String(name)) continue;
                    try {
                        if (m.getParameterTypes().length !== args.length) continue;
                        m.setAccessible(true);
                        try { return m.invoke(obj, jarr(args)); } catch (e) {}
                        try { return m.invoke(obj); } catch (e) {}
                    } catch (e) {}
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) {}
    return null;
}

function jarr(args) {
    try { if (typeof Java.array === 'function') return Java.array('java.lang.Object', args); } catch (e) {}
    return args;
}

/** 读字段（反射，沿父类链） */
function getF(obj, name) {
    if (!obj) return null;
    obj = resolveHandle(obj);

    try {
        if (typeof obj.$get === 'function') {
            var v = obj.$get(name);
            if (v !== undefined && v !== null) return v;
        }
    } catch (e) {}

    try {
        var c = obj.getClass();
        var guard = 0;
        while (c && guard++ < 12) {
            try {
                var f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(obj);
            } catch (e) {}
            c = c.getSuperclass();
        }
    } catch (e) {}
    return null;
}

/** java.util.List */
function listSize(l) {
    if (!l) return 0;
    l = resolveHandle(l);
    try { var n = l.size(); if (typeof n === 'number') return n; } catch (e) {}
    try { if (typeof l.length === 'number') return l.length; } catch (e) {}
    var n2 = call(l, 'size');
    return typeof n2 === 'number' ? n2 : 0;
}

function listAt(l, i) {
    if (!l) return null;
    l = resolveHandle(l);
    try { var v = l.get(i); if (v !== undefined && v !== null) return v; } catch (e) {}
    try { if (l[i] !== undefined) return l[i]; } catch (e) {}
    return null;
}

/** 19 位 long 的 id 有精度问题，优先从 toString 文本里抠 */
function exactId(music, panel) {
    var t = str(music);
    var m = t.match(/id\s*=\s*(\d{6,})/i);
    if (m) return m[1];
    var m2 = t.match(/\b(\d{15,})\b/);
    if (m2) return m2[1];

    var pt = str(panel);
    var m3 = pt.match(/id\s*=\s*(\d{6,})/i);
    if (m3) return m3[1];

    var raw = call(music, 'XC');
    if (raw === null) raw = call(music, 'getId');
    var s = str(raw);
    if (s && s.indexOf('e') < 0 && s.indexOf('E') < 0) return s.replace(/\.0$/, '');
    return s;
}

function titleOf(music) {
    var t = call(music, 'getTitle');
    if (!t) t = call(music, 'fD');
    if (!t) t = getF(music, 'd');
    return str(t);
}

function artistOf(music) {
    var a = getF(music, 'b');
    if (!a) a = call(music, 'YC');
    var s = str(a).trim();
    if (/^\d+(\.\d+)?[eE]?\+?\d*$/.test(s)) return '';
    return s;
}

/* ================================================================
 * 2. 根目录
 * ================================================================ */
var _root = null;

function rootDir() {
    if (_root) return _root;
    try {
        var K = Java.use('X.0FKH');
        var r = K.LIZ();
        if (r) { _root = String(r); d('根目录: ' + _root); }
    } catch (e) {
        d('取根目录失败: ' + e);
    }
    return _root || '';
}

/** 拼保存路径：<root>/musicPack/<id>/<track>/<file> */
function buildPath(id, track, file) {
    var r = rootDir();
    if (!r) return '';
    return r + '/musicPack/' + id + '/' + track + '/' + (file || '');
}

/** URL 的最后一段（官方 X.0FTO.LJ 的逻辑） */
function fileNameOf(url) {
    var u = String(url || '').split('?')[0].split('#')[0];
    var i = u.lastIndexOf('/');
    if (i < 0) return u;
    var s = u.substring(i + 1);
    if (!/\.\w{2,5}$/.test(s)) {
        var m = u.match(/\.(mp3|m4a|aac|wav|flac|ogg|mp4|m4s|mid|midi)$/i);
        if (m) s += m[0];
    }
    return s;
}

/* ================================================================
 * 3. 取一个槽位的 URL / 文件名 / 目录
 *    纯读，无副作用（不调 LIZIZ，因为它会 mkdirs）
 * ================================================================ */

/** 从 KtvMusic 取某槽位的 URL */
function slotUrl(slot, music) {
    if (!slot || !music) return '';

    if (slot.ap === 'TC' || slot.ap === 'WC') {
        var ai = call(music, slot.ap);
        if (!ai) ai = getF(music, slot.field);
        if (!ai) return '';
        var u = call(ai, 'MC');
        if (!u) u = getF(ai, 'meta_url');
        return str(u);
    }

    if (slot.ap === 'sD' || slot.ap === 'iD') {
        var s = call(music, slot.ap);
        if (!s) s = getF(music, slot.field);
        return str(s);
    }

    if (slot.ap === 'aD') {
        var lst = call(music, 'aD');
        if (!lst) lst = getF(music, slot.field);
        var n = listSize(lst);
        if (n <= 0) return '';
        return str(listAt(lst, 0));
    }

    return '';   // LX/0FTW 恒为 ""
}

/** 从 KtvMusic 取某槽位的文件名（TC/WC 用 KC() = meta_file_hash） */
function slotFile(slot, music, url) {
    if (slot.ap === 'TC' || slot.ap === 'WC') {
        var ai = call(music, slot.ap);
        if (!ai) ai = getF(music, slot.field);
        if (ai) {
            var k = call(ai, 'KC');
            if (!k) k = getF(ai, 'meta_file_hash');
            var ks = str(k);
            if (ks) {
                // KC 无扩展名，官方也是直接用 hash 当名字
                return ks;
            }
        }
    }
    return fileNameOf(url);
}

/** 音频补充信息（audioId / hash） */
function audioMeta(slot, music) {
    if (slot.ap !== 'TC' && slot.ap !== 'WC') return '';
    var ai = call(music, slot.ap);
    if (!ai) ai = getF(music, slot.field);
    if (!ai) return '';
    var id = str(call(ai, 'LC'));
    var hash = str(call(ai, 'KC'));
    var out = [];
    if (id) out.push('audioId=' + id);
    if (hash) out.push('hash=' + hash);
    return out.join(' ');
}

/** 探测一首歌的 6 个槽位 */
function probeMusic(music, panel) {
    var id = exactId(music, panel);
    var rows = [];
    for (var i = 0; i < SLOTS.length; i++) {
        var s = SLOTS[i];
        var url = '';
        var err = '';
        try { url = slotUrl(s, music); } catch (e) { err = String(e); }

        var file = '';
        try { file = slotFile(s, music, url); } catch (e) {}

        var dir = '';
        if (id) dir = buildPath(id, s.track, file);
        if (CFG.verifyWithApp) {
            var appDir = appDirOf(s, music);
            if (appDir) dir = appDir;
        }

        rows.push({
            label: s.label,
            slug: s.slug,
            via: s.via,
            track: s.track,
            url: url,
            file: file,
            dir: dir,
            meta: audioMeta(s, music),
            err: err
        });
    }
    return { id: id, title: titleOf(music), artist: artistOf(music), rows: rows };
}

/** 调官方 LIZIZ(music) 拿目录（会 mkdirs，默认不启用） */
var _inst = {};

function slotInstance(slot) {
    if (_inst[slot.slug] !== undefined) return _inst[slot.slug];
    var o = null;
    try {
        var C = Java.use(slot.cls);
        o = C.$new();
        d('实例化 ' + slot.slug + ' 成功');
    } catch (e) {
        d('实例化 ' + slot.slug + ' 失败: ' + e);
    }
    _inst[slot.slug] = o;
    return o;
}

function appDirOf(slot, music) {
    var o = slotInstance(slot);
    if (!o || !music) return '';
    try { return str(call(o, 'LIZIZ', [music])); } catch (e) { return ''; }
}

/* ================================================================
 * 4. 打印
 * ================================================================ */

var _printed = {};      // musicId -> true
var ALL = [];           // 所有探测结果，供 printAll() 用

function pad(s, n) {
    s = String(s || '');
    while (s.length < n) s += ' ';
    return s;
}

function cut(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
}

function printTable(res, source) {
    L('');
    L('══════════ 点播音轨列表 [' + (res.title || '(无名)') + ']'
        + (res.artist ? ' · ' + res.artist : '')
        + '  id=' + (res.id || '?')
        + (source ? '  via ' + source : '') + ' ══════════');
    L(pad('#', 2) + ' ' + pad('槽位', 11) + pad('音轨', 10) + pad('取值', 14) + 'URL / 保存路径');
    L('───────────────────────────────────────────────────────────────');

    var hit = 0;
    for (var i = 0; i < res.rows.length; i++) {
        var r = res.rows[i];
        var mark = r.url ? '✔' : '·';
        if (r.url) hit++;
        L(' ' + (i + 1) + '  ' + pad(r.slug, 11) + pad(r.track, 10) + pad(r.via, 14)
            + mark + ' ' + (r.url ? cut(r.url, CFG.urlMax) : '(空)')
            + (r.meta ? '   [' + r.meta + ']' : '')
            + (r.err ? '   ERR ' + r.err : ''));
        if (r.file) L('      file: ' + r.file);
        if (r.dir) L('      path: ' + r.dir);
    }
    L('───────────────────────────────────────────────────────────────');
    L('  有 URL: ' + hit + ' / ' + res.rows.length);
    L('');
}

/** 记录 + 打印（同 id 去重） */
function report(music, panel, source) {
    if (!music) { W('report: music 为空'); return; }

    // 记住最后一首，供 hProbe() 手动重跑
    _lastMusic = music;
    _lastPanel = panel;

    var res = null;
    var prev = inProbe;
    inProbe = true;          // 自己反射时不希望再被 hook 记录
    try { res = probeMusic(music, panel); } catch (e) { E('probeMusic 失败: ' + e); res = null; }
    inProbe = prev;
    if (!res) return;

    var key = res.id || ('noId:' + res.title);
    if (CFG.oncePerMusic && _printed[key]) {
        d('已打印过 id=' + key + '，跳过');
        return;
    }
    _printed[key] = true;
    ALL.push(res);

    try { printTable(res, source); } catch (e) { E('printTable 失败: ' + e); }
}

/** 手动打印全部已采集 */
function printAll() {
    L('');
    L('★ 共采集 ' + ALL.length + ' 首');
    for (var i = 0; i < ALL.length; i++) {
        var r = ALL[i];
        var hit = 0;
        for (var j = 0; j < r.rows.length; j++) if (r.rows[j].url) hit++;
        L('[' + (i + 1) + '] ' + (r.title || '?')
            + (r.artist ? ' · ' + r.artist : '')
            + '  id=' + (r.id || '?')
            + '  ' + hit + '/6 有URL');
        for (var k = 0; k < r.rows.length; k++) {
            if (!r.rows[k].url) continue;
            L('     ' + r.rows[k].slug + ' ' + r.rows[k].track + '  ' + cut(r.rows[k].url, 110));
        }
    }
    L('');
}

/* ================================================================
 * 5. Hook
 * ================================================================ */

var hooked = 0;
var inProbe = false;   // 防止自己 probe 时的调用又被 hook 记录

/** 兼容：先精确匹配签名，失败退到 Hook.all */
function hookMethod(cls, name, types, cb, timing) {
    try {
        Hook.method(cls, name, types, cb, timing || 'after');
        return true;
    } catch (e) {
        d('Hook.method ' + cls + '.' + name + ' 失败: ' + e);
    }
    try {
        Hook.all(cls, name, cb, timing || 'after');
        d('用 Hook.all 兜底: ' + cls + '.' + name);
        return true;
    } catch (e2) {
        E('Hook ' + cls + '.' + name + ' 失败: ' + e2);
        return false;
    }
}

function musicOf(panel) {
    if (!panel) return null;
    var m = getF(panel, 'LIZ');
    if (m) return m;
    var m2 = call(panel, 'LIZ');
    if (m2) return m2;
    return null;
}

/* ── ① 6 槽位总调度：X.0FT6.LIZJ(MusicPanel) ──
 * 列表渲染 / 下载判断都会走，是最好的「无点击也出表」入口 */
try {
    if (hookMethod('X.0FT6', 'LIZJ', [PANEL], function (ctx) {
        try {
            if (inProbe) return;
            var panel = ctx.args[0];
            var music = musicOf(panel);
            if (!music) { d('X.0FT6.LIZJ: 拿不到 KtvMusic'); return; }
            report(music, panel, 'X.0FT6.LIZJ');
        } catch (e) { E('LIZJ 回调: ' + e); }
    }, 'after')) { hooked++; L('Hook OK: X.0FT6.LIZJ(MusicPanel)'); }
} catch (e) { E('Hook X.0FT6.LIZJ: ' + e); }

/* ── ② 单槽位下载入口：X.0FTP.LIZ(int, X.0FTH, MusicPanel) ── */
try {
    if (hookMethod('X.0FTP', 'LIZ', ['int', 'X.0FTH', PANEL], function (ctx) {
        try {
            if (inProbe) return;
            var panel = ctx.args[2];
            var music = musicOf(panel);
            var slotCls = '';
            try {
                var strat = getF(ctx.this, 'LIZ');   // X.0FTP.LIZ : X.0FUj
                if (strat) slotCls = String(strat.getClass().getName());
                else slotCls = String(ctx.this.LIZ.getClass().getName());
            } catch (e) {}

            L('▸ X.0FTP.LIZ 触发  槽位=' + slotCls
                + '  type=' + str(ctx.args[0]));

            if (!music) return;
            // 单槽位详情
            var s = null;
            for (var i = 0; i < SLOTS.length; i++) {
                if (slotCls.indexOf(SLOTS[i].slug.replace('/', '.')) >= 0) { s = SLOTS[i]; break; }
            }
            if (s) {
                var u = '', f = '', dir = '';
                try {
                    u = slotUrl(s, music);
                    f = slotFile(s, music, u);
                    dir = buildPath(exactId(music, panel), s.track, f);
                } catch (e) {}
                L('   ' + s.slug + '  ' + s.label
                    + '  URL=' + (u ? cut(u, CFG.urlMax) : '(空)'));
                if (dir) L('   path=' + dir);
            }
            report(music, panel, 'X.0FTP.LIZ');
        } catch (e) { E('X.0FTP.LIZ 回调: ' + e); }
    }, 'before')) { hooked++; L('Hook OK: X.0FTP.LIZ(int, X.0FTH, MusicPanel)'); }
} catch (e) { E('Hook X.0FTP.LIZ: ' + e); }

/* ── ③ 6 个子类的 LIZLLL(KtvMusic) —— 真正取 URL 的方法 ── */
function hookSlotLizlll(slot) {
    var ok = hookMethod(slot.cls, 'LIZLLL', [KTVMUSIC], function (ctx) {
        try {
            if (inProbe) return;
            var music = ctx.args[0];
            if (!music) return;

            var u = '';
            try { u = slotUrl(slot, music); } catch (e) {}
            if (!u) { try { u = str(call(ctx.this, 'LIZLLL', [music])); } catch (e) {} }

            var title = titleOf(music);
            // 只在有 URL 时打一行，避免 LX/0FTW 那种空槽刷屏
            if (u) {
                L('◆ ' + slot.slug + ' ' + slot.label + '  [' + (title || '?') + ']  '
                    + cut(u, CFG.urlMax));
            } else {
                d('◆ ' + slot.slug + ' 返回空  [' + (title || '?') + ']');
            }
        } catch (e) { E(slot.slug + '.LIZLLL 回调: ' + e); }
    }, 'after');
    if (ok) { hooked++; L('Hook OK: ' + slot.slug + '.LIZLLL(KtvMusic)'); }
}

for (var si = 0; si < SLOTS.length; si++) {
    try { hookSlotLizlll(SLOTS[si]); } catch (e) { E('Hook ' + SLOTS[si].slug + ': ' + e); }
}

/* ── ④ X.0FTO 路径拼装（可选观测：能看到官方算出的目录） ── */
try {
    if (hookMethod('X.0FTO', 'LIZLLL', ['long'], function (ctx) {
        try {
            if (inProbe) return;
            d('X.0FTO.LIZLLL(id=' + str(ctx.args[0]) + ')');
        } catch (e) {}
    }, 'before')) { hooked++; L('Hook OK: X.0FTO.LIZLLL(long)'); }
} catch (e) { d('Hook X.0FTO.LIZLLL 跳过'); }

L('=== 加载完成，' + hooked + ' 个 Hook ===');
L('提示：打开点歌面板/已点列表即会自动出表；也可手动调 hList() / hProbe() / hSlots()');

/* ================================================================
 * 6. 手动入口（日志页 console 调用）
 * ================================================================ */

/** 打出 6 槽位静态对照表 */
function hSlots() {
    L('');
    L('=== X.0FTP 六槽位对照（dex 核对） ===');
    for (var i = 0; i < SLOTS.length; i++) {
        var s = SLOTS[i];
        L(' ' + (i + 1) + '. ' + pad(s.slug, 11) + pad(s.label, 6)
            + '取值=' + pad(s.via, 14)
            + '目录=' + pad(s.track, 14)
            + 'KtvMusic.' + s.field);
    }
    L(' 触发链路: X.0FT6(6 个 X.0FTP 槽位) → X.0FTP.LIZ → X.0FUj.LIZLLL(music) → URL');
    L(' 保存路径: <X.0FKH.LIZ()>/musicPack/<musicId>/<track>/<fileName>');
    L('');
}

/** 打印已采集的全部 */
function hList() { printAll(); }

/** 清空已打印标记，让同一首歌可以再打一次 */
function hReset() {
    _printed = {};
    ALL = [];
    L('已清空采集缓存');
}

/** 探测最近一次 hook 到的 MusicPanel（不用重新点下载） */
var _lastPanel = null;
var _lastMusic = null;

function hProbe() {
    if (!_lastMusic) {
        W('还没 hook 到歌曲，先点一次下载或打开已点列表');
        return;
    }
    L('手动探测: ' + (titleOf(_lastMusic) || '?'));
    var res = probeMusic(_lastMusic, _lastPanel);
    printTable(res, 'manual');
}

hSlots();
