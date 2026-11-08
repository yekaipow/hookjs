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

var BUILD = 'v9.4-active';
var CFG = {
    /**
     * 'probe' = 只诊断（默认）：打印元素结构，不碰 UI、不下载
     * 'prod'  = 正常功能：注入按钮 + 下载
     */
    mode: 'prod',

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
var lastList = null;      // 最近一次的 List<MusicPanel>，供手动诊断
var _bindProbed = false;  // onBindViewHolder 参数是否已探测过

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

/** 一句话描述任意值，用于诊断 */
function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    var t = typeof v;
    if (t === 'string') return 'string(' + v.length + ')';
    if (t === 'number' || t === 'boolean') return t + ':' + v;
    if (t === 'function') return 'function';
    if (Object.prototype.toString.call(v) === '[object Array]') return 'Array(' + v.length + ')';
    var ks = [];
    try { ks = Object.keys(v); } catch (e) {}
    return 'Object{' + ks.length + ' keys}';
}

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
/**
 * ★ 重大发现（v8）
 *   QuickHook 在把 Java List 传给 JS 时，会把元素【转成纯 JS 对象】：
 *     · element.getClass 不是函数（TypeError: not a function）
 *     · element 上没有任何 $get / $fields / $type
 *     · 但它有普通的 JS 属性（Object.keys 能拿到）
 *
 *   所以解析必须走 JS 对象路径：直接读属性名，不能用反射。
 *   同时保留 Java 反射分支，以防某些场景下拿到的是真句柄。
 */
var failShown = false;
var _injectErrShown = false;

/** 判断是不是纯 JS 对象（不是 Java 句柄） */
function isPlainObject(v) {
    if (!v || typeof v !== 'object') return false;

    // ① Java 句柄的判据：有 $get / $type / getClass 这类
    try {
        if (typeof v.$get === 'function') return false;
        if (typeof v.$fields === 'function') return false;
        if (typeof v.$type === 'string') return false;
        if (typeof v.getClass === 'function') return false;
    } catch (e) {}

    // ② 真 JS 数组 → 算普通对象
    if (Object.prototype.toString.call(v) === '[object Array]') return true;

    // ③ 有 enumerable keys → 普通对象
    try {
        var ks = Object.keys(v);
        if (ks && ks.length > 0) return true;
    } catch (e) {}

    // ④ 关键：Proxy 式对象 keys 为空，但属性可直接访问。
    //    试探几个常见字段名，能读到值就认为是普通 JS 对象。
    var probeNames = ['LIZ', 'lIZ', 'music', 'musicInfo', 'title', 'id', 'a', 'b', 'd'];
    for (var i = 0; i < probeNames.length; i++) {
        try {
            var val = v[probeNames[i]];
            if (val !== undefined) return true;
        } catch (e) {}
    }

    return false;
}

/** 在 JS 对象里按名字找字段（大小写不敏感） */
function jsGet(v, name) {
    if (!v || typeof v !== 'object') return undefined;
    try {
        if (name in v) return v[name];
    } catch (e) {}
    // 大小写变体
    var lower = String(name).toLowerCase();
    var ks = [];
    try { ks = Object.keys(v); } catch (e) { return undefined; }
    for (var i = 0; i < ks.length; i++) {
        if (String(ks[i]).toLowerCase() === lower) {
            try { return v[ks[i]]; } catch (e) {}
        }
    }
    return undefined;
}

/**
 * 在 JS 对象里找一个「看起来像 KtvMusic」的子对象。
 * 判据：有 title / artist / url 之类常见键，或键数量 > 5。
 */
function findMusicInJS(panel) {
    // ① 优先常见字段名（不依赖 Object.keys）
    var prefer = ['LIZ', 'lIZ', 'music', 'musicInfo', 'ktvMusic', 'a'];
    for (var i = 0; i < prefer.length; i++) {
        var v;
        try { v = panel[prefer[i]]; } catch (e) { continue; }
        if (v && typeof v === 'object') {
            if (Object.prototype.toString.call(v) !== '[object Array]') {
                return { obj: v, name: prefer[i] };
            }
        }
    }

    // ② 若 keys 可用，挑键最多的子对象（KtvMusic 字段很多）
    var ks = [];
    try { ks = Object.keys(panel) || []; } catch (e) {}
    var best = null, bestN = 0;
    for (var j = 0; j < ks.length; j++) {
        var val;
        try { val = panel[ks[j]]; } catch (e) { continue; }
        if (!val || typeof val !== 'object') continue;
        if (Object.prototype.toString.call(val) === '[object Array]') continue;
        var sub = [];
        try { sub = Object.keys(val); } catch (e) { continue; }
        if (sub.length > bestN) {
            bestN = sub.length;
            best = { obj: val, name: ks[j] };
        }
    }
    if (best && bestN >= 2) return best;

    return null;
}

/** 从 JS 对象形态的 KtvMusic 里取字符串 */
function jsStr(music, names) {
    for (var i = 0; i < names.length; i++) {
        var v = jsGet(music, names[i]);
        if (typeof v === 'string' && v) return v;
    }
    return '';
}

