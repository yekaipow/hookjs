/**
 * 抖音 KTV · 已点列表前 3 行「下载」按钮  v5
 *
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)
 * 环境：QuickHook (QuickJS)
 *
 * ── v5 修正（针对 "可见 item 数: undefined"） ──────────────
 * 1. 不再用 Ui.children() 遍历列表项（返回值不是 JS 数组，length 为 undefined）
 *    → 改用 Java 侧 rv.getChildCount() / rv.getChildAt(i)，这是 RecyclerView 标准 API
 * 2. 改为「item 可见时才执行」
 *    → Hook RecyclerView.onLayout：布局完成时刷新（首次进入/数据变化）
 *    → Hook RecyclerView.onScrollStateChanged：滚动停止（state==0）时刷新
 *    → 注入前用 isShown() + 可视区域判断，不可见的跳过
 * 3. 只处理 adapterPosition < 3 的 item（真正的前三首）
 * ─────────────────────────────────────────────────────────
 */

var CFG = {
    debug: true,

    maxRows: 3,                 // 只处理前 3 首（adapterPosition 0/1/2）
    threads: 6,                 // 多线程分块下载（API 上限 8）
    retries: 3,
    timeout: 30000,
    ua: 'okhttp/3.12.13',
    referer: 'https://live.douyin.com/',

    btnText: '下载',
    defaultTrack: 'accompaniment',
    defaultExt: '.mp3'
};

// 已点列表 RecyclerView 的资源 id（0x7f0aa7b8 / zj+）
var RV_ID = 2131404728;

// 触发按钮容器：一级页签右侧空白区（0x7f0aa6d7 / zeq，FrameLayout）
var TRIGGER_HOST_ID = 2131404503;

function d() { if (CFG.debug) logd.apply(null, arguments); }

log('=== KTV 前3行下载 v5 加载 ===');

/* ================= 全局状态 ================= */
var songs = {};           // key -> info
var order = [];
var targetRv = null;      // 记住目标 RecyclerView 的 Java 句柄（弱引用，用前判活）
var listRv = null;        // ★ 列表创建时记录的实例，用于精确身份比对
var listCreated = false;  // 列表是否已创建（LIZLLL 执行过）
var dirty = false;
var flushing = false;
var lastInjectSig = '';   // 注入签名，避免重复刷新
var armed = false;        // ★ 触发开关：false=不往列表行注入
var triggerHost = null;   // zeq 容器的 Java 句柄（只在主线程回调里赋值）
var triggerMounted = false;

/* ================= 工具 ================= */
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

