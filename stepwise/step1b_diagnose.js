/**
 * 抖音 KTV · 第1步补丁：诊断元素结构
 *
 * 现象：列表长度 34 拿到了，但解析成功 0/34
 * 怀疑：ctx.args[0] 的元素不是 MusicPanel，或 LIZ 字段读不到
 *
 * 本脚本不做业务，只把「第一个元素」和「最后一个元素」的真实结构打出来：
 *   1. 真实类名
 *   2. 全部字段列表
 *   3. 逐个字段尝试读取，打印类型和值
 *   4. 多种方式尝试拿 KtvMusic，看哪种能成
 *
 * 跑一次，把日志全部贴给我，就能定位。
 */

log('=== 第1步补诊断：元素结构 ===');

/* ================= 工具 ================= */
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

/** 安全取类名 */
function typeName(o) {
    if (!o) return 'null';
    var t = '';
    try { t = o.$type; } catch (e) {}
    if (t) return String(t);
    try { t = o.getClass().getName(); } catch (e) {}
    if (t) return String(t);
    return typeof o;
}

/** 安全 toString */
function strOf(o) {
    if (!o) return 'null';
    try {
        var s = o.$str();
        if (s) return String(s).slice(0, 400);
    } catch (e) {}
    try { return String(o).slice(0, 400); } catch (e) {}
    return '(无法 toString)';
}

/**
 * 提取字段名。$fields() 格式是 "类型 名字"，
 * 但类型可能自带空格（泛型、内部类），所以从后往前找：
 * 取最后一个"空格分隔的标识符"作为名字。
 * 例：
 *   "LIZ com.x.KtvMusic"              → LIZ
 *   "Ljava.util.List; d"               → d
 *   "java.util.Map<java.lang.String, java.lang.Object> v" → v
 */
function fieldNames(cls) {
    var out = [];
    try {
        var fs = cls.$fields();
        var n = (fs && fs.length) ? fs.length : 0;
        for (var i = 0; i < n; i++) {
            var raw = String(fs[i]);
            // 按空格切，取最后一段
            var parts = raw.split(/\s+/);
            var name = parts[parts.length - 1] || raw;
            out.push(name);
        }
    } catch (e) {
        log('  $fields 失败: ' + e);
    }
    return out;
}

/** 尝试用多种方式读一个字段，返回第一个成功的值 */
function tryGet(o, name) {
    if (!o) return null;
    // ① $get
    try {
        var v = o.$get(name);
        if (v !== undefined && v !== null) return v;
    } catch (e) {}
    // ② 直接属性
    try {
        var v2 = o[name];
        if (v2 !== undefined && v2 !== null) return v2;
    } catch (e) {}
    return null;
}

/* ================= 核心：探测一个元素 ================= */
function probeElement(el, tag) {
    log('');
    log('════════ ' + tag + ' ════════');
    if (!el) { logw('元素为 null'); return; }

    log('真实类型: ' + typeName(el));
    log('toString: ' + strOf(el));

    // ── 字段列表 ──
    var names = fieldNames(el);
    log('字段数: ' + names.length);
    if (names.length) log('字段名: ' + names.join(', '));

    // ── 逐字段尝试读取（只打印非 null 的，且值不长的） ──
    log('--- 逐字段取值 ---');
    var shown = 0;
    for (var i = 0; i < names.length && shown < 30; i++) {
        var fname = names[i];
        var v = tryGet(el, fname);
        if (v === null) continue;
        shown++;

        var vt = typeName(v);
        var vs = '';
        if (typeof v === 'string') vs = ' = "' + v.slice(0, 80) + '"';
        else if (typeof v === 'number' || typeof v === 'boolean') vs = ' = ' + v;
        else vs = ' (' + vt + ')';

        log('  ' + fname + ' [' + vt + ']' + vs);
    }
    if (shown === 0) log('  （所有字段都读不到值）');

    // ── 重点：尝试拿 KtvMusic ──
    log('--- 尝试拿 KtvMusic ---');
    var candidates = ['LIZ', 'a', 'music', 'musicInfo', 'ktvMusic'];
    var got = null, gotBy = '';
    for (var j = 0; j < candidates.length; j++) {
        var cv = tryGet(el, candidates[j]);
        if (cv === null) continue;
        var ct = typeName(cv);
        log('  试 ' + candidates[j] + ' → ' + ct);
        // 判断是不是 KtvMusic（类名含 KtvMusic）
        if (String(ct).indexOf('KtvMusic') >= 0 && !got) {
            got = cv;
            gotBy = candidates[j];
        }
    }

    if (got) {
        log('★ 找到 KtvMusic，通过字段: ' + gotBy);
        probeMusic(got);
    } else {
        logw('✗ 没找到 KtvMusic 类型的字段');
        // 最后兜底：如果 toString 里能看到线索，打出来
        log('  toString 片段已在上方输出，可据此判断');
    }
}