/** 从 JS 对象里递归找 URL */
function jsFindUrl(o, depth) {
    depth = depth || 0;
    if (depth > 4 || !o || typeof o !== 'object') return '';

    // 收集候选键：Object.keys + 常见字段名
    var ks = [];
    try { ks = Object.keys(o) || []; } catch (e) {}
    // Proxy 式对象 keys 可能为空，补一批常见名
    var extra = ['url', 'uri', 'playUrl', 'songUrl', 'meta_url', 'MC',
                 'p', 'o', 'audio', 'audioInfo', 'track', 'meta_song_url',
                 'meta_full_track', 'meta_vocal_url', 'a', 'b', 'c', 'd', 'e'];
    for (var x = 0; x < extra.length; x++) {
        var found = false;
        for (var y = 0; y < ks.length; y++) { if (ks[y] === extra[x]) { found = true; break; } }
        if (!found) ks.push(extra[x]);
    }

    // ① 本层字符串
    for (var i = 0; i < ks.length; i++) {
        var v;
        try { v = o[ks[i]]; } catch (e) { continue; }
        if (typeof v === 'string') {
            var u = firstUrl(v);
            if (u) return u;
        }
    }

    // ② 递归子对象 / 数组
    for (var j = 0; j < ks.length; j++) {
        var c;
        try { c = o[ks[j]]; } catch (e) { continue; }
        if (!c || typeof c !== 'object') continue;

        if (Object.prototype.toString.call(c) === '[object Array]') {
            for (var k = 0; k < c.length && k < 8; k++) {
                var el = c[k];
                if (typeof el === 'string') {
                    var uu = firstUrl(el);
                    if (uu) return uu;
                } else if (el && typeof el === 'object') {
                    var u3 = jsFindUrl(el, depth + 1);
                    if (u3) return u3;
                }
            }
        } else {
            var u2 = jsFindUrl(c, depth + 1);
            if (u2) return u2;
        }
    }

    return '';
}

/**
 * ★ 从 QuickHook 精简代理的 `s` 字段解析。
 *
 * QuickHook 把 Java 对象转成了 {@, h, c, s} 四个字段：
 *   s = "MusicPanel(id = 7508739404626921507 , title = 天若有情（Cover A-Lin）)"
 *
 * 这是 KtvMusic.toString() 的文本，含 id 和 title。
 * 虽然拿不到 URL，但足以定位是哪首歌。
 */
function parseProxyText(proxy) {
    var s = '';
    try { s = String(proxy.s || ''); } catch (e) {}
    if (!s) return null;

    // 提取所有 "key = value" 对
    var out = {};
    var re = /(\w+)\s*=\s*([^,)]+?)(?:\s*,\s*(?=\w+\s*=)|\s*\)\s*$)/g;
    var m;
    while ((m = re.exec(s)) !== null) {
        out[m[1]] = String(m[2]).trim();
    }

    if (!out.id && !out.title) return null;

    return out;
}

/**
 * 处理 {@,h,c,s} 形式的代理对象。
 * 返回 {title, musicId, raw} 或 null。
 */
function parseProxy(panel) {
    // 确认是精简代理
    var hasAt = false, hasH = false, hasC = false, hasS = false;
    try {
        hasAt = (panel['@'] !== undefined);
        hasH = (panel.h !== undefined);
        hasC = (panel.c !== undefined);
        hasS = (panel.s !== undefined);
    } catch (e) { return null; }

    if (!hasS) return null;

    var cls = '';
    try { cls = String(panel.c || ''); } catch (e) {}

    // 只处理跟歌曲相关的类
    if (cls && cls.indexOf('MusicPanel') < 0 &&
        cls.indexOf('KtvMusic') < 0 &&
        cls.indexOf('Song') < 0) {
        return null;
    }

    var txt = parseProxyText(panel);
    if (!txt) return null;

    return {
        title: txt.title || '',
        musicId: txt.id || '',
        className: cls,
        raw: String(panel.s || '')
    };
}

/** JS 对象路径解析 */
function parseFromJSObject(panel) {
    var found = findMusicInJS(panel);
    if (!found) {
        if (!failShown) {
            failShown = true;
            loge('【JS 解析】panel 里找不到像 KtvMusic 的对象');
            var ks = [];
            try { ks = Object.keys(panel) || []; } catch (e) {}
            log('  panel 键(' + ks.length + '): ' + ks.join(', '));
        }
        return null;
    }

    var music = found.obj;

    var title = jsStr(music, ['title', 'd', 'songName', 'musicName', 'name']);
    var artist = jsStr(music, ['artist', 'b', 'singer', 'artistName', 'author']);
    var musicId = '';
    var idv = jsGet(music, 'id');
    if (idv === undefined) idv = jsGet(music, 'a');
    if (idv === undefined) idv = jsGet(music, 'musicId');
    if (idv !== undefined && idv !== null) musicId = String(idv);

    var url = jsFindUrl(music);

    return {
        key: keyOf(title, artist),
        title: title || ('#' + (musicId || '?')),
        artist: artist,
        musicId: musicId,
        url: url,
        track: url ? CFG.defaultTrack : '',
        hash: '',
        ext: url ? extFromUrl(url) : CFG.defaultExt,
        viaField: 'JS:' + found.name
    };
}