function safeName(s) {
    if (!s) return '';
    return String(s).replace(/[\\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60);
}

function keyOf(title, artist) { return (title || '') + '|' + (artist || ''); }

function extFromUrl(url) {
    try {
        var clean = String(url).split('?')[0].split('#')[0];
        var m = clean.match(/\.(mp3|m4a|aac|wav|flac|ogg|mp4|m4s)$/i);
        if (m) return '.' + m[1].toLowerCase();
    } catch (e) {}
    return CFG.defaultExt;
}

/** 归一化成 JS 数组：兼容 undefined / null / Java List / 真数组 */
function asArray(x) {
    if (!x) return [];
    if (Object.prototype.toString.call(x) === '[object Array]') return x;
    var out = [];
    try {
        var n = x.size ? x.size() : (typeof x.length === 'number' ? x.length : 0);
        for (var i = 0; i < n; i++) {
            try { out.push(typeof x.get === 'function' ? x.get(i) : x[i]); }
            catch (e) {}
        }
    } catch (e) {}
    return out;
}

function listLen(lst) {
    try { if (lst.size) return lst.size(); } catch (e) {}
    try { if (typeof lst.length === 'number') return lst.length; } catch (e) {}
    return 0;
}

function listGet(lst, i) {
    try { if (lst.get) return lst.get(i); } catch (e) {}
    try { return lst[i]; } catch (e) {}
    return null;
}

/* ================= 取音频信息 ================= */
function pickAudio(music) {
    // ① 伴奏 TC() -> AudioInfo.MC()=url, KC()=hash
    try {
        var ai = music.TC();
        if (ai) {
            var u = ai.MC();
            if (u && String(u).length > 10) {
                var h = '';
                try { h = ai.KC(); } catch (e) {}
                return { url: String(u), hash: h ? String(h) : '', track: 'accompaniment' };
            }
        }
    } catch (e) {}

    // ② 完整音轨 WC()
    try {
        var af = music.WC();
        if (af) {
            var u2 = af.MC();
            if (u2 && String(u2).length > 10) {
                var h2 = '';
                try { h2 = af.KC(); } catch (e) {}
                return { url: String(u2), hash: h2 ? String(h2) : '', track: 'fullTrack' };
            }
        }
    } catch (e) {}

    // ③ 直给 String
    var direct = [{ m: 'sD', track: 'extra_s' }, { m: 'iD', track: 'extra_i' }];
    for (var i = 0; i < direct.length; i++) {
        try {
            var fn = music[direct[i].m];
            if (typeof fn !== 'function') continue;
            var s = fn.call(music);
            if (s && /^https?:/i.test(String(s))) {
                return { url: String(s), hash: '', track: direct[i].track };
            }
        } catch (e) {}
    }

    // ④ URL 列表 aD()
    try {
        var lst = music.aD();
        var n = listLen(lst);
        for (var k = 0; k < n && k < 5; k++) {
            var el = listGet(lst, k);
            if (el && /^https?:/i.test(String(el))) {
                return { url: String(el), hash: '', track: 'list' };
            }
        }
    } catch (e) {}

    return null;
}

/* ================= 采集 ================= */
function collect(panel) {
    try {
        var music = getField(panel, 'LIZ');
        if (!music) return null;

        var title = '';
        try { var t = music.getTitle(); if (t) title = String(t); } catch (e) {}
        if (!title) { try { var t2 = music.fD(); if (t2) title = String(t2); } catch (e) {} }
        if (!title) { var t3 = getField(music, 'd'); if (typeof t3 === 'string') title = t3; }
        if (!title) return null;

        var artist = '';
        try { var a = music.YC(); if (a && String(a).length < 50) artist = String(a); } catch (e) {}
        if (!artist) { var b = getField(music, 'b'); if (typeof b === 'string' && b.length < 50) artist = b; }

        var musicId = 0;
        try { musicId = music.XC(); } catch (e) {}
        if (!musicId) { try { musicId = music.getId(); } catch (e) {} }

        var audio = pickAudio(music);
        var key = keyOf(title, artist);
        if (!songs[key]) order.push(key);

        songs[key] = {
            key: key,
            title: title,
            artist: artist,
            musicId: String(musicId || ''),
            url: audio ? audio.url : '',
            hash: audio ? audio.hash : '',
            track: audio ? audio.track : CFG.defaultTrack,
            ext: audio ? extFromUrl(audio.url) : CFG.defaultExt
        };
        return songs[key];
    } catch (e) {
        loge('collect 异常: ' + e);
        return null;
    }
}

function collectAll(list) {
    var n = listLen(list);
    if (!n) return 0;
    var ok = 0;
    for (var i = 0; i < n; i++) {
        var p = listGet(list, i);
        if (p && collect(p)) ok++;
    }
    logi('采集 ' + ok + '/' + n + ' 首');
    return ok;
}

function findSongByLabel(label) {
    if (!label) return null;
    label = String(label).trim();
    if (songs[label]) return songs[label];
    for (var k in songs) {
        if (!songs.hasOwnProperty(k)) continue;
        if (songs[k].title === label) return songs[k];
    }
    for (var k2 in songs) {
        if (!songs.hasOwnProperty(k2)) continue;
        var s = songs[k2];
        if (s.title.indexOf(label) >= 0 || label.indexOf(s.title) >= 0) return s;
    }
    return null;
}

function labelOf(itemUi) {
    try {
        var tvs = asArray(Ui.find(itemUi, { cls: 'TextView' }));
        var fallback = '';
        for (var i = 0; i < tvs.length; i++) {
            var t = Ui.text(tvs[i]);
            if (!t) continue;
            t = String(t).trim();
            if (t.length < 1 || t.length > 40) continue;
            if (/^\d+$/.test(t)) continue;
            if (/^\d{1,2}:\d{2}$/.test(t)) continue;
            if (findSongByLabel(t)) return t;
            if (!fallback) fallback = t;
        }
        return fallback;
    } catch (e) {}
    return '';
}

/* ================= 从 RecyclerView 取可见 item（核心修正） ================= */
/**
 * 用 Java API 拿子 View，绕开 Ui.children（返回值不是数组）。
 * 返回 [{ view: JavaView, pos: adapterPosition }]，已按可见性过滤。
 */
function visibleItems(rv) {
    var out = [];
    if (!rv) return out;

    var n = 0;
    try { n = rv.getChildCount(); } catch (e) {
        d('getChildCount 失败: ' + e);
        return out;
    }
    if (!n) { d('getChildCount = 0（尚未布局）'); return out; }

    var rvTop = 0, rvBottom = 0;
    try { rvTop = rv.getTop(); rvBottom = rv.getBottom(); } catch (e) {}

    for (var i = 0; i < n; i++) {
        var child = null;
        try { child = rv.getChildAt(i); } catch (e) { continue; }
        if (!child) continue;

        // 可见性：isShown = 自身及所有祖先 visible
        var shown = true;
        try { shown = child.isShown(); } catch (e) {}
        if (!shown) continue;

        // 高度必须 > 0
        var hgt = 0;
        try { hgt = child.getHeight(); } catch (e) {}
        if (hgt <= 0) continue;

        // 与 RecyclerView 可视区域有交集
        var top = 0, bottom = 0;
        try { top = child.getTop(); bottom = child.getBottom(); } catch (e) {}
        if (rvBottom > rvTop && (bottom <= rvTop || top >= rvBottom)) continue;

        // adapter 位置
        var pos = -1;
        try { pos = rv.getChildAdapterPosition(child); } catch (e) {}
        if (pos < 0) { try { pos = rv.getChildLayoutPosition(child); } catch (e) {} }
        if (pos < 0) {
            try { pos = rv.getChildViewHolder(child).getAdapterPosition(); } catch (e) {}
        }

        out.push({ view: child, pos: pos });
    }

    d('childCount=' + n + ' 可见=' + out.length);
    return out;
}

/* ================= 落盘路径 ================= */
function buildPath(info) {
    var root = '';
    try { root = String(Java.use('X.0FKH').LIZ()); } catch (e) {
        loge('取根目录失败: ' + e);
    }
    if (!root) root = '/sdcard';
    if (root.charAt(root.length - 1) === '/') root = root.slice(0, -1);

    var musicId = info.musicId || '0';
    var track = info.track || CFG.defaultTrack;

    var base = info.hash && String(info.hash).length > 0
             ? safeName(info.hash)
             : safeName(info.title) + '_' + musicId;
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += info.ext || CFG.defaultExt;

    return root + '/musicPack/' + safeName(musicId) + '/' + track + '/' + base;
}

/* ================= 下载 ================= */
var running = 0, doneCount = 0, failCount = 0;

function startDownload(info) {
    if (!info || !info.url) { toast('该曲无可用地址'); return false; }

    var path = buildPath(info);
    var dir = path.substring(0, path.lastIndexOf('/'));

    try { File.mkdir(dir); } catch (e) {
        loge('建目录失败: ' + e);
        return false;
    }

    try {
        if (File.exists(path) && File.size(path) > 1024) {
            logi('已缓存，跳过：' + info.title);
            toast('已缓存：' + info.title);
            return true;
        }
    } catch (e) {}

    running++;
    logi('开始下载 [' + info.title + '] → ' + path);

    try {
        download({
            url: info.url,
            path: path,
            threads: CFG.threads,
            retries: CFG.retries,
            timeout: CFG.timeout,
            headers: { 'User-Agent': CFG.ua, 'Referer': CFG.referer },
            onProgress: function (s) {
                try {
                    if (s && s.percent >= 0 && s.percent % 20 === 0) {
                        d(info.title + ' ' + s.percent + '%' +
                          (s.speed ? ' ' + Math.round(s.speed / 1024) + 'KB/s' : ''));
                    }
                } catch (e) {}
            },
            onDone: function (s) {
                running--; doneCount++;
                logi('完成 [' + info.title + '] ' + (s && s.done ? s.done : '?') + 'B');
                toast('下载完成：' + info.title);
                if (running === 0) logi('=== 全部结束 成功' + doneCount + ' 失败' + failCount + ' ===');
            },
            onError: function (e) {
                running--; failCount++;
                loge('失败 [' + info.title + ']: ' + e);
                if (running === 0) logi('=== 全部结束 成功' + doneCount + ' 失败' + failCount + ' ===');
            }
        });
        return true;
    } catch (e) {
        running--; failCount++;
        loge('download 异常: ' + e);
        return false;
    }
}

/* ================= 注入 ================= */
/**
 * 在一行里维护「按钮组」：
 *   [下载] [更多]        ← 初始两个并列
 *   点「更多」后 →  [下载] [更多] [信息]   ← 再插入第三个
 *
 * 用 contentDescription 区分各按钮，全部挂同一套查重逻辑，
 * 避免 RecyclerView 复用时重复堆积。三者都来自同一 info，播放器/下载器解耦。
 */
var TAG_DL = 'qh_ktv_dl';        // 下载
var TAG_MORE = 'qh_ktv_more';    // 更多（点击后再插入）
var TAG_INFO = 'qh_ktv_info';    // 第三个（点更多后出现）

/** 造一个统一样式的按钮 */
function makeBtn(text, tag) {
    var b = Ui.create('button', text);
    try { b.setContentDescription(tag); } catch (e) {}
    try { b.setTextSize(11); } catch (e) {}
    try { b.setPadding(24, 6, 24, 6); } catch (e) {}
    return b;
}

/** 找一行里的某个按钮，没有返回 null */
function findBtn(itemUi, tag) {
    try {
        var arr = asArray(Ui.find(itemUi, { desc: tag }));
        return arr.length ? arr[0] : null;
    } catch (e) { return null; }
}

/** 追加到按钮组末尾（after 语义：紧跟在 anchor 后面） */
function insertAfter(anchorUi, btn, fallbackParent) {
    try {
        Ui.insert(anchorUi, btn, 'after');
        return true;
    } catch (e) {
        d('insert after 失败，改用 child: ' + e);
        try {
            Ui.insert(fallbackParent, btn, 'child');
            return true;
        } catch (e2) {
            loge('insert 彻底失败: ' + e2);
            return false;
        }
    }
}

/** 「更多」被点击：在本行插入第三个按钮「信息」 */
function onMoreClick(itemUi, info) {
    try {
        // 已存在就不重复插
        if (findBtn(itemUi, TAG_INFO)) {
            Ui.setText(findBtn(itemUi, TAG_INFO), '信息');
            return;
        }

        var btnInfo = makeBtn('信息', TAG_INFO);

        // 锚点优先「更多」，退而求其次「下载」，都没有就塞进容器
        var anchor = findBtn(itemUi, TAG_MORE) || findBtn(itemUi, TAG_DL);
        if (!insertAfter(anchor, btnInfo, itemUi)) return;

        Ui.onClick(btnInfo, function () {
            Ui.alert('歌曲信息',
                '歌名：' + (info.title || '-') +
                '\n歌手：' + (info.artist || '-') +
                '\nID：' + (info.musicId || '-') +
                '\n音轨：' + (info.track || '-') +
                '\n\n' + (info.url ? '地址：\n' + info.url : '（无可用地址）'));
        });

        logi('已插入第三个按钮 [' + info.title + ']');
    } catch (e) {
        loge('onMoreClick: ' + e);
    }
}

function injectOne(itemUi, info) {
    try {
        var btnDl = findBtn(itemUi, TAG_DL);
        var btnMore = findBtn(itemUi, TAG_MORE);

        // ---------- 已注入过：只刷新文案和点击，不重复插 ----------
        if (btnDl) {
            Ui.setText(btnDl, CFG.btnText);
            Ui.onClick(btnDl, function () { startDownload(info); });

            if (btnMore) {
                Ui.setText(btnMore, '更多');
                Ui.onClick(btnMore, function () { onMoreClick(itemUi, info); });
            }
            // 第三个按钮若已存在，也刷新它的回调
            var btnInfo = findBtn(itemUi, TAG_INFO);
            if (btnInfo) {
                Ui.onClick(btnInfo, function () {
                    Ui.alert('歌曲信息',
                        '歌名：' + (info.title || '-') +
                        '\n歌手：' + (info.artist || '-') +
                        '\nID：' + (info.musicId || '-') +
                        '\n音轨：' + (info.track || '-'));
                });
            }
            return false;
        }

        // ---------- 首次注入：两个并列按钮 ----------
        var dl = makeBtn(CFG.btnText, TAG_DL);
        if (!insertAfter(null, dl, itemUi)) return false;

        // 贴右上，避免和列表文字重叠
        try {
            var LP = Java.use('androidx.constraintlayout.widget.ConstraintLayout$LayoutParams');
            var lp = LP.$new(-2, -2);
            lp.topToTop = 0; lp.endToEnd = 0; lp.bottomToBottom = 0;
            try { lp.setMarginEnd(16); } catch (e) {}
            dl.setLayoutParams(lp);
        } catch (e) {}

        Ui.onClick(dl, function () { startDownload(info); });

        var more = makeBtn('更多', TAG_MORE);
        if (insertAfter(dl, more, itemUi)) {
            Ui.onClick(more, function () { onMoreClick(itemUi, info); });
        }

        logi('注入 [' + info.title + '] 下载+更多 ' + (info.url ? '✔' : '✘无URL'));
        return true;
    } catch (e) {
        loge('injectOne: ' + e);
        return false;
    }
}

/* ================= 触发按钮（zeq 容器） ================= */
/**
 * zeq (0x7f0aa6d7) 是一级页签行右侧的空 FrameLayout，
 * 由 CommonOrderedFirstLevelTabFragment.mM(View root) 通过
 * LX/0FaJ.LJIIL 这个 Function2 交给业务填充。
 *
 * 我们不去抢那个回调，而是在 mM 的 after 里：
 *   1. root.findViewById(TRIGGER_HOST_ID) 拿到 zeq
 *   2. 往里面塞一个「触发」按钮
 *   3. 点击后 armed = !armed，立即刷新列表
 */
var TAG_TRIGGER = 'qh_ktv_trigger';

/**
 * ★ 线程约束（这是上次报错的根因）
 *   mM / Fragment.onResume 都在主线程，且主线程正被 Hook 回调占用。
 *   在这类回调里调 Ui.post()，会被判定成"同步执行"而抛
 *     IllegalStateException: 主线程正被 Hook 回调占用
 *   所以这里只保存 zeq 的 Java 句柄，绝不碰任何 Ui API。
 *   真正的 UI 创建交给 refresh()——它走 onLayout / 滚动停止这条安全路径。
 */
function rememberHost(rootView) {
    try {
        if (!rootView) return false;
        if (triggerHost) return true;                 // 已捕获过
        var host = null;
        try { host = rootView.findViewById(TRIGGER_HOST_ID); } catch (e) { return false; }
        if (!host) return false;
        triggerHost = host;
        triggerMounted = false;                        // 待下次 refresh 挂载
        logi('已捕获 zeq 容器，等待安全时机挂按钮');
        return true;
    } catch (e) {
        d('rememberHost: ' + e);
        return false;
    }
}

/** 在安全时机（refresh 内，已在 Ui.post 中）把触发按钮放进 zeq */
function ensureTrigger() {
    if (!triggerHost || triggerMounted) return false;
    try {
        var hostUi = null;
        try { hostUi = Ui.root(triggerHost); } catch (e) {}
        if (!hostUi) { d('Ui.root(zeq) 失败'); return false; }

        var exist = null;
        try {
            var arr = asArray(Ui.find(hostUi, { desc: TAG_TRIGGER }));
            if (arr.length) exist = arr[0];
        } catch (e) {}

        if (exist) {
            syncTriggerText(exist);
            bindTriggerClick(exist);
            triggerMounted = true;
            return false;
        }

        var btn = Ui.create('button', armed ? '关闭' : '注入');
        try { btn.setContentDescription(TAG_TRIGGER); } catch (e) {}
        try { btn.setTextSize(11); } catch (e) {}
        try { btn.setPadding(20, 4, 20, 4); } catch (e) {}

        try {
            Ui.insert(hostUi, btn, 'child');
        } catch (e) {
            loge('往 zeq 插入失败: ' + e);
            return false;
        }

        bindTriggerClick(btn);
        triggerMounted = true;
        logi('触发按钮已挂到 zeq 容器');
        return true;
    } catch (e) {
        loge('ensureTrigger: ' + e);
        return false;
    }
}

function syncTriggerText(btn) {
    try { Ui.setText(btn, armed ? '关闭' : '注入'); } catch (e) {}
}

/** 点击只改状态 + 触发刷新，不直接动 UI（避免又踩主线程） */
function bindTriggerClick(btn) {
    Ui.onClick(btn, function () {
        armed = !armed;
        lastInjectSig = '';
        logi(armed ? '★ 已开启注入' : '★ 已关闭注入');
        toast(armed ? '已开启：前3行注入下载按钮' : '已关闭：按钮已清理');
        scheduleRefresh();
    });
}

/**
 * armed = 触发开关。
 * 只有点了 zeq(0x7f0aa6d7) 容器里的「触发」按钮，才会往列表行注入。
 * 关闭时立刻清理已注入的按钮，回到干净状态。
 */
function refresh() {
    try {
        // 这里是 Ui.post 内，属于安全时机：先保证 zeq 里的触发按钮存在
        if (triggerHost && !triggerMounted) {
            ensureTrigger();
        }

        var rv = targetRv;
        if (!rv) {
            logw('targetRv 为空，等待 onLayout 触发');
            return;
        }

        // ---- 未触发：清空所有已注入按钮（点过「关闭」或首次进入） ----
        if (!armed) {
            var cleared = clearAllButtons(rv);
            if (cleared) logi('已退出注入模式，清理 ' + cleared + ' 个按钮');
            lastInjectSig = '';
            return;
        }

        var items = visibleItems(rv);
        if (!items.length) {
            d('当前无可视 item');
            return;
        }

        // 只留 adapterPosition 0..2，并按位置排序
        var picked = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.pos >= 0 && it.pos < CFG.maxRows) picked.push(it);
        }
        if (!picked.length) {
            d('可见 item 中没有前三首（位置: ' +
              items.map(function (x) { return x.pos; }).join(',') + '）');
            return;
        }
        picked.sort(function (a, b) { return a.pos - b.pos; });

        // 签名去重：位置+歌名不变就不重复注入
        var sigParts = [];
        var todo = [];
        for (var j = 0; j < picked.length; j++) {
            var p = picked[j];
            var itemUi = null;
            try { itemUi = Ui.root(p.view); } catch (e) {}
            if (!itemUi) { d('Ui.root 失败 pos=' + p.pos); continue; }

            var label = labelOf(itemUi);
            if (!label) { d('pos=' + p.pos + ' 无文本'); continue; }

            var info = findSongByLabel(label);
            if (!info) { d('pos=' + p.pos + ' 未匹配: ' + label); continue; }

            sigParts.push(p.pos + ':' + label);
            todo.push({ ui: itemUi, info: info, pos: p.pos });
        }

        var sig = sigParts.join('|');
        if (sig && sig === lastInjectSig) { d('签名未变，跳过'); return; }
        lastInjectSig = sig;

        var n = 0;
        for (var t = 0; t < todo.length; t++) {
            if (injectOne(todo[t].ui, todo[t].info)) n++;
        }
        logi('可见前' + CFG.maxRows + '行处理完成：新增 ' + n + ' 个按钮（共 ' + todo.length + ' 行）');
    } catch (e) {
        loge('refresh: ' + e);
    }
}

