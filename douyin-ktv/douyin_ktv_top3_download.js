/**
 * 抖音 KTV 点播列表探针 · v11
 * ════════════════════════════════════════════════════════════════
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)
 * 环境：QuickHook (QuickJS)
 *
 * 功能（只有两件事）
 *   ① 进入 com.ss.android.ugc.aweme.live.LivePlayActivity 后，
 *      在 com.ss.android.ugc.aweme:id/eas (0x7f0a20ce) 旁边
 *      挂一个测试按钮「打印列表」
 *   ② 点击按钮 → 拿到点播（已点）列表 → 逐首打印完整信息
 *      歌名 / 歌手 / music_id / 6 条音轨的 URL + 文件名
 *
 * ────────────────────────────────────────────────────────────────
 * 音轨取值链路（反编译确认，见 docs/douyin-ktv-notes.md）
 *
 *   MusicPanel.LIZ : KtvMusic
 *     TC()  → AudioInfo(伴奏)   ┐
 *     WC()  → AudioInfo(全轨)   ├ LX/0FTP 的 6 个槽位
 *     sD()  → String            │ 各自从不同字段取 URL
 *     iD()  → String            │
 *     aD()  → List<String>      ┘
 *
 *   AudioInfo (LX/09qV)
 *     MC() → meta_url        真正的下载地址
 *     KC() → meta_file_hash  文件名（无扩展名）
 *     LC() → meta_audio_id
 *
 *   保存路径 = LX/0FKH.LIZ() + "/musicPack/" + musicId + "/" + 音轨 + "/" + fileName
 * ────────────────────────────────────────────────────────────────
 *
 * ★★ 三条必须遵守的铁律（前 10 个版本踩过的坑）★★
 *   1. Hook 回调里【绝对不能调用任何 Ui.*】，包括 Ui.post。
 *      此时主线程被 Hook 占用，Ui.post 会同步执行并抛
 *      IllegalStateException: 主线程正被 Hook 回调占用。
 *      正确做法：回调里只置标志/存对象，交给 postToMain（Handler.post）消费。
 *
 *   2. LIZJ(List) 拿到的元素是 QuickHook 降级代理 {@,h,c,s}，
 *      没有 $get / 没有字段。必须用 Java.ref(proxy) / Java.fromHandle(h,cls)
 *      还原成真句柄后才能反射。
 *
 *   3. music_id 是 19 位 long，JS number 只有 53 位精度，
 *      直接 String() 会变 6.85e18。必须从 $str() 文本正则提取。
 * ════════════════════════════════════════════════════════════════
 */

var BUILD = 'v11-list-probe';

var CFG = {
    debug: true,
    btnTag: 'qh_print_list_btn',
    btnText: '打印列表',

    /** 找 eas 的重试次数 × 间隔（首次进入直播间时面板可能还没 inflate） */
    retryTimes: 30,
    retryDelay: 500,

    /** 最多打印多少首 */
    maxPrint: 50,

    /** 第一首额外打印全部字段（调试用，很啰嗦） */
    deepFirst: false
};

/* ============ 资源 id（反编译确认） ============ */
var ID_EAS = 2131370190;          // 0x7f0a20ce  TextView「点歌」  RCOV 字段 f
var ID_EAS_PARENT = 2131370192;   // 0x7f0a20d0  ConstraintLayout  RCOV 字段 g
var ID_LIST_RV = 2131404728;      // 0x7f0aa7b8  已点列表 RecyclerView  PlayListContainerView 字段 k
var ID_TAB_HOST = 2131404503;     // 0x7f0aa6d7  页签右侧空 FrameLayout  mM
var ID_ITEM_FAV = 2131404691;     // 0x7f0aa793  item 内「收藏」TextView

var LIVE_ACT = 'com.ss.android.ugc.aweme.live.LivePlayActivity';
var PLAYLIST_CLS = 'com.bytedance.android.livesdk.ktvimpl.base.karaokestation.ktvmode.view.secondleveltab.PlayListContainerView';
var RCOV_CLS = 'com.bytedance.android.livesdk.ktvimpl.realtimechorus.RealTimeChorusOperateView';
var BINDER_CLS = 'X.0FZs';        // 已点列表 item binder

/* ============ 日志 ============ */
function d() {
    if (CFG.debug !== false) { try { logd.apply(null, arguments); } catch (e) {} }
}
function L(s) { try { log(s); } catch (e) {} }
function W(s) { try { logw(s); } catch (e) { L('[W] ' + s); } }
function E(s) { try { loge(s); } catch (e) { L('[E] ' + s); } }
function I(s) { try { logi(s); } catch (e) { L(s); } }

L('╔═══════════════════════════════════════════╗');
L('║ KTV 探针 ' + BUILD);
L('║ 目标：LivePlayActivity → eas 旁 → 打印列表');
L('╚═══════════════════════════════════════════╝');