/* ================= ★ 句柄还原（v9 新 API） ================= */
/**
 * QuickHook 把 Java 对象降级成 {@, h, c, s} 代理：
 *   @  引用标记 "@o"
 *   h  句柄 id（真对象还在内存里）
 *   c  类名
 *   s  toString 文本
 *
 * 用新加的 API 还原成可操作句柄：
 *   Java.fromHandle(h, className)
 *   Java.ref(h) / Java.ref(proxy)
 *   proxy.$get / $call / $keys
 */

var _resolveStat = { fromHandle: 0, refH: 0, refObj: 0, proxyGet: 0, none: 0 };

function resolveHandle(proxy) {
    if (!proxy) return null;

    var h, cls = '';
    try { h = proxy.h; } catch (e) {}
    try { cls = String(proxy.c || ''); } catch (e) {}

    // ① Java.fromHandle(h, className)
    if (typeof Java.fromHandle === 'function' && h !== undefined) {
        try {
            var r1 = Java.fromHandle(h, cls);
            if (r1) { _resolveStat.fromHandle++; return r1; }
        } catch (e) { d('fromHandle 失败: ' + e); }
    }

    // ② Java.ref(h)
    if (typeof Java.ref === 'function' && h !== undefined) {
        try {
            var r2 = Java.ref(h);
            if (r2 && r2 !== h) { _resolveStat.refH++; return r2; }
        } catch (e) { d('Java.ref(h) 失败: ' + e); }
    }

    // ③ Java.ref(proxy)
    if (typeof Java.ref === 'function') {
        try {
            var r3 = Java.ref(proxy);
            if (r3 && r3 !== proxy) { _resolveStat.refObj++; return r3; }
        } catch (e) { d('Java.ref(proxy) 失败: ' + e); }
    }

    // ④ 代理自带 $get
    if (typeof proxy.$get === 'function') {
        _resolveStat.proxyGet++;
        return proxy;
    }

    _resolveStat.none++;
    return null;
}

/** 句柄读字段：$get 优先，其次 $keys 找，最后属性 */
function hGet(obj, name) {
    if (!obj) return null;
    try {
        if (typeof obj.$get === 'function') {
            var v = obj.$get(name);
            if (v !== undefined && v !== null) return v;
        }
    } catch (e) {}
    try {
        if (typeof obj.$keys === 'function') {
            var ks = obj.$keys();
            var arr = (typeof ks === 'string') ? ks.split(',') : ks;
            for (var i = 0; i < arr.length; i++) {
                if (String(arr[i]).trim() === name) {
                    var v2 = obj.$get(name);
                    if (v2 !== undefined && v2 !== null) return v2;
                }
            }
        }
    } catch (e) {}
    try {
        var v3 = obj[name];
        if (v3 !== undefined && v3 !== null) return v3;
    } catch (e) {}
    return null;
}

/** 句柄调方法：$call 优先，其次直接调用 */
function hCall(obj, method, args) {
    if (!obj) return null;
    try {
        if (typeof obj.$call === 'function') {
            return obj.$call(method, args || []);
        }
    } catch (e) { d('$call(' + method + ') 失败: ' + e); }
    try {
        var fn = obj[method];
        if (typeof fn === 'function') return fn.apply(obj, args || []);
    } catch (e) {}
    return null;
}

/** 句柄的字段名列表 */
function hKeys(obj) {
    if (!obj) return [];
    try {
        if (typeof obj.$keys === 'function') {
            var ks = obj.$keys();
            if (typeof ks === 'string') return ks.split(',');
            if (ks && ks.length !== undefined) {
                var out = [];
                for (var i = 0; i < ks.length; i++) out.push(String(ks[i]));
                return out;
            }
        }
    } catch (e) {}
    try {
        if (typeof obj.$fields === 'function') {
            var fs = obj.$fields() || [];
            var o2 = [];
            for (var j = 0; j < fs.length; j++) {
                var parts = String(fs[j]).split(/\s+/);
                o2.push(parts[parts.length - 1]);
            }
            return o2;
        }
    } catch (e) {}
    return [];
}

/** 从 KtvMusic 句柄取音频 URL */
function hPickAudio(music) {
    if (!music) return null;

    var tracks = [
        { m: 'TC', t: 'accompaniment' },
        { m: 'WC', t: 'fullTrack' }
    ];

    for (var i = 0; i < tracks.length; i++) {
        var ai = hCall(music, tracks[i].m);
        if (!ai) continue;

        var u = hCall(ai, 'MC');
        var hh = hCall(ai, 'KC');
        var us = u === null || u === undefined ? '' : String(u);
        if (us.length > 10 && /^https?:/i.test(us)) {
            return { url: us, hash: hh ? String(hh) : '', track: tracks[i].t };
        }
    }

    // 直给 String 的方法
    var dirs = [['sD', 'extra_s'], ['iD', 'extra_i']];
    for (var j = 0; j < dirs.length; j++) {
        var sv = hCall(music, dirs[j][0]);
        if (sv && /^https?:/i.test(String(sv))) {
            return { url: String(sv), hash: '', track: dirs[j][1] };
        }
    }

    // 遍历字段找 http
    var ks = hKeys(music);
    for (var k = 0; k < ks.length; k++) {
        var fv = hGet(music, ks[k]);
        if (typeof fv === 'string') {
            var fu = firstUrl(fv);
            if (fu) return { url: fu, hash: '', track: 'field:' + ks[k] };
        }
    }

    // $str 兜底
    try {
        var st = '';
        if (typeof music.$str === 'function') st = String(music.$str());
        var su = firstUrl(st);
        if (su) return { url: su, hash: '', track: 'toString' };
    } catch (e) {}

    return null;
}