/** 清掉 RecyclerView 里所有已注入按钮 */
/**
 * 清掉已注入按钮。
 * 不依赖 Ui.find 从 RecyclerView 全局递归（深度不可控），
 * 改为逐行（getChildAt）定位后再在该行内部查，命中率更高。
 */
function clearAllButtons(rv) {
    var n = 0;
    var tags = [TAG_DL, TAG_MORE, TAG_INFO];

    function killIn(itemUi) {
        for (var t = 0; t < tags.length; t++) {
            try {
                var arr = asArray(Ui.find(itemUi, { desc: tags[t] }));
                for (var j = 0; j < arr.length; j++) {
                    try { Ui.remove(arr[j]); n++; } catch (e) {}
                }
            } catch (e) {}
        }
    }

    // ① 逐行清理
    try {
        var cnt = 0;
        try { cnt = rv.getChildCount(); } catch (e) {}
        for (var i = 0; i < cnt; i++) {
            var child = null;
            try { child = rv.getChildAt(i); } catch (e) { continue; }
            if (!child) continue;
            var itemUi = null;
            try { itemUi = Ui.root(child); } catch (e) {}
            if (itemUi) killIn(itemUi);
        }
    } catch (e) {}

    // ② 兜底：整棵 rv 再扫一遍（有的实现能递归到底）
    try {
        var rvUi = Ui.root(rv);
        if (rvUi) killIn(rvUi);
    } catch (e) {}

    return n;
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
        } catch (e) {
            loge('scheduleRefresh: ' + e);
        } finally {
            flushing = false;
        }
    });
}