/* ================================================================
 * 一、主线程调度（唯一安全的跨线程手段）
 * ================================================================ */
var _handler = null;
var _handlerTried = false;

function getHandler() {
    if (_handlerTried) return _handler;
    _handlerTried = true;
    try {
        var Looper = Java.use('android.os.Looper');
        var Handler = Java.use('android.os.Handler');
        _handler = Handler.$new(Looper.getMainLooper());
        I('Handler 就绪');
    } catch (e) {
        E('创建 Handler 失败: ' + e);
    }
    return _handler;
}

/** 用 Java Runnable 把任务真正塞进主线程消息队列 */
function postToMain(fn) {
    var h = getHandler();
    if (h) {
        try {
            var R = Java.use('java.lang.Runnable');
            h.post(R.$new({ run: fn }));
            return true;
        } catch (e) {
            d('Runnable.$new 失败: ' + e);
        }
        try {
            var R2 = Java.use('java.lang.Runnable');
            var Cls = Java.registerClass({
                name: 'com.qh.KtvRunner' + (new Date().getTime()),
                implements: [R2],
                methods: { run: fn }
            });
            h.post(Cls.$new());
            return true;
        } catch (e2) {
            d('registerClass 失败: ' + e2);
        }
    }
    try { Ui.post(fn); return true; } catch (e3) {
        E('postToMain 全部失败: ' + e3);
        return false;
    }
}

function postDelayed(fn, ms) {
    var h = getHandler();
    if (h) {
        try {
            var R = Java.use('java.lang.Runnable');
            h.postDelayed(R.$new({ run: fn }), ms);
            return true;
        } catch (e) {}
        try {
            var R2 = Java.use('java.lang.Runnable');
            var Cls = Java.registerClass({
                name: 'com.qh.KtvDelay' + (new Date().getTime()),
                implements: [R2],
                methods: { run: fn }
            });
            h.postDelayed(Cls.$new(), ms);
            return true;
        } catch (e2) {}
    }
    try { Ui.post(fn); return true; } catch (e3) { return false; }
}

/* ================================================================
 * 二、句柄 / 反射工具
 *    QuickHook 的 Java 对象可能是三种形态：
 *      · 真句柄（有 $get / 方法可调）
 *      · 降级代理 {@, h, c, s}（只有句柄 id 和类名）
 *      · 纯 JS 对象
 *    下面统一处理。
 * ================================================================ */

/** 把任意形态还原成可操作的 Java 句柄 */
function resolveHandle(x) {
    if (!x) return null;

    // 已经是可用句柄
    try { if (typeof x.$get === 'function' || typeof x.$call === 'function') return x; } catch (e) {}

    var h = null, cls = '';
    try { h = x.h; } catch (e) {}
    try { cls = String(x.c || ''); } catch (e) {}

    if (typeof Java.fromHandle === 'function' && h !== undefined && h !== null) {
        try { var a = Java.fromHandle(h, cls); if (a) return a; } catch (e) {}
    }
    if (typeof Java.ref === 'function') {
        try { var b = Java.ref(x); if (b && b !== x) return b; } catch (e) {}
        if (h !== undefined && h !== null) {
            try { var c = Java.ref(h); if (c && c !== h) return c; } catch (e) {}
        }
    }
    return x;
}