/**
 * ★ 精确取 long 型 id。
 * JS number 只有 53 位精度，抖音的 musicId 是 19 位（long），
 * 直接 String(musicId) 会变成 6.85e18 这种科学计数法。
 *
 * 解决：优先从 $str() 文本里正则提取，那里的数字是原始字符串。
 *   例如 "MusicPanel(id = 6857477704963328001 , title = 起风了)"
 */
function exactIdFromText(text) {
    if (!text || typeof text !== 'string') return '';
    // 匹配 id = 数字 （可能带空格）
    var m = text.match(/id\s*=\s*(\d{6,})/i);
    if (m) return m[1];
    // 兜底：匹配任意 15 位以上连续数字（排除科学计数法）
    var m2 = text.match(/\b(\d{15,})\b/);
    if (m2) return m2[1];
    return '';
}

/** 从 panel 句柄解析出完整信息 */
function parseFromHandle(panelHandle, idx) {
    // 取 KtvMusic
    var music = hGet(panelHandle, 'LIZ');
    if (!music) {
        var ks = hKeys(panelHandle);
        for (var i = 0; i < ks.length; i++) {
            if (ks[i] === 'LIZ' || ks[i].indexOf('LIZ') === 0) {
                music = hGet(panelHandle, ks[i]);
                if (music) break;
            }
        }
    }
    if (!music) return null;

    // 歌名
    var title = '';
    try {
        var t = hCall(music, 'getTitle');
        if (t) title = String(t);
    } catch (e) {}
    if (!title) {
        try { var t2 = hCall(music, 'fD'); if (t2) title = String(t2); } catch (e) {}
    }
    if (!title) {
        var td = hGet(music, 'd');
        if (typeof td === 'string') title = td;
    }

    // 歌手
    // 歌手：必须是「像人名的字符串」，排除纯数字（那是 id）
    var artist = '';
    function looksLikeArtist(v) {
        if (typeof v !== 'string') return false;
        var t = v.trim();
        if (/^\d+$/.test(t)) return false;          // 纯数字 → 是 id，不是歌手
        if (/^\d+\.?\d*[eE]\+?\d+$/.test(t)) return false;   // 科学计数法
        return true;
    }
    // ① 字段 b（反编译确认的歌手字段）
    var ab = hGet(music, 'b');
    if (looksLikeArtist(ab)) artist = ab.trim();
    // ② 方法 YC
    if (!artist) {
        try {
            var a = hCall(music, 'YC');
            if (looksLikeArtist(a)) artist = String(a).trim();
        } catch (e) {}
    }
    // ③ 遍历字段找
    if (!artist) {
        var mk = hKeys(music);
        for (var ai = 0; ai < mk.length; ai++) {
            var an = mk[ai];
            if (an === 'b' || an === 'artist' || an === 'singer') {
                var av = hGet(music, an);
                if (looksLikeArtist(av)) { artist = String(av).trim(); break; }
            }
        }
    }

    // id
    // ★ id 必须精确：优先从文本提取，避免 long → number 精度丢失
    var musicId = '';
    // ① 从 music 的 $str 取
    try {
        var mstr = '';
        if (typeof music.$str === 'function') mstr = String(music.$str());
        musicId = exactIdFromText(mstr);
    } catch (e) {}
    // ② 从 panel 的 $str 取（MusicPanel 的 toString 里也有 id）
    if (!musicId) {
        try {
            var pstr = '';
            if (typeof panelHandle.$str === 'function') pstr = String(panelHandle.$str());
            musicId = exactIdFromText(pstr);
        } catch (e) {}
    }
    // ③ 兜底：方法调用（可能是 number，精度可能丢失，记 warning）
    if (!musicId) {
        try {
            var mid = hCall(music, 'XC');
            if (mid !== null && mid !== undefined) {
                musicId = String(mid);
                if (musicId.indexOf('e+') >= 0 || musicId.indexOf('E') >= 0) {
                    logw('id 精度可能丢失: ' + musicId + '（文本里没找到原始值）');
                }
            }
        } catch (e) {}
    }
    if (!musicId) {
        try { var mid2 = hCall(music, 'getId'); if (mid2) musicId = String(mid2); } catch (e) {}
    }

    var audio = hPickAudio(music);

    return {
        key: keyOf(title, artist),
        title: title || ('#' + (musicId || idx)),
        artist: artist,
        musicId: musicId,
        url: audio ? audio.url : '',
        track: audio ? audio.track : CFG.defaultTrack,
        hash: audio ? audio.hash : '',
        ext: audio ? extFromUrl(audio.url) : CFG.defaultExt,
        viaField: 'handle'
    };
}