/* ================= 挂钩 ================= */
var PLAYLIST = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';
var RV = 'androidx.recyclerview.widget.RecyclerView';
var hooked = 0;

/**
 * 判断是不是已点列表那个 RecyclerView。
 * 优先用「实例身份」比对（列表创建时记录下来的那个对象），
 * 而不是只靠 id —— id 相同不代表是同一个实例，
 * 且 ListView 复用/重建时旧实例可能还活着。
 */
function isTargetRv(v) {
    if (!v) return false;
    // ① 实例身份（最可靠）
    if (listRv) {
        try { if (v === listRv) return true; } catch (e) {}
        try { if (v.equals(listRv)) return true; } catch (e) {}
    }
    // ② 兜底：按 id 判断（listRv 还没记录到时）
    try { return v.getId() === RV_ID; } catch (e) { return false; }
}

// ⓪ 创建入口：LIZLLL() 是列表初始化的唯一位置
//    内部依次做：getSelectedListRv → setLayoutManager → new MultiTypeAdapter
//              → register binder → setAdapter
//    这里是「列表刚被创建」的准确时刻，此时就把实例记下来
try {
    Hook.method(PLAYLIST, 'LIZLLL', [], function (ctx) {
        try {
            var rv = null;
            try { rv = ctx.this.getSelectedListRv(); } catch (e) {}
            if (!rv) { d('LIZLLL: getSelectedListRv 为空'); return; }

            listRv = rv;
            targetRv = rv;
            listCreated = true;
            lastInjectSig = '';

            var cid = -1;
            try { cid = rv.getId(); } catch (e) {}
            logi('★ 列表已创建，记录实例 id=0x' + (cid >>> 0).toString(16)
                 + '（之后按实例身份识别，不再靠猜 id）');
        } catch (e) {
            loge('LIZLLL 回调: ' + e);
        }
    }, 'after');
    hooked++;
    logi('Hook OK: PlayListContainerView.LIZLLL（列表创建）');
} catch (e) {
    loge('Hook LIZLLL 失败: ' + e);
}

