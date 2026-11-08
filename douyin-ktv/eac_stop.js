/**
 * eac_stop.js —— 把「加入合唱」圆环改成「加入 / 停止」双态按钮
 * ════════════════════════════════════════════════════════════════
 * 目标：抖音 41.0.0 (com.ss.android.ugc.aweme)  ·  QuickHook
 *
 * ── 目标控件 ──────────────────────────────────────────────────
 *   id = 0x7f0a20be  (eac)
 *   类 = com.bytedance.android.livesdk.ktvimpl.realtimechorus
 *          .RealtimeChorusProgressImageView  (extends FrameLayout)
 *   归属 = RealTimeChorusOperateView 的字段 l
 *   布局 = r/6mm.xml (0x7f0d4273)
 *
 *   ┌ ConstraintLayout (root)
 *   ├── eac  圆环 ← 本次改造目标（「加入合唱」）
 *   └── eau  ConstraintLayout
 *        ├── eas  TextView "加入合唱"
 *        ├── 0x7f0a20d1
 *        └── 0x7f0a20d2
 *
 * ── 为什么点一次就点不动 ──────────────────────────────────────
 *   点击分发在 RCOV.LLLLLLL(self, view)：
 *
 *     int status = this.n;              // joinBtnStatus
 *     if (status == 1) goto JOIN;       // 已加入 → 加入分支
 *     if (status != 4) return;          // ★ 其他状态直接返回
 *     ...                               // n==4 → 退出(leave)分支
 *
 *   加入成功后 n 变成别的值（或 e=true），于是后续点击全被 return 吞掉。
 *
 * ── 本脚本怎么做 ──────────────────────────────────────────────
 *   接管 eac 的 OnClickListener，自己维护两态：
 *
 *     未加入  →  点一下：走原生加入逻辑，按钮文字变「停止」
 *     已加入  →  点一下：
 *                  ① X.0FT5.LIZJ()   停掉所有下载
 *                       · LJIIJ.dispose()      停 1s 轮询
 *                       · X.0FT6.LJFF()        resetAll 6 槽位
 *                       · LJ / LJFF clear()    清队列
 *                  ② 反射把 n 置成 4（leave 分支），再调 LLLLLLL → 退合唱
 *                  ③ 文字还原「加入合唱」
 *
 * ── 三条铁律 ──────────────────────────────────────────────────
 *   1. Hook 回调里不调 Ui.*（含 Ui.post），只置标志 / 记状态
 *   2. Hook 回调里调 Java 是可以的（X.0FT5.LIZJ() 就是纯 Java）
 *   3. 改 View 属性能不用 Ui 就不用，直接走 Java setText / setOnClickListener
 * ════════════════════════════════════════════════════════════════
 */

var BUILD = 'eac1';

var CFG = {
    debug: true,

    /** 点第二次时先停下载再退合唱 */
    stopDownloadFirst: true,

    /** 覆盖原生 listener（否则原生只认 n==1/4） */
    overrideListener: true,

    /** 手动防抖（覆盖 listener 会绕过原生 DebounceOnClickListener） */
    clickDebounceMs: 600,

    /**
     * 退合唱前要把 joinBtnStatus(n) 设成的值。
     *
     * LLLLLLL 开头的闸门（字节码 0x00~0x0e，偏移单位 code unit）：
     *   0x000c  if-eq v1, 1, +0c8h   → 字节目标 0x0c + 0xc8*2 = 0x019c（join 段，n==1）
     *   0x0014  if-ne v1, 4, +0bch   → n != 4 跳走（吞掉），否则落到 0x0018（leave 段，n==4）
     *
     * 所以 n==1 走 join、n==4 走 leave。退合唱必须先把 n 设成 4。
     */
    leaveStatus: 4
};

/* ============ 常量 ============ */
var ID_EAC = 2131370174;          // 0x7f0a20be
var RCOV = 'com.bytedance.android.livesdk.ktvimpl.realtimechorus.RealTimeChorusOperateView';
var PROGRESS_VIEW = 'com.bytedance.android.livesdk.ktvimpl.realtimechorus.RealtimeChorusProgressImageView';
var FT5 = 'X.0FT5';               // KtvMusicManager 单例（下载器总控）
var FT6 = 'X.0FT6';               // MusicPanelDownloader（6 槽位）