function parsePanel(panel, idx) {
    if (!panel) return null;

    var fallback = null;   // 句柄路径拿到但无 URL 时的备选

    // ── ★ ⓪ 最高优先：还原句柄，拿完整数据（含 URL） ──
    var hd = resolveHandle(panel);
    if (hd) {
        var r = parseFromHandle(hd, idx);
        if (r && r.url) return r;                 // 完整成功
        if (r) {
            d('句柄路径拿到数据但无 URL: ' + r.title);
            fallback = r;
        }
    }

    // ── ① QuickHook 精简代理 {@,h,c,s} —— 从 s 文本兜底 ──
    var px = parseProxy(panel);
    if (px) {
        // 如果句柄路径拿到了歌名（只是没 URL），优先用句柄的
        if (fallback) return fallback;
        return {
            key: keyOf(px.title, ''),
            title: px.title || ('#' + (px.musicId || idx)),
            artist: '',
            musicId: px.musicId,
            url: '',                       // 代理里没有 URL
            track: '',
            hash: '',
            ext: CFG.defaultExt,
            viaField: 'proxy:s',
            proxyRaw: px.raw
        };
    }

    // ── ① 纯 JS 对象路径 ──
    if (isPlainObject(panel)) {
        var r = parseFromJSObject(panel);
        if (r) return r;
        return null;
    }

    // ── ② Java 句柄路径（兜底，保留旧逻辑） ──
    var pfields = reflectFieldsOnly(panel);
    var music = null, byField = '';

    var mf = findFieldByType(pfields, 'KtvMusic');
    if (mf && mf.value) { music = mf.value; byField = mf.name; }

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
            loge('【反射解析】panel 里找不到 KtvMusic 类型字段');
            log('  panel 字段共 ' + pfields.length + ' 个');
        }
        return null;
    }

    var title2 = pickTitle(music);
    var artist2 = pickArtist(music);
    var musicId2 = pickMusicId(music);
    var audio = pickUrlFromMusic(music);

    return {
        key: keyOf(title2, artist2),
        title: title2 || ('#' + (musicId2 || idx)),
        artist: artist2,
        musicId: musicId2,
        url: audio ? audio.url : '',
        track: audio ? audio.track : CFG.defaultTrack,
        hash: audio ? audio.hash : '',
        ext: audio ? extFromUrl(audio.url) : CFG.defaultExt,
        viaField: byField
    };
}

