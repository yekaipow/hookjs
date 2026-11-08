/**
 * 抖音 KTV · 新 API 验证脚本  v9-probe
 *
 * 目的：验证你新加的四个 API 哪个可用，并把整条链路跑通。
 *   Java.fromHandle(h, className)
 *   Java.ref(obj) / Java.ref(h)
 *   proxy.$get('LIZ')
 *   proxy.$call('getTitle')
 *   proxy.$keys()
 *
 * 这个脚本只做探测，不注入按钮、不下载。
 * 跑通后我会把结果合进主脚本。
 */

var BUILD = 'v9-api-probe';
log('╔══════════════════════════════════════════╗');
log('║ KTV ' + BUILD);
log('╚══════════════════════════════════════════╝');

var PLAYLIST = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';

/* ================= 通用工具 ================= */

function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    var t = typeof v;
    if (t === 'string') return 'string(' + v.length + '):' + (v.length > 40 ? v.slice(0, 40) + '…' : v);
    if (t === 'number' || t === 'boolean') return t + ':' + v;
    if (t === 'function') return 'function';
    if (Object.prototype.toString.call(v) === '[object Array]') return 'Array(' + v.length + ')';
    var ks = [];
    try { ks = Object.keys(v); } catch (e) {}
    return 'Object{' + ks.join(',') + '}';
}

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