// ① 数据入口：拿全量列表 + 记住 RecyclerView
try {
    Hook.method(PLAYLIST, 'LIZJ', ['java.util.List'], function (ctx) {
        try {
            collectAll(ctx.args[0]);
            var rv = null;
            try { rv = ctx.this.getSelectedListRv(); } catch (e) {}
            if (rv) {
                targetRv = rv;
                d('已捕获目标 RecyclerView');
            }
            scheduleRefresh();
        } catch (e) { loge('LIZJ: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: PlayListContainerView.LIZJ');
} catch (e) {
    loge('Hook LIZJ 失败: ' + e);
}

// ② 布局完成时才注入（此时 item 已可见）
try {
    Hook.method(RV, 'onLayout', ['boolean', 'int', 'int', 'int', 'int'], function (ctx) {
        try {
            var v = ctx.this;
            if (!isTargetRv(v)) return;

            // 若 LIZLLL 没被 Hook 到（时机早于脚本加载），这里回填实例
            if (!listRv) {
                listRv = v;
                listCreated = true;
                d('由 onLayout 回填 listRv');
            }
            targetRv = v;
            scheduleRefresh();
        } catch (e) { d('onLayout: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: RecyclerView.onLayout');
} catch (e) {
    logw('Hook onLayout 跳过: ' + e);
}

// ③ 滚动停止时再检查一次（滚动中新出现的 item）
try {
    Hook.method(RV, 'onScrollStateChanged', ['int'], function (ctx) {
        try {
            if (!isTargetRv(ctx.this)) return;
            var state = ctx.args[0];
            if (state === 0) {          // 0 = SCROLL_STATE_IDLE
                targetRv = ctx.this;
                lastInjectSig = '';      // 位置变了，允许重注入
                scheduleRefresh();
            }
        } catch (e) { d('onScrollStateChanged: ' + e); }
    }, 'after');
    hooked++;
    logi('Hook OK: RecyclerView.onScrollStateChanged');
} catch (e) {
    logw('Hook onScrollStateChanged 跳过: ' + e);
}

// ④ 触发按钮：只记录 zeq 句柄，绝不在主线程回调里碰 Ui
//    （mM 在主线程且被 Hook 占用，任何 Ui.post 都会被判非法）
try {
    Hook.method('com.bytedance.android.live.ktv.common.karaokestation.view.firstleveltab.CommonOrderedFirstLevelTabFragment',
        'mM', ['android.view.View'], function (ctx) {
            try {
                rememberHost(ctx.args[0]);
            } catch (e) { d('mM 回调: ' + e); }
        }, 'after');
    hooked++;
    logi('Hook OK: CommonOrderedFirstLevelTabFragment.mM（记录 zeq）');
} catch (e) {
    loge('Hook mM 失败: ' + e);
}

// ⑤ 兜底：Fragment.onResume 里也只记录句柄
//    用白名单限定到 KTV 页签相关 Fragment，避免命中所有 Fragment 刷屏
try {
    Hook.method('androidx.fragment.app.Fragment', 'onResume', [], function (ctx) {
        try {
            var cls = '';
            try { cls = String(ctx.this.getClass().getName()); } catch (e) { return; }
            if (cls.indexOf('karaokestation') < 0 &&
                cls.indexOf('FirstLevelTab') < 0 &&
                cls.indexOf('Ktv') < 0) return;

            var v = null;
            try { v = ctx.this.getView(); } catch (e) {}
            if (!v) return;
            rememberHost(v);
        } catch (e) {}
    }, 'after');
    hooked++;
    logi('Hook OK: Fragment.onResume（zeq 兜底，已限定 KTV 页签）');
} catch (e) {
    logw('Hook Fragment.onResume 跳过: ' + e);
}

logi('=== 加载完成：' + hooked + ' 个 Hook ===');

/* ================= 诊断 ================= */
function dumpSongs() {
    log('=== 已采集 ' + order.length + ' 首 ===');
    for (var i = 0; i < order.length; i++) {
        var s = songs[order[i]];
        if (!s) continue;
        log((i + 1) + '. ' + s.title + ' - ' + s.artist +
            '  id=' + s.musicId + '  ' + s.track + '  ' + (s.url ? 'URL OK' : '无URL'));
        if (s.url) log('    ' + buildPath(s));
    }
}

function dumpRv() {
    Ui.post(function () {
        try {
            var rv = targetRv;
            log('列表创建状态: listCreated=' + listCreated +
                ' listRv=' + (listRv ? '已记录' : '未记录'));
            if (!rv) { logw('还没捕获到 RecyclerView'); return; }
            log('rv id=0x' + rv.getId().toString(16) +
                ' childCount=' + rv.getChildCount() +
                ' height=' + rv.getHeight());
            var items = visibleItems(rv);
            items.forEach(function (it) {
                var h = 0, t = 0, b = 0, s = '?';
                try { h = it.view.getHeight(); } catch (e) {}
                try { t = it.view.getTop(); } catch (e) {}
                try { b = it.view.getBottom(); } catch (e) {}
                try { s = it.view.isShown(); } catch (e) {}
                log('  pos=' + it.pos + ' top=' + t + ' bottom=' + b +
                    ' h=' + h + ' shown=' + s);
            });
        } catch (e) { loge('dumpRv: ' + e); }
    });
}

function probe() {
    Ui.post(function () {
        var r = Ui.root();
        if (!r) { logw('无根视图'); return; }
        log(Ui.tree(r));
    });
}

function manualRefresh() {
    lastInjectSig = '';
    scheduleRefresh();
}

log('提示：dumpSongs() 看数据 / dumpRv() 看可见项 / probe() 看界面 / manualRefresh() 重试');