/** 批量采集 */
var _lastCount = -1;
function collectAll(list) {
    var n = listLen(list);
    if (!n) return 0;

    var ok = 0, hasUrl = 0, failed = 0;
    for (var i = 0; i < n; i++) {
        var info = parsePanel(listGet(list, i), i);
        if (!info) { failed++; continue; }
        ok++;
        if (info.url) hasUrl++;

        if (!songs[info.key]) order.push(info.key);
        songs[info.key] = info;
    }

    logi('采集 ' + ok + '/' + n + ' 首，有 URL ' + hasUrl + ' 首'
         + (failed ? '，失败 ' + failed : ''));
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
    log('╔══════════ PROBE v8.1 穷举探针 ══════════╗');

    var n = listLen(list);
    log('列表长度: ' + n);
    log('list 的 typeof: ' + (typeof list));
    log('list instanceof Array: ' + (list instanceof Array));

    if (!n) { log('列表为空'); return false; }
    probeDone = true;

    var first = listGet(list, 0);
    log('');
    log('════ 元素访问方式逐一测试 ════');

    // ① typeof / 构造
    log('[1] typeof = ' + (typeof first));
    try { log('    constructor = ' + (first && first.constructor ? first.constructor.name : '?')); } catch (e) { log('    constructor 读取失败'); }

    // ② Object.keys
    var keys = null;
    try {
        keys = Object.keys(first);
        log('[2] Object.keys = [' + (keys || []).join(', ') + ']  共 ' + (keys ? keys.length : 0));
    } catch (e) { log('[2] Object.keys 抛异常: ' + e); }

    // ③ getOwnPropertyNames
    try {
        var pn = Object.getOwnPropertyNames(first);
        log('[3] getOwnPropertyNames = [' + pn.join(', ') + ']  共 ' + pn.length);
    } catch (e) { log('[3] getOwnPropertyNames 抛异常: ' + e); }

    // ④ for...in
    try {
        var fi = [];
        for (var kk in first) { fi.push(kk); if (fi.length > 40) break; }
        log('[4] for...in = [' + fi.join(', ') + ']  共 ' + fi.length);
    } catch (e) { log('[4] for...in 抛异常: ' + e); }

    // ⑤ JSON.stringify
    try {
        var js = JSON.stringify(first);
        log('[5] JSON.stringify 长度 = ' + (js ? js.length : 0));
        if (js) log('    前 400 字: ' + js.slice(0, 400));
    } catch (e) { log('[5] JSON.stringify 抛异常: ' + e); }

    // ⑥ toString
    try {
        log('[6] String() = ' + String(first).slice(0, 200));
    } catch (e) { log('[6] String() 抛异常'); }

    // ⑦ 常见 Java 句柄 API
    log('[7] Java 句柄 API 检测:');
    var apis = ['$get', '$fields', '$type', '$str', '$is', '$new', 'getClass', '$handle'];
    for (var a = 0; a < apis.length; a++) {
        var t = '?';
        try { t = typeof first[apis[a]]; } catch (e) { t = '抛异常'; }
        log('    ' + apis[a] + ' : ' + t);
    }

    // ⑧ 直接按名字试探（Proxy 可能只支持属性访问）
    log('[8] 直接属性访问测试:');
    var names = ['LIZ', 'lIZ', 'music', 'musicInfo', 'ktvMusic', 'a', 'title', 'id', 'b', 'd'];
    for (var b = 0; b < names.length; b++) {
        var nm = names[b];
        var got;
        var err = null;
        try { got = first[nm]; } catch (e) { err = e; }
        if (err) { log('    ' + nm + ' → 抛异常: ' + err); continue; }
        if (got === undefined) { log('    ' + nm + ' → undefined'); continue; }
        log('    ' + nm + ' → ' + describe(got));
        // 如果是对象，再挖一层
        if (got && typeof got === 'object') {
            var subKeys = null;
            try { subKeys = Object.keys(got); } catch (e) {}
            log('        └ keys = [' + (subKeys || []).join(', ') + ']');
            // 继续试 title/id/url
            var subs = ['title', 'artist', 'id', 'd', 'b', 'a', 'url', 'meta_song_url', 'p', 'o'];
            for (var c = 0; c < subs.length; c++) {
                var sv;
                try { sv = got[subs[c]]; } catch (e) { continue; }
                if (sv !== undefined) log('        .' + subs[c] + ' = ' + describe(sv));
            }
        }
    }

    // ⑨ 用反射兜底（若 keys 为空但真的是 Java 对象）
    if (!keys || !keys.length) {
        log('[9] keys 为空，尝试 Java 反射');
        try {
            var cls = null;
            try { cls = first.getClass(); } catch (e) { log('    getClass 不可用'); }
            if (cls) {
                var fs = cls.getDeclaredFields();
                log('    反射字段数: ' + (fs ? fs.length : 0));
            }
        } catch (e) { log('    反射失败: ' + e); }
    }

    // ⑨.5 尝试还原 Java 句柄
    //    QuickHook 给的是 {@, h, c, s} 精简代理：
    //      @ = "@o" 标记，h = 句柄id，c = 类名，s = toString
    //    试 Java.ref() 能否还原成可操作句柄。
    log('');
    log('════ 句柄还原尝试 ════');
    var h = undefined, c = '';
    try { h = first.h; } catch (e) {}
    try { c = String(first.c || ''); } catch (e) {}
    log('  代理信息: h=' + h + '  c=' + c);

    var refd = null;
    // 方式1：Java.ref(整个代理对象)
    try {
        if (typeof Java.ref === 'function') {
            refd = Java.ref(first);
            log('  Java.ref(first) → ' + describe(refd));
            if (refd) {
                log('    $get 类型: ' + typeof refd.$get);
                log('    $type: ' + (refd.$type || '(无)'));
                try { log('    $str: ' + String(refd.$str()).slice(0, 200)); } catch (e) { log('    $str 不可用'); }
            }
        } else {
            log('  Java.ref 不存在');
        }
    } catch (e) { log('  Java.ref(first) 失败: ' + e); }

    // 方式2：Java.ref(h) 传句柄 id
    try {
        if (typeof Java.ref === 'function' && h !== undefined) {
            var r2 = Java.ref(h);
            log('  Java.ref(h=' + h + ') → ' + describe(r2));
        }
    } catch (e) { log('  Java.ref(h) 失败: ' + e); }

    // 方式3：按类名 Java.use 后尝试强转
    try {
        if (h !== undefined && c) {
            var C = Java.use(c);
            log('  Java.use("' + c + '") → 成功, $methods=' + (C.$methods ? C.$methods().length : '?'));
        }
    } catch (e) { log('  Java.use(c) 失败: ' + e); }

    // 方式4：如果还原成功，试着拿字段
    if (refd) {
        try {
            var flds = refd.$fields ? refd.$fields() : null;
            log('  还原后 $fields: ' + (flds ? flds.length + ' 个' : '不可用'));
            if (flds) for (var fi = 0; fi < Math.min(flds.length, 10); fi++) log('    ' + flds[fi]);
        } catch (e) { log('  还原后 $fields 失败: ' + e); }
    }

    // ⑨.6 句柄还原测试（新 API）
    log('');
    log('════ 句柄还原（v9 新 API） ════');
    log('  Java.fromHandle: ' + typeof Java.fromHandle);
    log('  Java.ref       : ' + typeof Java.ref);
    log('  proxy.$get     : ' + typeof first.$get);
    log('  proxy.$call    : ' + typeof first.$call);
    log('  proxy.$keys    : ' + typeof first.$keys);

    var rh = resolveHandle(first);
    if (rh) {
        log('  ✓ 还原成功');
        log('    $type: ' + (function(){try{return rh.$type||'?';}catch(e){return '?';}})());
        try { log('    $keys: [' + hKeys(rh).join(',') + ']'); } catch (e) {}
    } else {
        log('  ✗ 还原失败（四条路径都不可用）');
    }

    if (rh) {
        var pa = parseFromHandle(rh, 0);
        if (pa) {
            log('  --- parseFromHandle 结果 ---');
            log('    标题: ' + pa.title);
            log('    歌手: ' + pa.artist);
            log('    id  : ' + pa.musicId);
            log('    URL : ' + (pa.url || '(无)'));
            log('    音轨: ' + pa.track);
            log('    hash: ' + (pa.hash || '(无)'));
        } else {
            log('  parseFromHandle 返回 null');
        }
    }

    // ⑩ 尝试解析
    log('');
    log('════ 解析尝试 ════');
    var info = parsePanel(first, 0);
    if (info) {
        log('✓ 成功! 歌名=' + info.title + ' 歌手=' + info.artist
            + ' id=' + info.musicId + ' via=' + info.viaField);
        log('  URL=' + (info.url || '(无)'));
    } else {
        loge('✗ 失败 —— 请把上面 [1]~[10] 全部贴给我');
    }

    log('╚══════════ PROBE v8.1 ══════════╝');
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

    postToMain(function () {
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
            postToMain(function () { flushPending(); });
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
/**
 * ★ 把任务真正「排队」到主线程消息队列。
 *
 * 为什么需要这个：
 *   Hook 回调运行在主线程，且此时主线程被 Hook 占用。
 *   Ui.post 在这种上下文里会「同步执行」，导致 Ui.create 抛
 *     IllegalStateException: 主线程正被 Hook 回调占用
 *
 *   Handler.post 则是把 Runnable 塞进 MessageQueue，等当前
 *   消息（即 Hook 所在的调用栈）处理完后才执行。这才是安全的。
 *
 * QuickHook 支持用 JS 对象实现 Java 接口：
 *   Java.use('java.lang.Runnable').$new({ run: function(){...} })
 * 不同版本写法可能不同，这里依次尝试几种。
 */
var _mainHandler = null;

function getMainHandler() {
    if (_mainHandler) return _mainHandler;
    try {
        var Looper = Java.use('android.os.Looper');
        var Handler = Java.use('android.os.Handler');
        _mainHandler = Handler.$new(Looper.getMainLooper());
        logi('主线程 Handler 已创建');
    } catch (e) {
        loge('创建 Handler 失败: ' + e);
    }
    return _mainHandler;
}

function postToMain(fn) {
    var h = getMainHandler();
    if (!h) {
        // 实在没有 Handler，退回 Ui.post
        try { Ui.post(fn); return true; } catch (e) { return false; }
    }

    // 方式1：用 Java 接口代理实现 Runnable
    try {
        var Runnable = Java.use('java.lang.Runnable');
        var r = Runnable.$new({ run: fn });
        h.post(r);
        return true;
    } catch (e1) {
        d('Runnable.$new(JSObj) 失败: ' + e1);
    }

    // 方式2：Java.registerClass
    try {
        var Runnable2 = Java.use('java.lang.Runnable');
        var Cls = Java.registerClass({
            name: 'com.qh.MainRunner' + (new Date().getTime()),
            implements: [Runnable2],
            methods: { run: fn }
        });
        h.post(Cls.$new());
        return true;
    } catch (e2) {
        d('registerClass 失败: ' + e2);
    }

    // 方式3：退到 Ui.post
    try { Ui.post(fn); return true; } catch (e3) {
        loge('postToMain 全部失败: ' + e3);
        return false;
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

// ⓪ 列表创建 —— 这是最早的主动获取点
//
// PlayListContainerView 里字段 d 就是 List<MusicPanel>（反编译确认），
// 拿到容器实例就能直接读 d，不必等 LIZJ 回调。
// 同时这里 setAdapter 刚完成，是注入按钮的好时机。
try {
    Hook.method(PLAYLIST_CLS, 'LIZLLL', [], function (ctx) {
        try {
            var self = ctx.this;

            // ① 拿 RecyclerView
            var rv = null;
            try { rv = self.getSelectedListRv(); } catch (e) {}
            if (rv) {
                listRv = rv; targetRv = rv; lastSig = '';
                logi('★ 列表已创建，实例已记录');
            }

            // ② ★ 主动读取 List<MusicPanel>
            //    容器字段 d 就是这个列表（反编译确认）
            var list = null;
            try {
                list = self.$get ? self.$get('d') : null;
            } catch (e) {}
            if (!list) {
                try { list = self.d; } catch (e) {}
            }

            // 三条路拿列表
            if (!list) {
                // ②-2 getAdapter().getItems()
                try {
                    var ad = self.getAdapter();
                    if (ad) {
                        try { list = ad.getItems(); } catch (e) {}
                        if (!list) { try { list = ad.$get('items'); } catch (e) {} }
                        if (list) d('从 adapter 取到列表');
                    }
                } catch (e) {}
            }
            if (!list && rv) {
                // ②-3 RecyclerView.getAdapter().getItems()
                try {
                    var ad2 = rv.getAdapter();
                    if (ad2) {
                        try { list = ad2.getItems(); } catch (e) {}
                        if (!list) { try { list = ad2.$get('items'); } catch (e) {} }
                    }
                } catch (e) {}
            }

            if (list) {
                var n = listLen(list);
                logi('★ 主动读到列表，长度 ' + n);
                if (n > 0) {
                    collectAll(list);
                    needRefresh = true;
                }
            } else {
                d('三条路都没拿到列表，等 LIZJ');
            }

            // ③ 面板已打开，标记待处理
            if (triggerHost && !triggerMounted) needMountTrigger = true;
            if (pendingSwitch && !switchedThisOpen) needSwitchTab = true;

            flushPending();

        } catch (e) { loge('LIZLLL: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: LIZLLL（创建即采集）');
} catch (e) { loge('Hook LIZLLL 失败: ' + e); }

// ① 数据更新
try {
    var lizjHook = Hook.method(PLAYLIST_CLS, 'LIZJ', ['java.util.List'], function (ctx) {
        try {
            var list = ctx.args[0];
            lastList = list;   // 留一份给手动诊断用

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

            // 置标志，然后立刻交给 Handler 排队消费
            // （flushPending 内部用 postToMain，不会同步执行 Ui）
            if (triggerHost && !triggerMounted) needMountTrigger = true;
            if (armed) needRefresh = true;
            flushPending();
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

                // 置标志，交给 Handler 排队消费
                if (triggerHost && !triggerMounted) needMountTrigger = true;
                if (armed) needRefresh = true;
                if (needMountTrigger || needRefresh) flushPending();
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
                    // 置标志 + 排队消费
                    if (armed) needRefresh = true;
                    if (needRefresh) flushPending();
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

// ⑤.5 onBindViewHolder —— 这里能拿到原始 Java 参数
//
// LIZJ 拿到的 List 元素被 QuickHook 降级成了 {@,h,c,s} 代理，
// 没有字段和方法。但 onBindViewHolder 的 ctx.args[1] 是方法入参，
// 有可能是完整句柄。这是拿 URL 的关键突破口。
try {
    Hook.method('X.0FZs', 'onBindViewHolder',
        ['androidx.recyclerview.widget.RecyclerView$ViewHolder', 'java.lang.Object'],
        function (ctx) {
            try {
                var item = ctx.args[1];
                if (!item) return;

                // 只在第一次详细探测
                if (!_bindProbed) {
                    _bindProbed = true;
                    log('');
                    log('════ onBindViewHolder 参数探测 ════');
                    log('  item typeof: ' + (typeof item));
                    log('  item 描述: ' + describe(item));

                    var ks = null;
                    try { ks = Object.keys(item); } catch (e) {}
                    log('  Object.keys: [' + (ks || []).join(', ') + ']');

                    // 是否有 Java 句柄 API
                    var apis = ['$get', '$fields', '$type', '$str', 'getClass', '$handle', '$is'];
                    for (var i = 0; i < apis.length; i++) {
                        var t = '?';
                        try { t = typeof item[apis[i]]; } catch (e) { t = 'err'; }
                        log('    ' + apis[i] + ' : ' + t);
                    }

                    // 尝试拿 LIZ（KtvMusic）
                    var music = null;
                    try { music = item.LIZ; } catch (e) {}
                    if (music === undefined) { try { music = item.$get('LIZ'); } catch (e) {} }
                    log('  item.LIZ → ' + describe(music));

                    if (music) {
                        log('  --- KtvMusic 探测 ---');
                        log('    $get: ' + typeof music.$get);
                        log('    $type: ' + (music.$type || '(无)'));

                        // 试 TC / WC
                        var tcs = ['TC', 'WC', 'getTitle', 'XC'];
                        for (var j = 0; j < tcs.length; j++) {
                            var fn = null;
                            try { fn = music[tcs[j]]; } catch (e) {}
                            if (typeof fn === 'function') {
                                try {
                                    var rv = fn.call(music);
                                    log('    ' + tcs[j] + '() = ' + describe(rv));
                                    if (rv && typeof rv === 'object') {
                                        try { log('        MC() = ' + rv.MC()); } catch (e) {}
                                        try { log('        KC() = ' + rv.KC()); } catch (e) {}
                                    }
                                } catch (e) { log('    ' + tcs[j] + '() 调用失败: ' + e); }
                            } else {
                                log('    ' + tcs[j] + ' 不是函数');
                            }
                        }

                        // $str 里找 URL
                        try {
                            var st = music.$str ? String(music.$str()) : '';
                            log('    $str 长度: ' + st.length);
                            var u = firstUrl(st);
                            if (u) log('    ★ $str 里发现 URL: ' + u.slice(0, 120));
                            else log('    $str 前 200 字: ' + st.slice(0, 200));
                        } catch (e) {}
                    }
                    log('════ 探测结束 ════');
                    log('');
                }
            } catch (e) {
                loge('onBindViewHolder 探测异常: ' + e);
            }
        }, 'after');
    hooked++;
    logi('Hook OK: X.0FZs.onBindViewHolder（探测参数）');
} catch (e) { logw('Hook onBindViewHolder 跳过: ' + e); }

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
postToMain(function () {
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

/**
 * 手动穷举探针：用最近一次 LIZJ 拿到的 list 重跑诊断。
 * 不需要重启，改完脚本直接在日志页调用即可。
 */
function probeLast() {
    if (!lastList) {
        logw('还没有捕获到列表，请先打开一次点歌面板');
        return;
    }
    probeDone = false;
    probeOnce(lastList);
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

// 提前创建主线程 Handler，确认可用性
try {
    var _h = getMainHandler();
    logi('Handler 就绪: ' + (_h ? '可用' : '不可用（将退化 Ui.post）'));
} catch (e) {
    loge('Handler 初始化失败: ' + e);
}