var URL_RE = /https?:\/\/[^\s"'\\<>\)\],;]+/g;
function firstUrl(t) {
    if (!t || typeof t !== 'string') return '';
    URL_RE.lastIndex = 0;
    var m = t.match(URL_RE);
    return (m && m.length) ? m[0] : '';
}

/* ================= 检查 API 是否真的存在 ================= */

function checkApis() {
    log('');
    log('════ 你新加的 API 可用性检查 ════');

    var ok = 0, total = 0;

    function chk(name, fn) {
        total++;
        try {
            if (typeof fn === 'function') {
                log('  ✓ ' + name + ' : function');
                ok++;
                return true;
            }
            log('  ✗ ' + name + ' : ' + typeof fn);
            return false;
        } catch (e) {
            log('  ✗ ' + name + ' : 抛异常 ' + e);
            return false;
        }
    }

    chk('Java.fromHandle', Java.fromHandle);
    chk('Java.ref', Java.ref);

    log('  可用 ' + ok + '/' + total);
    log('  （proxy.$get / $call / $keys 需要拿到代理对象才能测）');
    log('');
    return ok;
}

/* ================= 核心：从一个代理元素取到 MusicPanel 句柄 ================= */
/**
 * 尝试所有可能的还原路径，返回第一个成功的句柄。
 * 同时把每条路径的结果打出来，方便判断哪个最可靠。
 */
function resolveHandle(proxy) {
    log('');
    log('════ 句柄还原（四条路径） ════');

    var h = undefined, cls = '';
    try { h = proxy.h; } catch (e) {}
    try { cls = String(proxy.c || ''); } catch (e) {}
    log('  代理信息: h=' + h + '  class=' + cls);
    log('  Object.keys: [' + (function () { try { return Object.keys(proxy).join(','); } catch (e) { return '?'; } })() + ']');

    // ── 路径 1：Java.fromHandle(h, className) ──
    if (typeof Java.fromHandle === 'function' && h !== undefined) {
        try {
            var r1 = Java.fromHandle(h, cls);
            log('  [1] Java.fromHandle(' + h + ') → ' + describe(r1));
            if (r1) {
                logHandleDetail(r1, '1');
                return { obj: r1, via: 'Java.fromHandle' };
            }
        } catch (e) { log('  [1] Java.fromHandle 失败: ' + e); }
    } else {
        log('  [1] Java.fromHandle 不可用');
    }

    // ── 路径 2：Java.ref(h) ──
    if (typeof Java.ref === 'function' && h !== undefined) {
        try {
            var r2 = Java.ref(h);
            log('  [2] Java.ref(' + h + ') → ' + describe(r2));
            if (r2) {
                logHandleDetail(r2, '2');
                return { obj: r2, via: 'Java.ref(h)' };
            }
        } catch (e) { log('  [2] Java.ref(h) 失败: ' + e); }
    } else {
        log('  [2] Java.ref 不可用');
    }

    // ── 路径 3：Java.ref(proxy) 整个对象 ──
    if (typeof Java.ref === 'function') {
        try {
            var r3 = Java.ref(proxy);
            log('  [3] Java.ref(proxy) → ' + describe(r3));
            if (r3 && r3 !== proxy) {
                logHandleDetail(r3, '3');
                return { obj: r3, via: 'Java.ref(proxy)' };
            }
        } catch (e) { log('  [3] Java.ref(proxy) 失败: ' + e); }
    }

    // ── 路径 4：代理对象本身就有 $get（直接可用） ──
    if (proxy && typeof proxy.$get === 'function') {
        log('  [4] 代理自带 $get，直接使用');
        return { obj: proxy, via: 'proxy.$get' };
    } else {
        log('  [4] 代理没有 $get');
    }

    log('  ✗ 四条路径都没拿到句柄');
    return null;
}

/** 打印句柄的细节，判断是完整句柄还是降级对象 */
function logHandleDetail(o, tag) {
    if (!o) return;
    var items = ['$type', '$get', '$fields', '$str', '$call', '$keys', '$handle'];
    for (var i = 0; i < items.length; i++) {
        var t = '?';
        try { t = typeof o[items[i]]; } catch (e) { t = 'err'; }
        if (t !== 'undefined') log('      ' + tag + ' ' + items[i] + ' : ' + t);
    }
    try { if (o.$type) log('      ' + tag + ' 类名: ' + o.$type); } catch (e) {}
    try { if (o.$keys) log('      ' + tag + ' 字段名: [' + String(o.$keys()).slice(0, 200) + ']'); } catch (e) {}
}

/* ================= 从 MusicPanel 句柄取 KtvMusic ================= */
function getMusic(panelHandle) {
    log('');
    log('════ 取 KtvMusic ════');
    var music = null, via = '';

    // ① $get
    if (typeof panelHandle.$get === 'function') {
        try {
            var m = panelHandle.$get('LIZ');
            log('  panel.$get("LIZ") → ' + describe(m));
            if (m) { music = m; via = '$get'; }
        } catch (e) { log('  $get 失败: ' + e); }
    }

    // ② $keys 找字段
    if (!music && typeof panelHandle.$keys === 'function') {
        try {
            var keys = panelHandle.$keys();
            log('  panel.$keys() → [' + String(keys) + ']');
            var arr = (typeof keys === 'string') ? keys.split(',') : keys;
            for (var i = 0; i < arr.length; i++) {
                var k = String(arr[i]).trim();
                if (k === 'LIZ' || k.indexOf('LIZ') === 0) {
                    try {
                        var v = panelHandle.$get(k);
                        if (v) { music = v; via = '$keys→' + k; break; }
                    } catch (e) {}
                }
            }
        } catch (e) { log('  $keys 失败: ' + e); }
    }

    // ③ 直接属性
    if (!music) {
        try {
            var d = panelHandle.LIZ;
            if (d) { music = d; via = '属性'; }
        } catch (e) {}
    }

    if (music) {
        log('  ✓ 拿到 KtvMusic（via=' + via + '）');
        logHandleDetail(music, 'K');
    } else {
        log('  ✗ 拿不到 KtvMusic');
    }
    return music;
}

/* ================= 从 KtvMusic 取音频 URL ================= */
function getAudio(music) {
    log('');
    log('════ 取音频 URL ════');

    // ① 官方路径：TC() / WC() → AudioInfo.MC()
    var paths = [
        { name: 'TC', track: 'accompaniment' },
        { name: 'WC', track: 'fullTrack' }
    ];

    for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        var ai = null;

        // 用 $call 或直接调用
        try {
            if (typeof music.$call === 'function') {
                ai = music.$call(p.name);
            } else if (typeof music[p.name] === 'function') {
                ai = music[p.name]();
            }
        } catch (e) { log('  ' + p.name + '() 失败: ' + e); continue; }

        if (!ai) { log('  ' + p.name + '() = null'); continue; }
        log('  ' + p.name + '() → ' + describe(ai));

        // 取 MC（url）和 KC（hash）
        var url = '', hash = '';
        try {
            if (typeof ai.$call === 'function') {
                url = ai.$call('MC');
                hash = ai.$call('KC');
            } else {
                if (typeof ai.MC === 'function') url = ai.MC();
                if (typeof ai.KC === 'function') hash = ai.KC();
            }
        } catch (e) { log('    MC/KC 失败: ' + e); }

        log('    MC() = ' + describe(url));
        log('    KC() = ' + describe(hash));

        var u = firstUrl(String(url || ''));
        if (u) {
            log('  ★ 成功拿到 URL: ' + u.slice(0, 140));
            return { url: u, hash: String(hash || ''), track: p.track };
        }
    }

    // ② 兜底：$str 里正则捞
    log('  官方路径失败，试 $str 正则');
    try {
        var st = '';
        if (typeof music.$str === 'function') st = String(music.$str());
        else if (typeof music.$call === 'function') st = String(music.$call('toString') || '');
        log('    $str 长度: ' + st.length);
        var u2 = firstUrl(st);
        if (u2) {
            log('  ★ 从 $str 拿到: ' + u2.slice(0, 140));
            return { url: u2, hash: '', track: 'toString' };
        }
        log('    $str 前 300 字: ' + st.slice(0, 300));
    } catch (e) { log('    $str 失败: ' + e); }

    // ③ 再兜底：遍历所有 String 字段
    log('  试遍历字段找 URL');
    try {
        if (typeof music.$keys === 'function') {
            var ks = music.$keys();
            var arr2 = (typeof ks === 'string') ? ks.split(',') : ks;
            for (var j = 0; j < arr2.length; j++) {
                var kk = String(arr2[j]).trim();
                var vv = null;
                try { vv = music.$get(kk); } catch (e) { continue; }
                if (typeof vv === 'string') {
                    var u3 = firstUrl(vv);
                    if (u3) {
                        log('  ★ 字段 ' + kk + ' 里有 URL: ' + u3.slice(0, 140));
                        return { url: u3, hash: '', track: 'field:' + kk };
                    }
                }
            }
        }
    } catch (e) { log('    遍历失败: ' + e); }

    log('  ✗ 没拿到 URL');
    return null;
}