function L(s) { try { log(String(s)); } catch (e) {} }
function d(s) { if (CFG.debug !== false) L(s); }
function W(s) { try { logw(String(s)); } catch (e) { L('[W] ' + s); } }
function E(s) { try { loge(String(s)); } catch (e) { L('[E] ' + s); } }

L('╔═══════════════════════════════════════════════╗');
L('║ eac_stop.js  ' + BUILD);
L('║ eac(0x7f0a20be) → 加入/停止 双态');
L('╚═══════════════════════════════════════════════╝');

/* ================================================================
 * 一、主线程调度
 * ================================================================ */
var _handler = null, _tried = false;

function getHandler() {
    if (_tried) return _handler;
    _tried = true;
    try {
        var Looper = Java.use('android.os.Looper');
        var Handler = Java.use('android.os.Handler');
        _handler = Handler.$new(Looper.getMainLooper());
        I_('Handler 就绪');
    } catch (e) { E('Handler 创建失败: ' + e); }
    return _handler;
}
function I_(s) { try { logi(String(s)); } catch (e) { L(s); } }

function postToMain(fn) {
    var h = getHandler();
    if (h) {
        try {
            var R = Java.use('java.lang.Runnable');
            h.post(R.$new({ run: fn }));
            return true;
        } catch (e) { d('Runnable.$new 失败: ' + e); }
        try {
            var R2 = Java.use('java.lang.Runnable');
            var Cls = Java.registerClass({
                name: 'com.qh.EacRunner' + (new Date().getTime()),
                implements: [R2],
                methods: { run: fn }
            });
            h.post(Cls.$new());
            return true;
        } catch (e2) { d('registerClass 失败: ' + e2); }
    }
    try { Ui.post(fn); return true; } catch (e3) { E('postToMain 失败: ' + e3); return false; }
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
                name: 'com.qh.EacDelay' + (new Date().getTime()),
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
 * 二、反射工具
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

function clsName(o) {
    if (!o) return '';
    try { var c = o.getClass(); if (c) return String(c.getName()); } catch (e) {}
    try { if (o.c) return String(o.c); } catch (e) {}
    return '';
}

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

function getF(obj, name) {
    if (!obj) return null;
    obj = resolveHandle(obj);
    try {
        if (typeof obj.$get === 'function') {
            var v = obj.$get(name);
            if (v !== undefined) return v;
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

function setInt(obj, name, val) {
    if (!obj) return false;
    try {
        var c = resolveHandle(obj).getClass();
        var guard = 0;
        while (c && guard++ < 12) {
            try {
                var f = c.getDeclaredField(name);
                f.setAccessible(true);
                var I = Java.use('java.lang.Integer');
                f.setInt(obj, val);
                return true;
            } catch (e) {
                try {
                    var f2 = c.getDeclaredField(name);
                    f2.setAccessible(true);
                    f2.set(obj, Java.use('java.lang.Integer').$new(val));
                    return true;
                } catch (e2) {}
            }
            c = c.getSuperclass();
        }
    } catch (e) { d('setInt(' + name + ') 失败: ' + e); }
    return false;
}

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
                    var m = ms[i], mn = '';
                    try { mn = String(m.getName()); } catch (e) { continue; }
                    if (mn !== String(name)) continue;
                    try {
                        if (m.getParameterTypes().length !== args.length) continue;
                        m.setAccessible(true);
                        try { return m.invoke(obj); } catch (e) {}
                    } catch (e) {}
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) {}
    return null;
}

/* ================================================================
 * 三、状态
 * ================================================================ */
var rcov = null;          // RealTimeChorusOperateView 实例
var eacView = null;       // eac 圆环
var installed = false;
var lastClickAt = 0;
var stopDoneAt = 0;       // 上次停止时间，用于 UI 提示
var stats = { clicks: 0, joins: 0, stops: 0, leaves: 0 };

/* ================================================================
 * 四、停下载 —— X.0FT5.LIZJ()
 * ================================================================ */

/** 拿 X.0FT5 单例（静态字段 LIZ） */
function getFt5() {
    try {
        var C = Java.use(FT5);
        try { var v = C.LIZ; if (v) return v; } catch (e) {}
        try { if (typeof C.$get === 'function') { var v2 = C.$get('LIZ'); if (v2) return v2; } } catch (e) {}
        // 反射静态字段
        try {
            var cls = C.class;
            var f = cls.getDeclaredField('LIZ');
            f.setAccessible(true);
            var v3 = f.get(null);
            if (v3) return v3;
        } catch (e) { d('读 X.0FT5.LIZ 失败: ' + e); }
    } catch (e) { E('Java.use(X.0FT5) 失败: ' + e); }
    return null;
}

/**
 * 停止全部下载。
 * X.0FT5.LIZJ() 做的事：
 *   LJIIJ.isDisposed() → dispose()      停 1s 轮询定时器
 *   LIZLLL(FT6).LJFF()                  resetAll：6 槽位清零
 *   LJ.clear() / LJFF.clear()           清 pending / default 队列
 *   LJII(FT6).LJFF()
 */
function stopAllDownloads() {
    var inst = getFt5();
    if (!inst) {
        W('拿不到 X.0FT5 单例，改用 X.0FT6 逐槽位 reset');
        return stopByFt6();
    }
    try {
        inst.LIZJ();
        I_('★ X.0FT5.LIZJ() 已调用（全局停止）');
        return true;
    } catch (e) {
        W('LIZJ() 直调失败: ' + e);
    }
    try {
        var r = call(inst, 'LIZJ');
        if (r !== null || true) { I_('★ 反射调 LIZJ() 完成'); return true; }
    } catch (e) { E('LIZJ() 反射失败: ' + e); }
    return stopByFt6();
}

/** 兜底：直接对 6 个槽位调 reset（FT6.LJFF = resetAll） */
function stopByFt6() {
    var ok = false;
    var inst = null;
    try {
        var C = Java.use(FT5);
        var m = null;
        try { m = C.LIZIZ; } catch (e) {}
        if (typeof m === 'function') inst = m.call(C);
    } catch (e) {}
    if (!inst) {
        try {
            var f5 = getFt5();
            if (f5) inst = call(f5, 'LIZIZ');
        } catch (e) {}
    }
    if (!inst) { E('拿不到 X.0FT6，停止失败'); return false; }

    try {
        inst.LJFF();
        I_('★ X.0FT6.LJFF() resetAll 已调用');
        ok = true;
    } catch (e) {
        try { call(inst, 'LJFF'); ok = true; I_('★ 反射 resetAll 完成'); } catch (e2) { E('resetAll 失败: ' + e2); }
    }
    return ok;
}

/* ================================================================
 * 五、按钮文字
 * ================================================================ */

/** eac.setText(String) —— 内部转发给字段 b(TextView) */
function setEacText(text) {
    if (!eacView) return false;
    try {
        eacView.setText(String(text));
        return true;
    } catch (e) { d('setText 直调失败: ' + e); }
    try {
        call(eacView, 'setText', [String(text)]);
        return true;
    } catch (e2) { d('setText 反射失败: ' + e2); }
    // 兜底：直接找内部 TextView
    try {
        var tv = getF(eacView, 'b');
        if (tv) { tv.setText(String(text)); return true; }
    } catch (e3) {}
    return false;
}

function currentEacText() {
    if (!eacView) return '';
    try {
        var tv = getF(eacView, 'b');
        if (tv) return str(call(tv, 'getText'));
    } catch (e) {}
    return '';
}

/* ================================================================
 * 六、状态判断
 * ================================================================ */

/** 是否已加入合唱 —— RCOV 字段 e，setJoiningChorus() 写的就是它 */
function isJoining() {
    if (!rcov) return false;
    try {
        var v = getF(rcov, 'e');
        return v === true;
    } catch (e) { return false; }
}

/** joinBtnStatus —— RCOV 字段 n */
function joinStatus() {
    if (!rcov) return -1;
    var v = getF(rcov, 'n');
    if (v === null || v === undefined) return -1;
    var n = parseInt(str(v), 10);
    return isNaN(n) ? -1 : n;
}

/* ================================================================
 * 七、点击处理
 * ================================================================ */

/**
 * 接管后的点击入口。
 * 运行在主线程，且【不在 Hook 上下文】——可以放心调 Java / 改 View。
 */
function onEacClick(view) {
    stats.clicks++;

    var now = new Date().getTime();
    if (now - lastClickAt < CFG.clickDebounceMs) {
        d('防抖拦截');
        return;
    }
    lastClickAt = now;

    var joining = isJoining();
    var n = joinStatus();
    L('▸ eac 点击  joining=' + joining + '  n=' + n);

    if (!joining) {
        /* ── 未加入：走原生加入 ── */
        stats.joins++;
        L('  → 加入合唱');
        var ok = callNative(view);
        if (ok) setEacText('停止');
        else W('原生加入调用失败');
        return;
    }

    /* ── 已加入：先停下载，再退合唱 ── */
    stats.stops++;
    L('  → 停止：先停下载');

    if (CFG.stopDownloadFirst) {
        var s = stopAllDownloads();
        L('    停下载: ' + (s ? '成功' : '失败'));
    }

    setEacText('停止中…');

    L('  → 退合唱');
    var left = doLeave(view);
    L('    退合唱: ' + (left ? '已触发' : '失败'));

    // 3 秒后若没变化，恢复文字提示用户
    postDelayed(function () {
        if (isJoining()) setEacText('停止');
        else setEacText('加入合唱');
    }, 3000);
}

/** 调原生分发 RCOV.LLLLLLL(self, view) */
function callNative(view) {
    if (!rcov) return false;
    var v = view || eacView;
    try {
        var fn = rcov.LLLLLLL;
        if (typeof fn === 'function') {
            fn.call(rcov, rcov, v);
            return true;
        }
    } catch (e) { d('LLLLLLL 直调失败: ' + e); }
    try {
        var c = rcov.getClass();
        var guard = 0;
        while (c && guard++ < 8) {
            var ms = null;
            try { ms = c.getDeclaredMethods(); } catch (e) {}
            if (ms) {
                for (var i = 0; i < ms.length; i++) {
                    if (String(ms[i].getName()) !== 'LLLLLLL') continue;
                    var ps = ms[i].getParameterTypes();
                    if (ps.length !== 2) continue;
                    ms[i].setAccessible(true);
                    try {
                        var ObjArr = Java.array('java.lang.Object', [rcov, v]);
                        ms[i].invoke(rcov, ObjArr);
                        return true;
                    } catch (e) {}
                }
            }
            c = c.getSuperclass();
        }
    } catch (e) { d('LLLLLLL 反射失败: ' + e); }
    return false;
}

/**
 * 退合唱。
 *
 * LLLLLLL 开头的状态闸门（字节码 0x0008~0x0014）：
 *
 *   0x0008  iget v1, self->n          // joinBtnStatus
 *   0x000c  const/4 v0, 1
 *   0x000e  if-eq v1, v0, +0c8h       // n == 1 → 跳进 join 段
 *   0x0012  const/4 v0, 4
 *   0x0014  if-ne v1, v0, +0bch       // n != 4 → 跳走（吞掉点击）；n==4 落到 leave 段
 *
 * leave 段（0x0018 起，直到 0x0190 return）＝ n==4 分支：
 *   0x0036  setJoiningChorus(false)
 *   0x003c  LX/0FKa.LJIIJ("exit")
 *   0x00f8  LX/0EYM.LeaveChorusBtnClicked   ← 埋点
 *   0x0176  LX/0Elx.LeaveChorus             ← 真正的退出事件
 *   0x0190  return
 *
 * join 段尾（0x019e 起）：
 *   0x019e  const-string "click btn"
 *   0x01a2  LLLLLLLLLL("click btn")
 *
 * 所以：n=1 → join，n=4 → leave。退合唱必须先把 n 设成 4。
 */
function doLeave(view) {
    if (!rcov) return false;

    var orig = joinStatus();
    var target = CFG.leaveStatus;

    d('  设 n=' + target + '（原值 ' + orig + '）');
    if (!setInt(rcov, 'n', target)) {
        W('  设 n 失败，退合唱放弃');
        if (orig >= 0) { /* 没改成就不用还原 */ }
        return false;
    }

    var ok = callNative(view);
    if (ok) {
        stats.leaves++;
        I_('  ★ 已用 n=' + target + ' 触发退合唱（LeaveChorus 段）');
        return true;
    }

    // 失败则还原，别把状态弄坏
    if (orig >= 0) setInt(rcov, 'n', orig);
    W('  退合唱失败，已还原 n=' + orig);
    return false;
}

/* ================================================================
 * 八、安装 listener
 * ================================================================ */

/** 用 Java 实现 View.OnClickListener 并挂到 eac 上 */
function installListener() {
    if (!eacView) return false;
    if (installed) return true;

    try {
        var OL = Java.use('android.view.View$OnClickListener');
        var l = OL.$new({
            onClick: function (v) {
                try { onEacClick(v); } catch (e) { E('onEacClick: ' + e); }
            }
        });
        eacView.setOnClickListener(l);
        installed = true;
        I_('★ eac 的 OnClickListener 已被接管');
        return true;
    } catch (e) {
        d('$new(OnClickListener) 失败，改用 registerClass: ' + e);
    }

    try {
        var OL2 = Java.use('android.view.View$OnClickListener');
        var Cls = Java.registerClass({
            name: 'com.qh.EacClick' + (new Date().getTime()),
            implements: [OL2],
            methods: {
                onClick: function (v) {
                    try { onEacClick(v); } catch (e) { E('onEacClick(rc): ' + e); }
                }
            }
        });
        eacView.setOnClickListener(Cls.$new());
        installed = true;
        I_('★ eac 的 OnClickListener 已被接管（registerClass）');
        return true;
    } catch (e2) {
        E('挂 OnClickListener 全部失败: ' + e2);
        return false;
    }
}

/** 等 eac 出现后挂载 */
function tryInstall(attempt) {
    attempt = attempt || 0;
    if (installed) return;

    if (!rcov) {
        // 从窗口里找 RCOV 实例不方便，靠 <init> hook 拿
        if (attempt > 20) { W('还没拿到 RCOV 实例'); }
        return;
    }
    if (!eacView) {
        eacView = getF(rcov, 'l');
        if (!eacView) {
            if (attempt < 20) postDelayed(function () { tryInstall(attempt + 1); }, 400);
            return;
        }
        I_('拿到 eac 视图: ' + clsName(eacView));
    }

    postToMain(function () {
        try {
            installListener();
            if (installed) {
                // 首帧同步一下文字
                var joining = isJoining();
                L('初始状态 joining=' + joining + ' n=' + joinStatus()
                    + '  text="' + currentEacText() + '"');
            }
        } catch (e) { E('install 失败: ' + e); }
    });
}

/* ================================================================
 * 九、Hook
 * ================================================================ */
var hooked = 0;
var _observed = false;

/* ① RCOV.<init> —— 拿实例、拿 eac（构造函数必须用 Hook.ctor，Hook.all 不认 <init>） */
try {
    Hook.ctor(RCOV, null, function (ctx) {
        try {
            var self = ctx.this;
            if (!self) return;
            if (clsName(self).indexOf('RealTimeChorusOperateView') < 0) return;

            rcov = self;
            eacView = getF(self, 'l');

            if (eacView) {
                d('RCOV.<init> 捕获 eac，准备接管 listener');
                postToMain(function () { tryInstall(0); });
            } else {
                // l 可能是 init 之后才赋值，延迟再取
                postDelayed(function () { tryInstall(0); }, 200);
                postDelayed(function () { tryInstall(0); }, 800);
            }
        } catch (e) { d('RCOV.<init>: ' + e); }
    }, 'after');
    hooked++;
    I_('Hook OK: RCOV.<init>');
} catch (e) { E('Hook RCOV.<init> 失败: ' + e); }

/* ② 观察原生分发：记下 join / leave 各自的 n 值 */
try {
    Hook.method(RCOV, 'LLLLLLL', [RCOV, 'android.view.View'], function (ctx) {
        try {
            var self = ctx.args[0] || ctx.this;
            var v = ctx.args[1];
            if (!self) return;
            if (clsName(self).indexOf('RealTimeChorusOperateView') < 0) return;

            rcov = self;
            var n = getF(self, 'n');
            var e = getF(self, 'e');
            var isEac = false;
            try { isEac = (v === eacView) || (v && v.getId && v.getId() === ID_EAC); } catch (er) {}

            if (!_observed) {
                _observed = true;
                L('【观察】原生 LLLLLLL 首次调用  n=' + str(n) + '  e=' + str(e)
                    + '  view=' + clsName(v) + (isEac ? ' (eac)' : ''));
            } else {
                d('【观察】LLLLLLL n=' + str(n) + ' e=' + str(e) + (isEac ? ' eac' : ''));
            }
        } catch (e) { d('LLLLLLL hook: ' + e); }
    }, 'before');
    hooked++;
    I_('Hook OK: RCOV.LLLLLLL（观察 n / e）');
} catch (e) { W('Hook LLLLLLL 跳过: ' + e); }

/* ③ X.0FT5.LIZJ —— 记录停止调用（含原生自己的调用） */
try {
    Hook.method(FT5, 'LIZJ', [], function (ctx) {
        try { L('【观察】X.0FT5.LIZJ() 被调用 → 全局停止'); } catch (e) {}
    }, 'before');
    hooked++;
    I_('Hook OK: X.0FT5.LIZJ');
} catch (e) { d('Hook LIZJ 跳过'); }

/* ④ RCOV.onResume 类时机重新安装（Activity 复用 / 面板重建） */
try {
    Hook.method('androidx.fragment.app.Fragment', 'onResume', [], function (ctx) {
        try {
            var cls = '';
            try { cls = String(ctx.this.getClass().getName()); } catch (e) { return; }
            if (cls.indexOf('realtimechorus') < 0 && cls.indexOf('karaokestation') < 0) return;
            if (rcov && !installed) postToMain(function () { tryInstall(0); });
        } catch (e) {}
    }, 'after');
    hooked++;
    I_('Hook OK: Fragment.onResume（重装兜底）');
} catch (e) { d('Hook Fragment.onResume 跳过'); }

I_('=== 加载完成，' + hooked + ' 个 Hook ===');
I_('入口：eacStatus() / eacStop() / eacLeave() / eacRestore()');

/* ================================================================
 * 十、手动入口
 * ================================================================ */

function eacStatus() {
    L('');
    L('=== eac 当前状态 ===');
    L('  RCOV        : ' + (rcov ? clsName(rcov) : 'null'));
    L('  eacView     : ' + (eacView ? clsName(eacView) : 'null'));
    L('  listener    : ' + (installed ? '已接管' : '未接管'));
    L('  joining(e)  : ' + isJoining());
    L('  status(n)   : ' + joinStatus());
    L('  text        : "' + currentEacText() + '"');
    L('  点击次数    : ' + stats.clicks
        + '（加入 ' + stats.joins + ' / 停止 ' + stats.stops + ' / 退出 ' + stats.leaves + '）');
    L('');
}

/** 手动停下载 */
function eacStop() {
    L('手动停止下载…');
    var ok = stopAllDownloads();
    L(ok ? '✓ 已停止' : '✗ 停止失败');
    return ok;
}

/** 手动退合唱 */
function eacLeave() {
    L('手动退合唱…');
    var ok = doLeave(eacView);
    L(ok ? '✓ 已触发退出' : '✗ 失败');
    return ok;
}

/** 手动重装 listener */
function eacRestore() {
    installed = false;
    L('重装 listener…');
    postToMain(function () { tryInstall(0); });
}

/** 还原成原生：把文字改回「加入合唱」，listener 留着但不再拦截 */
function eacNative() {
    setEacText('加入合唱');
    installed = false;
    L('已还原文字（listener 仍接管，点「加入」走原生）');
}

postDelayed(function () { tryInstall(0); }, 600);