/* ================= 探测 KtvMusic ================= */
function probeMusic(music) {
    log('--- KtvMusic 内部 ---');
    log('  类型: ' + typeName(music));

    // 歌名
    try { log('  getTitle() = ' + music.getTitle()); } catch (e) { log('  getTitle 失败'); }

    // 音频：TC / WC
    try {
        var ai = music.TC();
        log('  TC() = ' + (ai ? typeName(ai) : 'null'));
        if (ai) {
            try { log('    MC() url  = ' + String(ai.MC()).slice(0, 120)); } catch (e) { log('    MC 失败'); }
            try { log('    KC() hash = ' + ai.KC()); } catch (e) { log('    KC 失败'); }
        }
    } catch (e) { log('  TC() 失败: ' + e); }

    try {
        var af = music.WC();
        log('  WC() = ' + (af ? typeName(af) : 'null'));
        if (af) {
            try { log('    MC() url  = ' + String(af.MC()).slice(0, 120)); } catch (e) { log('    MC 失败'); }
        }
    } catch (e) { log('  WC() 失败: ' + e); }

    // id
    try { log('  XC() id = ' + music.XC()); } catch (e) { log('  XC 失败'); }

    // 如果上面都没拿到 url，看 toString 里有没有 http
    try {
        var s = music.$str();
        var m = String(s).match(/https?:\/\/[^\s"'\\<>\)\]]{10,200}/);
        if (m) log('  ★ toString 里发现 URL: ' + m[0].slice(0, 150));
    } catch (e) {}
}

/* ================= Hook ================= */
var PLAY_LIST = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';

var probed = false;

try {
    Hook.method(PLAY_LIST, 'LIZJ', ['java.util.List'], function (ctx) {
        // 只探测第一次，避免刷屏
        if (probed) return;
        probed = true;

        try {
            var list = ctx.args[0];
            var n = listLen(list);

            log('');
            log('######## 开始诊断 ########');
            log('参数类型: ' + typeName(list));
            log('列表长度: ' + n);

            if (!list || n === 0) {
                logw('列表为空，等下一次触发');
                probed = false;   // 允许下次再试
                return;
            }

            // 第一个元素详细探测
            probeElement(listGet(list, 0), '第 0 个元素');

            // 最后一个元素只打类型（对比确认是否同构）
            if (n > 1) {
                var last = listGet(list, n - 1);
                log('');
                log('第 ' + (n - 1) + ' 个元素类型: ' + typeName(last));
            }

            log('');
            log('######## 诊断结束 ########');

        } catch (e) {
            loge('诊断异常: ' + e);
            probed = false;
        }
    }, 'after');

    logi('✓ 诊断 Hook 已挂，等点歌面板触发');
} catch (e) {
    loge('✗ Hook 失败: ' + e);
}

log('触发后看日志里的「######## 开始诊断 ########」段落');