/* ================= 取歌名 ================= */
function getTitle(music) {
    var cands = ['getTitle', 'fD'];
    for (var i = 0; i < cands.length; i++) {
        try {
            var v = null;
            if (typeof music.$call === 'function') v = music.$call(cands[i]);
            else if (typeof music[cands[i]] === 'function') v = music[cands[i]]();
            if (v) return String(v);
        } catch (e) {}
    }
    return '';
}

/* ================= 主流程 ================= */

checkApis();

var done = false;

try {
    Hook.method(PLAYLIST, 'LIZJ', ['java.util.List'], function (ctx) {
        if (done) return;
        done = true;

        try {
            var list = ctx.args[0];
            var n = listLen(list);
            log('');
            log('╔══════════ API 验证开始 ══════════╗');
            log('列表长度: ' + n);

            if (!n) { log('列表为空'); done = false; return; }

            var el = listGet(list, 0);
            log('');
            log('--- 元素 0 原始形态 ---');
            log('  ' + describe(el));
            log('  JSON: ' + (function () {
                try { return JSON.stringify(el).slice(0, 300); } catch (e) { return '?'; }
            })());

            // ① 还原句柄
            var resolved = resolveHandle(el);
            if (!resolved) {
                loge('✗ 无法还原句柄，流程终止');
                log('╚══════════ 结束 ══════════╝');
                return;
            }
            log('  ✓ 句柄来源: ' + resolved.via);

            // ② 取 KtvMusic
            var music = getMusic(resolved.obj);
            if (!music) {
                loge('✗ 拿不到 KtvMusic');
                log('╚══════════ 结束 ══════════╝');
                return;
            }

            // ③ 歌名
            var title = getTitle(music);
            log('');
            log('  歌名: ' + (title || '(取不到)'));

            // ④ 音频
            var audio = getAudio(music);

            // ⑤ 结论
            log('');
            log('╔══════════ 结论 ══════════╗');
            log('  句柄来源: ' + resolved.via);
            log('  歌名    : ' + (title || '(无)'));
            if (audio) {
                log('  ✓ URL   : ' + audio.url.slice(0, 140));
                log('  ✓ 音轨  : ' + audio.track);
                log('  ✓ hash  : ' + (audio.hash || '(无)'));
                log('');
                log('  ★★★ 全链路打通！可以把结果合进主脚本了 ★★★');
            } else {
                loge('  ✗ 还是没有 URL');
                log('  → 请把上面「取音频 URL」整段贴给我');
            }
            log('╚══════════ 结束 ══════════╝');
            log('');

        } catch (e) {
            loge('主流程异常: ' + e);
        }
    }, 'after');

    logi('✓ Hook 已挂 LIZJ，等点歌面板触发');
} catch (e) {
    loge('Hook 失败: ' + e);
}

log('打开「已点」列表即可看到验证结果');