/** 读字段：先 $get，再 $keys，最后 Java 反射走父类链 */
function getField(obj, name) {
    if (!obj) return null;
    obj = resolveHandle(obj);

    try {
        if (typeof obj.$get === 'function') {
            var v = obj.$get(name);
            if (v !== undefined && v !== null) return v;
        }
    } catch (e) {}
    try {
        var v2 = obj[name];
        if (v2 !== undefined && v2 !== null && typeof v2 !== 'function') return v2;
    } catch (e) {}

    // Java 反射
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

function jarr(args) {
    try {
        if (typeof Java.array === 'function') return Java.array('java.lang.Object', args);
    } catch (e) {}
    return args;
}

/** 调方法：直接调优先，失败再走反射 */
function invoke(obj, name, args) {
    if (!obj) return undefined;
    obj = resolveHandle(obj);
    args = args || [];

    try {
        var fn = obj[name];
        if (typeof fn === 'function') {
            var r = fn.apply(obj, args);
            if (r !== undefined) return r;
        }
    } catch (e) { d('invoke 直调 ' + name + ' 失败: ' + e); }

    try {
        if (typeof obj.$call === 'function') {
            var r2 = obj.$call(name, args);
            if (r2 !== undefined) return r2;
        }
    } catch (e) {}

    // 反射
    try {
        var c = obj.getClass();
        var guard = 0;
        while (c && guard++ < 12) {
            var ms = null;
            try { ms = c.getDeclaredMethods(); } catch (e) {}
            if (ms) {
                for (var i = 0; i < ms.length; i++) {
                    var m = ms[i];
                    if (String(m.getName()) !== String(name)) continue;
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
    return undefined;
}

/** 类名（短名） */
function clsName(obj) {
    if (!obj) return '';
    try {
        var c = obj.getClass();
        if (c) return String(c.getName());
    } catch (e) {}
    try { return String(obj.c || ''); } catch (e) {}
    return '';
}

function str(v) {
    if (v === null || v === undefined) return '';
    try {
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v.$str === 'function') return String(v.$str());
        return String(v);
    } catch (e) { return ''; }
}

/* ---------- java.util.List 适配 ---------- */
function listSize(l) {
    if (!l) return 0;
    l = resolveHandle(l);
    try { var n = l.size(); if (typeof n === 'number') return n; } catch (e) {}
    try { if (l.length !== undefined && typeof l.length === 'number') return l.length; } catch (e) {}
    var n2 = invoke(l, 'size');
    if (typeof n2 === 'number') return n2;
    return 0;
}

function listAt(l, i) {
    if (!l) return null;
    l = resolveHandle(l);
    try { var v = l.get(i); if (v !== undefined && v !== null) return v; } catch (e) {}
    try { if (l[i] !== undefined) return l[i]; } catch (e) {}
    try { var iv = Java.use('java.lang.Integer').$new(i); return invoke(l, 'get', [iv]); } catch (e) {}
    return null;
}

function listToArray(l) {
    var out = [];
    var n = listSize(l);
    for (var i = 0; i < n; i++) out.push(listAt(l, i));
    return out;
}

/* ================================================================
 * 三、状态
 * ================================================================ */
var activity = null;        // LivePlayActivity 实例
var easView = null;         // eas TextView
var hostView = null;        // eas 的父容器（0x7f0a20d0）
var btnEl = null;           // 挂上去的按钮 Ui 元素
var mounted = false;
var mounting = false;

var lastList = null;        // Hook LIZJ 捕获的 List<MusicPanel>
var lastListFrom = '';
var listRv = null;          // 已点列表 RecyclerView
var lastPanels = null;      // onBindViewHolder 抓到的最新 item

/* ================================================================
 * 四、控件查找
 * ================================================================ */

/** 递归遍历 View 树 */
function walk(view, depth, visitor) {
    if (!view || depth > 60) return;
    try { visitor(view, depth); } catch (e) {}
    var n = 0;
    try { n = view.getChildCount(); } catch (e) { return; }
    for (var i = 0; i < n; i++) {
        var c = null;
        try { c = view.getChildAt(i); } catch (e) {}
        if (c) walk(c, depth + 1, visitor);
    }
}

/** 按 id 找 View（activity.findViewById 优先，失败再遍历） */
function findById(rootView, id) {
    if (!rootView) return null;
    try {
        var v = rootView.findViewById(id);
        if (v) return v;
    } catch (e) {}
    return findByIdSlow(rootView, id);
}

function findByIdSlow(rootView, id) {
    var hit = null;
    walk(rootView, 0, function (v) {
        if (hit) return;
        try { if (v.getId() === id) hit = v; } catch (e) {}
    });
    return hit;
}

/** 按类名子串找 View */
function findByClass(rootView, keyword) {
    var hit = null;
    walk(rootView, 0, function (v) {
        if (hit) return;
        var cn = clsName(v);
        if (cn && cn.indexOf(keyword) >= 0) hit = v;
    });
    return hit;
}

/** 当前可用的根 View */
function rootView() {
    if (activity) {
        try {
            var decor = activity.getWindow().getDecorView();
            if (decor) return decor;
        } catch (e) {}
        try { var cv = activity.getWindow().getDecorView().getRootView(); if (cv) return cv; } catch (e) {}
    }
    // 退到 Ui 层
    try {
        var r = Ui.root();
        if (r && typeof r.$handle !== 'undefined') {
            var hv = null;
            try { hv = Java.ref(r.$handle); } catch (e) {}
            if (hv) return hv;
        }
    } catch (e) {}
    return null;
}

/* ================================================================
 * 五、挂按钮
 * ================================================================ */

/** Ui 元素 → Java View */
function uiToView(el) {
    if (!el) return null;
    try {
        var h = el.$handle;
        if (typeof Java.ref === 'function' && h !== undefined) {
            var v = Java.ref(h);
            if (v) return v;
        }
    } catch (e) {}
    try {
        if (typeof Java.fromHandle === 'function' && el.$handle !== undefined) {
            var v2 = Java.fromHandle(el.$handle, 'android.view.View');
            if (v2) return v2;
        }
    } catch (e) {}
    return null;
}

/** 拿不到 activity 时，用 Ui 层按文字找「点歌」 */
function findEasByText() {
    try {
        var rootUi = Ui.root();
        if (!rootUi) return null;
        var arr = asArray(Ui.find(rootUi, { text: '点歌' }));
        for (var i = 0; i < arr.length; i++) {
            var t = '';
            try { t = String(Ui.text(arr[i]) || ''); } catch (e) {}
            if (t.trim() !== '点歌') continue;
            var v = uiToView(arr[i]);
            if (v) { d('按文字找到「点歌」View'); return v; }
        }
    } catch (e) {}
    return null;
}

/** 在 eas 旁边插按钮（只在主线程空闲时调用） */
function tryMount(attempt) {
    attempt = attempt || 0;
    if (mounted || mounting) return;
    mounting = true;

    try {
        var root = rootView();

        // ① eas：优先在全窗口里找；找不到但已有父容器时，在父容器里找
        if (!easView) {
            if (root) easView = findById(root, ID_EAS);
            if (!easView && hostView) easView = findByIdSlow(hostView, ID_EAS);
        }
        // ② 父容器：eas.getParent() 最准
        if (!hostView && easView) {
            try { hostView = easView.getParent(); } catch (e) {}
        }
        if (!hostView && root) {
            try { hostView = findById(root, ID_EAS_PARENT); } catch (e) {}
        }
        // ③ activity 拿不到时的兜底：按「点歌」文字定位
        if (!easView) easView = findEasByText();
        if (!hostView && easView) {
            try { hostView = easView.getParent(); } catch (e) {}
        }

        if (!hostView && !easView) {
            mounting = false;
            return retryMount(attempt, '还没找到 eas(0x7f0a20ce)，根=' + (root ? '有' : '无'));
        }

        // ③ 已挂过？
        var hostUi = null;
        if (hostView) { try { hostUi = Ui.root(hostView); } catch (e) {} }
        if (!hostUi && easView) {
            try {
                var p = easView.getParent();
                if (p) { hostView = p; hostUi = Ui.root(p); }
            } catch (e) {}
        }
        if (!hostUi) {
            mounting = false;
            return retryMount(attempt, 'Ui.root(父容器) 返回空');
        }

        var exist = null;
        var existArr = [];
        try { exist = Ui.find(hostUi, { desc: CFG.btnTag }); existArr = asArray(exist); } catch (e) {}
        if (existArr.length > 0) {
            // 脚本热重载后旧按钮的 onClick 指向旧作用域，必须移除重建，
            // 否则点了没反应。移除失败就退回复用。
            var removed = false;
            try { Ui.remove(existArr[0]); removed = true; } catch (e) {}
            if (!removed) {
                btnEl = existArr[0];
                mounted = true;
                mounting = false;
                I('按钮已存在（无法移除，复用旧的）');
                return;
            }
            d('移除旧按钮，重建');
        }

        // ④ 创建并插入
        var btn = Ui.create('button', CFG.btnText);
        try { btn.setContentDescription(CFG.btnTag); } catch (e) { d('setContentDescription 失败'); }
        try { btn.setTextSize(11); } catch (e) {}
        try { btn.setPadding(24, 8, 24, 8); } catch (e) {}
        var placed = false;

        // 优先挂在 eas 后面（视觉上「旁边」）
        try {
            var easUi = Ui.root(easView);
            if (easUi) {
                Ui.insert(easUi, btn, 'after');
                placed = true;
                d('按钮插在 eas 之后');
            }
        } catch (e) { d('insert after eas 失败: ' + e); }

        if (!placed) {
            try {
                Ui.insert(hostUi, btn, 'child');
                placed = true;
                d('按钮插在父容器中');
            } catch (e2) { E('插入按钮失败: ' + e2); }
        }

        if (!placed) {
            mounting = false;
            return retryMount(attempt, '插入失败');
        }

        Ui.onClick(btn, function () {
            // 点击回调 = 主线程空闲，可以放心操作 Ui / Java
            try {
                dumpList();
            } catch (e) {
                E('打印列表异常: ' + e);
                try { Ui.alert('异常', String(e)); } catch (e2) {}
            }
        });

        btnEl = btn;
        mounted = true;
        mounting = false;
        I('★ 测试按钮已挂到 eas 旁边');

    } catch (e) {
        mounting = false;
        E('tryMount 失败: ' + e);
        retryMount(attempt, String(e));
    }
}

function retryMount(attempt, why) {
    if (attempt >= CFG.retryTimes) {
        W('挂载放弃（' + attempt + ' 次）：' + why);
        return;
    }
    d('挂载重试 #' + (attempt + 1) + '：' + why);
    postDelayed(function () { tryMount(attempt + 1); }, CFG.retryDelay);
}

function asArray(x) {
    if (!x) return [];
    if (x.length !== undefined && typeof x.length === 'number') {
        var out = [];
        for (var i = 0; i < x.length; i++) out.push(x[i]);
        return out;
    }
    if (typeof x.size === 'function') {
        var n = 0;
        try { n = x.size(); } catch (e) { return []; }
        var o2 = [];
        for (var j = 0; j < n; j++) { try { o2.push(x.get(j)); } catch (e) {} }
        return o2;
    }
    return [x];
}

/* ================================================================
 * 六、取列表 —— 多级兜底
 * ================================================================ */

/** 结果：{ list, from } */
function grabList() {
    // ① Hook 捕获的 LIZJ 参数
    if (lastList && listSize(lastList) > 0) {
        return { list: lastList, from: 'HooK ' + lastListFrom };
    }

    var root = rootView();

    // ② PlayListContainerView 的字段 d
    try {
        var plv = findByClass(root, 'PlayListContainerView');
        if (plv) {
            var dd = getField(plv, 'd');
            if (dd && listSize(dd) > 0) return { list: dd, from: 'PlayListContainerView.d' };

            // 换个思路：它的 adapter
            var ad0 = invoke(plv, 'getAdapter');
            var it0 = adapterItems(ad0);
            if (it0 && it0.length > 0) return { list: it0, from: 'PlayListContainerView.adapter' };
        }
    } catch (e) { d('路径② 失败: ' + e); }

    // ③ RecyclerView(zj+) 的 adapter
    try {
        var rv = listRv || findById(root, ID_LIST_RV);
        if (rv) {
            listRv = rv;
            var ad = invoke(rv, 'getAdapter');
            var it = adapterItems(ad);
            if (it && it.length > 0) return { list: it, from: 'RecyclerView(zj+).adapter' };
        }
    } catch (e) { d('路径③ 失败: ' + e); }

    // ④ 全树扫 RecyclerView，谁的 adapter 有数据就用谁
    try {
        var found = null;
        walk(root, 0, function (v) {
            if (found) return;
            var cn = clsName(v);
            if (cn.indexOf('RecyclerView') < 0) return;
            var ad2 = invoke(v, 'getAdapter');
            var it2 = adapterItems(ad2);
            if (it2 && it2.length > 0) {
                found = it2;
                listRv = v;
            }
        });
        if (found) return { list: found, from: '全树 RecyclerView' };
    } catch (e) {}

    return { list: null, from: '' };
}

/** 从 adapter 里挖 items（不同实现字段名不同，直接扫 List 字段） */
function adapterItems(ad) {
    if (!ad) return null;
    ad = resolveHandle(ad);

    // 常见 getter
    var getters = ['getItems', 'getData', 'getList', 'getDataList'];
    for (var i = 0; i < getters.length; i++) {
        var v = invoke(ad, getters[i]);
        if (v && listSize(v) > 0) return v;
    }
    // 常见字段
    var names = ['items', 'mItems', 'data', 'mData', 'list', 'mList', 'datas'];
    for (var j = 0; j < names.length; j++) {
        var f = getField(ad, names[j]);
        if (f && listSize(f) > 0) return f;
    }
    // 扫所有 List 类型字段
    try {
        var c = ad.getClass();
        var guard = 0;
        while (c && guard++ < 8) {
            var fs = null;
            try { fs = c.getDeclaredFields(); } catch (e) {}
            if (fs) {
                for (var k = 0; k < fs.length; k++) {
                    var fn = String(fs[k].getName());
                    var tn = '';
                    try { tn = String(fs[k].getType().getName()); } catch (e) {}
                    if (tn.indexOf('List') < 0 && tn.indexOf('Collection') < 0) continue;
                    try {
                        fs[k].setAccessible(true);
                        var fv = fs[k].get(ad);
                        if (fv && listSize(fv) > 0) { d('adapter 字段命中: ' + fn + ' (' + tn + ')'); return fv; }
                    } catch (e) {}
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) {}
    return null;
}

/* ================================================================
 * 七、解析单首
 * ================================================================ */

/** MusicPanel → KtvMusic */
function getMusic(panel) {
    if (!panel) return null;

    // 字段 LIZ（反编译确认）
    var m = getField(panel, 'LIZ');
    if (m && looksLikeMusic(m)) return m;

    // 扫字段，找类型像 KtvMusic 的
    try {
        var c = resolveHandle(panel).getClass();
        var guard = 0;
        while (c && guard++ < 6) {
            var fs = null;
            try { fs = c.getDeclaredFields(); } catch (e) {}
            if (fs) {
                for (var i = 0; i < fs.length; i++) {
                    var tn = '';
                    try { tn = String(fs[i].getType().getName()); } catch (e) {}
                    if (tn.indexOf('KtvMusic') < 0 && tn.indexOf('Music') < 0) continue;
                    try {
                        fs[i].setAccessible(true);
                        var v = fs[i].get(panel);
                        if (looksLikeMusic(v)) { d('music 字段命中: ' + fs[i].getName()); return v; }
                    } catch (e) {}
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) {}
    return null;
}

function looksLikeMusic(v) {
    if (!v) return false;
    var probe = ['TC', 'WC', 'XC', 'sD'];
    for (var i = 0; i < probe.length; i++) {
        try { if (typeof v[probe[i]] === 'function') return true; } catch (e) {}
    }
    var cn = clsName(v);
    return cn.indexOf('KtvMusic') >= 0;
}

/** 从文本里抠出 19 位 id，避开 JS 精度丢失 */
function exactId(text) {
    if (!text || typeof text !== 'string') return '';
    var m = text.match(/id\s*=\s*(\d{6,})/i);
    if (m) return m[1];
    var m2 = text.match(/\b(\d{15,})\b/);
    if (m2) return m2[1];
    return '';
}

/** AudioInfo → { url, file, audioId } */
function readAudioInfo(ai) {
    var out = { url: '', file: '', audioId: '' };
    if (!ai) return out;

    var u = invoke(ai, 'MC');
    if (!u) u = getField(ai, 'meta_url');
    if (u) out.url = str(u);

    var f = invoke(ai, 'KC');
    if (!f) f = getField(ai, 'meta_file_hash');
    if (f) out.file = str(f);

    var a = invoke(ai, 'LC');
    if (!a) a = getField(ai, 'meta_audio_id');
    if (a) out.audioId = str(a);

    // 兜底：从 $str 里找 URL
    if (!out.url) {
        var s = str(ai);
        var mm = s.match(/https?:\/\/[^\s"',;)]+/);
        if (mm) out.url = mm[0];
    }
    return out;
}

/** 6 个槽位 */
var SLOTS = [
    { key: 'TC', name: '伴奏   TC', type: 'audio', field: 'p' },
    { key: 'WC', name: '全轨   WC', type: 'audio', field: 'o' },
    { key: 'sD', name: '附加   sD', type: 'string', field: 'r' },
    { key: 'iD', name: '附加   iD', type: 'string', field: 'q' },
    { key: 'aD', name: '列表 aD[0]', type: 'list', field: 'i' }
];

/** 读一首歌的完整信息 */
function readSong(panel, idx) {
    var info = {
        idx: idx + 1, title: '', artist: '', musicId: '',
        slots: [], raw: null
    };

    var music = getMusic(panel);
    if (!music && looksLikeMusic(panel)) music = panel;
    info.raw = music;

    if (music) {
        // 歌名
        var t = invoke(music, 'getTitle');
        if (!t) t = invoke(music, 'fD');
        if (!t) t = getField(music, 'd');
        if (t) info.title = str(t);

        // 歌手
        var ar = getField(music, 'b');
        if (!ar) ar = invoke(music, 'YC');
        if (ar) info.artist = str(ar);

        // id：文本优先
        var mtext = str(music);
        info.musicId = exactId(mtext);
        if (!info.musicId) {
            var mid = invoke(music, 'XC');
            if (mid !== undefined && mid !== null) info.musicId = str(mid);
        }

        // 6 个槽位
        for (var i = 0; i < SLOTS.length; i++) {
            var s = SLOTS[i];
            var val = invoke(music, s.key);
            if (val === undefined || val === null) val = getField(music, s.field);

            var row = { name: s.name, url: '', file: '', extra: '' };

            if (s.type === 'audio') {
                var ai = readAudioInfo(val);
                row.url = ai.url;
                row.file = ai.file;
                row.extra = ai.audioId ? ('audioId=' + ai.audioId) : '';
            } else if (s.type === 'string') {
                row.url = str(val);
            } else if (s.type === 'list') {
                var n = listSize(val);
                if (n > 0) {
                    row.url = str(listAt(val, 0));
                    row.extra = 'len=' + n;
                }
            }
            info.slots.push(row);
        }
    }

    // 歌手兜底：排除纯数字
    if (info.artist && /^\d+(\.\d+)?[eE]?\+?\d*$/.test(info.artist.trim())) info.artist = '';

    if (!info.title) {
        var ps = str(panel);
        var mm = ps.match(/title\s*=\s*([^,)]+)/i);
        if (mm) info.title = mm[1].trim();
    }
    if (!info.musicId) info.musicId = exactId(str(panel));

    return info;
}

/* ================================================================
 * 八、打印
 * ================================================================ */
function dumpList() {
    L('');
    L('══════════════ 打印点播列表 ══════════════');

    var g = grabList();
    var list = g.list;
    var from = g.from;

    if (!list || listSize(list) === 0) {
        L('✗ 数据层没拿到列表（' + (from || '全部路径失败') + '）');
        L('  尝试从界面文字兜底…');
        var texts = uiTexts();
        L('  界面候选文本 ' + texts.length + ' 条');
        for (var x = 0; x < texts.length && x < 20; x++) L('    · ' + texts[x]);
        try {
            Ui.alert('没拿到列表',
                '数据层为空。\n\n界面候选文本 ' + texts.length + ' 条：\n'
                + texts.slice(0, 12).join('\n'));
        } catch (e) {}
        return;
    }

    var n = listSize(list);
    L('来源: ' + from + '    共 ' + n + ' 首');
    L('');

    var limit = Math.min(n, CFG.maxPrint);
    var brief = [];

    for (var i = 0; i < limit; i++) {
        var panel = listAt(list, i);
        var s = null;
        try { s = readSong(panel, i); } catch (e) { E('解析第 ' + (i + 1) + ' 首失败: ' + e); continue; }
        if (!s) continue;

        L('┌─ [' + s.idx + '] ' + (s.title || '(未取到歌名)')
            + (s.artist ? ' · ' + s.artist : ''));
        L('│  musicId = ' + (s.musicId || '?'));
        for (var k = 0; k < s.slots.length; k++) {
            var row = s.slots[k];
            var mark = row.url ? '✔' : '·';
            L('│  ' + mark + ' ' + row.name + '  ' + (row.url || '(空)')
                + (row.file ? '   file=' + row.file : '')
                + (row.extra ? '   ' + row.extra : ''));
        }
        L('└─');

        brief.push('[' + s.idx + '] ' + (s.title || '?')
            + (s.artist ? ' · ' + s.artist : '')
            + '  ' + (countUrl(s.slots) + '/5 有URL'));

        // 第一首深度 dump
        if (i === 0 && CFG.deepFirst && s.raw) dumpFields(s.raw, 'KtvMusic');
    }

    if (n > limit) L('… 还有 ' + (n - limit) + ' 首未打印');

    L('══════════════ 结束，共 ' + limit + ' 首 ══════════════');
    L('');

    try {
        Ui.alert('点播列表 ' + n + ' 首（来源 ' + from + '）',
            brief.slice(0, 10).join('\n') + (n > 10 ? '\n…' : ''));
    } catch (e) {}
}

function countUrl(slots) {
    var c = 0;
    for (var i = 0; i < slots.length; i++) if (slots[i].url) c++;
    return c;
}

/** 界面文字兜底 */
function uiTexts() {
    var out = [];
    try {
        var root = Ui.root();
        var arr = asArray(Ui.find(root, { cls: 'TextView' }));
        for (var i = 0; i < arr.length; i++) {
            var t = '';
            try { t = String(Ui.text(arr[i]) || '').trim(); } catch (e) {}
            if (!t || t.length > 40) continue;
            if (/^\d+$/.test(t)) continue;
            if (/^\d{1,2}:\d{2}$/.test(t)) continue;
            out.push(t);
        }
    } catch (e) {}
    return out;
}

/** 深度打印字段（调试） */
function dumpFields(obj, tag) {
    L('    --- ' + tag + ' 字段 ---');
    try {
        var c = resolveHandle(obj).getClass();
        var guard = 0;
        while (c && guard++ < 4) {
            var fs = null;
            try { fs = c.getDeclaredFields(); } catch (e) {}
            if (fs) {
                for (var i = 0; i < fs.length; i++) {
                    var tn = '', fn = '';
                    try { tn = String(fs[i].getType().getName()); } catch (e) {}
                    try { fn = String(fs[i].getName()); } catch (e) {}
                    var vs = '';
                    try {
                        fs[i].setAccessible(true);
                        var v = fs[i].get(obj);
                        if (v === null) vs = 'null';
                        else if (typeof v === 'string') vs = v.length > 90 ? v.slice(0, 90) + '…' : v;
                        else vs = '<' + (clsName(v) || typeof v) + '>';
                    } catch (e) { vs = 'err'; }
                    L('      ' + fn + ' : ' + tn + ' = ' + vs);
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) { E('dumpFields: ' + e); }
}

/* ================================================================
 * 九、Hook 注册
 * ================================================================ */
var hooked = 0;

/* ① LivePlayActivity —— 进入直播间 */
try {
    Hook.method(LIVE_ACT, 'onCreate', ['android.os.Bundle'], function (ctx) {
        try {
            activity = ctx.this;
            mounted = false; mounting = false;
            easView = null; hostView = null;
            I('进入 LivePlayActivity');
            // 只投递，不碰 Ui
            postDelayed(function () { tryMount(0); }, 300);
            postDelayed(function () { tryMount(0); }, 1200);
        } catch (e) {}
    }, 'after');
    hooked++;
    I('Hook OK: LivePlayActivity.onCreate');
} catch (e) { E('Hook LivePlayActivity 失败: ' + e); }

/* ② onResume —— 回前台再挂一次（Activity 复用不重建时） */
try {
    Hook.method(LIVE_ACT, 'onResume', [], function (ctx) {
        try {
            activity = ctx.this;
            if (!mounted) postToMain(function () { tryMount(0); });
        } catch (e) {}
    }, 'after');
    hooked++;
    I('Hook OK: LivePlayActivity.onResume');
} catch (e) { W('Hook onResume 跳过: ' + e); }

/* ③ 列表数据更新（最早拿到 List 的地方） */
try {
    Hook.method(PLAYLIST_CLS, 'LIZJ', ['java.util.List'], function (ctx) {
        try {
            var l = ctx.args[0];
            if (!l) return;
            lastList = l;
            lastListFrom = 'LIZJ';
            d('LIZJ 捕获列表，长度 ' + listSize(l));
            if (!mounted) postToMain(function () { tryMount(0); });
        } catch (e) {}
    }, 'after');
    hooked++;
    I('Hook OK: PlayListContainerView.LIZJ');
} catch (e) { E('Hook LIZJ 失败: ' + e); }

/* ④ 列表创建 */
try {
    Hook.method(PLAYLIST_CLS, 'LIZLLL', [], function (ctx) {
        try {
            var self = ctx.this;
            var dField = getField(self, 'd');
            if (dField && listSize(dField) > 0) {
                lastList = dField;
                lastListFrom = 'LIZLLL.d';
                d('LIZLLL 读到字段 d，长度 ' + listSize(dField));
            }
            var rv = null;
            try { rv = invoke(self, 'getSelectedListRv'); } catch (e) {}
            if (rv) listRv = rv;
            if (!mounted) postToMain(function () { tryMount(0); });
        } catch (e) {}
    }, 'after');
    hooked++;
    I('Hook OK: PlayListContainerView.LIZLLL');
} catch (e) { W('Hook LIZLLL 跳过: ' + e); }

/* ⑤ RecyclerView.onLayout —— 记住 zj+ 实例 */
try {
    Hook.method('androidx.recyclerview.widget.RecyclerView', 'onLayout',
        ['boolean', 'int', 'int', 'int', 'int'], function (ctx) {
            try {
                var v = ctx.this;
                var id = -1;
                try { id = v.getId(); } catch (e) {}
                if (id !== ID_LIST_RV) return;
                listRv = v;
                if (!mounted) postToMain(function () { tryMount(0); });
            } catch (e) {}
        }, 'after');
    hooked++;
    I('Hook OK: RecyclerView.onLayout（zj+）');
} catch (e) { W('Hook onLayout 跳过: ' + e); }

/* ⑥ item 绑定 —— 兜底留一份最新的 MusicPanel */
try {
    Hook.method(BINDER_CLS, 'onBindViewHolder',
        ['androidx.recyclerview.widget.RecyclerView$ViewHolder', 'java.lang.Object'],
        function (ctx) {
            try {
                var item = ctx.args[1];
                if (item) lastPanels = item;
            } catch (e) {}
        }, 'after');
    hooked++;
    I('Hook OK: X.0FZs.onBindViewHolder');
} catch (e) { W('Hook onBindViewHolder 跳过: ' + e); }

/* ⑦ RealTimeChorusOperateView 构造 —— 面板被 open 时会走这里，重新尝试挂载 */
try {
    Hook.all(RCOV_CLS, '<init>', function (ctx) {
        try {
            var self = ctx.this;
            var g = getField(self, 'g');
            if (g) {
                hostView = g;
                mounted = false;
            }
        } catch (e) {}
        postDelayed(function () { tryMount(0); }, 200);
    }, 'after');
    hooked++;
    I('Hook OK: RealTimeChorusOperateView.<init>');
} catch (e) { W('Hook RCOV.<init> 跳过: ' + e); }

I('=== 加载完成，' + hooked + ' 个 Hook ===');

/* 启动时先试一次（脚本可能在直播间里热加载） */
postDelayed(function () { tryMount(0); }, 500);

/* ================================================================
 * 十、手动入口（日志页 console 里可调）
 * ================================================================ */
function printList() { dumpList(); }
function mountNow() { mounted = false; mounting = false; postToMain(function () { tryMount(0); }); }
function whereAmI() {
    L('activity = ' + (activity ? clsName(activity) : 'null'));
    L('easView  = ' + (easView ? clsName(easView) + ' id=' + safeId(easView) : 'null'));
    L('hostView = ' + (hostView ? clsName(hostView) : 'null'));
    L('mounted  = ' + mounted);
    L('listRv   = ' + (listRv ? '有' : '无'));
    L('lastList = ' + (lastList ? listSize(lastList) + ' 首 (' + lastListFrom + ')' : '无'));
}
function safeId(v) { try { return v.getId(); } catch (e) { return '?'; } }
