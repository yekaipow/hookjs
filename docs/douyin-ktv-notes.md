# 抖音 KTV 面板 · 反编译结论与实现笔记

> 这份文档是**关键备份**。脚本本身可以重写，但这些混淆类名、资源 id、字段映射
> 是靠逆向一个个挖出来的，丢了要重做几十步。改动脚本前先读这里。

- 目标版本：抖音 41.0.0，versionCode 410001，包名 `com.ss.android.ugc.aweme`
- 分析手段：jadx + androguard + 自写 AXML/ARSC 解析器
- 加固情况：`libdexvmp.so`（DexVMP）+ `libfileprotect.so`，34 个 dex，Kotlin 层方法仍可 Hook

---

## 1. 资源 ID 速查

| 名称 | ID | 类型 | 说明 |
|---|---|---|---|
| `zj+` | `0x7f0aa7b8` | RecyclerView | **已点列表本体** |
| `zj-` | `0x7f0aa7b7` | ConstraintLayout | 列表容器 |
| `zeq` | `0x7f0aa6d7` | FrameLayout | **一级页签右侧空白区，用来放触发按钮** |
| — | `0x7f0aa6d9` | SecondLevelTabView | 二级页签（播放列表 / 已唱） |
| — | `0x7f0aa6d8` | ScrollControlViewPager | 内容区 |
| — | `0x7f0aa7e2` | FloatingBottomView | 底部悬浮条 |
| — | `0x7f0a2c34` | KtvCommonEmptyView | 空列表占位 |
| — | `0x7f0d3fb4` | (r/583.xml) | **点歌列表 item 布局** |
| — | `0x7f0d3fb2` | (include) | item 内歌曲信息区 |

相关布局文件：

- `r/582.xml` → 列表 + 空视图（`zj-` / `zj+` / FloatingBottomView）
- `r/583.xml` → 单个歌曲 item
- `r/57y.xml` → 页签布局（`zeq` 在这里）

---

## 2. 类名映射

### 2.1 列表容器与 Fragment

| 混淆名 / 原名 | 作用 |
|---|---|
| `...ktvmode.view.secondleveltab.PlayListContainerView` | **列表容器**（FrameLayout 子类），核心类 |
| `...ktvmode.view.firstleveltab.OrderedFirstLevelTabFragment` | 「已点」一级页签 Fragment，字段 `s` 持有 PlayListContainerView |
| `...firstleveltab.CommonOrderedFirstLevelTabFragment` | 另一个「已点」实现，`mM(View)` 里处理 `zeq` |
| `...ktvmode.view.secondleveltab.MusicListSecondLevelTabFragment` | 二级页签，创建列表的地方 |
| `...view.secondleveltab.CustomSecondLevelTabFragment` | `tab=="play_list"` 时创建 |

### 2.2 ItemViewBinder（MultiType）

| 类 | ViewHolder | 用途 |
|---|---|---|
| `X.0FZs` | `SongListItemViewHolder` | 点歌列表（待点/已点） |
| `X.0FZt` | `SongListItemViewHolder` | 同上，另一条 binder |
| `X.0Fa3` | `WantSingItemViewHolder` | 「想唱」列表 |
| `X.0FaP` | `CommonSongListItemViewHolder` | 通用组件版 |

### 2.3 数据模型

| 类 | 说明 |
|---|---|
| `Lcom/bytedance/android/livesdk/message/model/MusicPanel` | 列表项数据，字段 `LIZ` = `KtvMusic` |
| `...model/KtvMusic` | 歌曲本体（PPS/ProtoDecoder 框架，54 号 dex） |
| `LX/09qV` | = `KtvSongStruct.AudioInfo`，音频信息 |

---

## 3. 列表创建与更新链路

### 创建（只发生一次）

```
OrderedFirstLevelTabFragment.nM(Tab)
  → tab == "play_list" → new MusicListSecondLevelTabFragment
    → AObjectS1351S0100000_8.invoke(case 3)
      → new PlayListContainerView(ctx, vm, ctrl)
        → PlayListContainerView.LIZLLL()          ★ 创建入口
            ├ getSelectedListRv()                  → 拿到 zj+
            ├ setLayoutManager(SSLinearLayoutManager)
            ├ getAdapter() → new MultiTypeAdapter(list)
            ├ register(X.0FYW → X.0FYP)
            ├ register(X.0FYk → X.0FYX)
            └ setAdapter(adapter)                  ★ Adapter 挂上
        → addView(PlayListContainerView)
```

### 更新（每次数据变化）

```
路径 A：OrderedSongDataContext.ID()
        → AObjectS798S0100000_8.invoke$1
        → PlayListContainerView.LIZ(List) → LIZJ(List)

路径 B：LX/0FYa.accept(List)
        → PlayListContainerView.LIZ(List) → LIZJ(List)
```

`LIZJ` 内部：

```java
LIZJ(List<MusicPanel> list)
  ├ 空 → EmptyView 显示，容器 GONE，notifyDataSetChanged
  └ 非空 →
      ├ 按 MusicPanel.LJ(是否已唱) 分流
      ├ 包装 LX/0FYW / LX/0FYV / LX/0FYY / LX/0FYk
      ├ DiffUtil.calculateDiff(X.0FYS) 异步
      └ RxJava subscribe → adapter 更新
```

---

## 4. 音频地址怎么取（重要）

`KtvMusic` 的 `meta_*` 字段**不是值**，是 PPS 的 `FieldMeta` 描述符：

```
FieldMeta(protoName='song_url', tag=5, type=Primitive(string), meta=null)
```

真正的值在实例字段里。官方下载器 `LX/0FTP` 分 6 个槽位，各取不同字段：

| 子类 | 取值方法 | 字段 | 音轨名 |
|---|---|---|---|
| `LX/0FTK` | `TC().MC()` | `p` → `AudioInfo.meta_url` | `accompaniment` |
| `LX/0FTL` | `WC().MC()` | `o` → `AudioInfo.meta_url` | `fullTrack` |
| `LX/0FTM` | `sD()` | `r` | — |
| `LX/0FTN` | `iD()` | `q` | — |
| `LX/0FTh` | `aD().get(0)` | `i` (List) | — |
| `LX/0FTW` | 直接 `""` | — | 预留 |

`LX/09qV`（AudioInfo）关键方法：

```java
MC()  → meta_url        // 音频 URL
KC()  → meta_file_hash  // 文件名（官方就用它命名）
LC()  → meta_audio_id
```

`KtvMusic` 其他方法：

```java
getTitle()     歌名
fD()           歌名（备用）
YC()           歌手（备用）
XC() / getId() musicId（long）
```

---

## 5. 下载路径与下载器

### 路径

```
<X.0FKH.LIZ()> / musicPack / <musicId> / <音轨名> / <文件名>
```

- `X.0FKH.LIZ()` — 根目录（Kotlin lazy，取 `getExternalFilesDir`）
- `musicId` — `KtvMusic.XC()`
- 音轨名 — `accompaniment` / `fullTrack`
- 文件名 — `AudioInfo.KC()`（hash），扩展名从 URL 提取

官方拼接代码在 `LX/0FTO`：

```java
LIZLLL(long musicId) → root + "/musicPack/" + musicId
LJ(url)   → url.substring(url.lastIndexOf("/"))       // 文件名
LJII(url) → url.substring(0, url.lastIndexOf("/"))    // 目录
LIZIZ/LIZJ(MusicPanel) → 读缓存，附带 "accompaniment/" / "fullTrack/" + KC()
```

### 下载器

抖音用的是**字节自研 socialbase**，不是系统 `DownloadManager`：

```
com.ss.android.socialbase.downloader.downloader.Downloader
com.ss.android.socialbase.downloader.model.DownloadTask
  .url() .name() .savePath()
  .retryCount() .autoSetHashCodeForSameTask()
  .subThreadListener()
monitorScene("musicpack_midi")
```

`LX/0FTP.LIZ` 里还有反射调用 `setCacheLifeTimeMax(1209600)`（14 天）。

---

## 6. 脚本实现要点

### 6.1 六个 Hook

| # | 目标 | 时机 | 作用 |
|---|---|---|---|
| ⓪ | `PlayListContainerView.LIZLLL` | after | **列表创建**，记录 `listRv` 实例 |
| ① | `PlayListContainerView.LIZJ(List)` | after | **列表更新**，采集全量 MusicPanel |
| ② | `RecyclerView.onLayout` | after | 布局完成后注入 |
| ③ | `RecyclerView.onScrollStateChanged` | after | 滚动停止补注入 |
| ④ | `CommonOrderedFirstLevelTabFragment.mM(View)` | after | 记录 `zeq` 句柄 |
| ⑤ | `Fragment.onResume` | after | `zeq` 兜底（白名单 KTV 页签） |

### 6.2 线程约束（踩过的坑）

**`Ui.post` 在主线程被 Hook 占用时会同步执行并抛异常：**

```
IllegalStateException: 主线程正被 Hook 回调占用，创建 View 无法同步执行
```

`mM` / `Fragment.onResume` 都是主线程回调，不能在里面调任何 `Ui.*`。

正确做法——**分两步**：

```javascript
// 主线程回调：只存 Java 句柄，不碰 Ui
function rememberHost(rootView) {
    triggerHost = rootView.findViewById(TRIGGER_HOST_ID);  // 纯 Java，安全
    triggerMounted = false;
}

// 安全时机（Ui.post 内）：才创建 View
function refresh() {
    if (triggerHost && !triggerMounted) ensureTrigger();
    ...
}
```

### 6.3 可见性判断

`Ui.children()` 返回的不是 JS 数组，`.length` 是 `undefined`。必须用 Java API：

```javascript
rv.getChildCount()
rv.getChildAt(i)
child.isShown()
child.getHeight() > 0
rv.getChildAdapterPosition(child)   // 真实歌曲序号
```

用 `adapterPosition` 而不是子 View 下标——滚动后子 View 下标总从 0 开始。

### 6.4 身份比对

不要只靠 `getId()`。列表重建时旧实例还活着但已脱离视图树。

```javascript
function isTargetRv(v) {
    if (listRv) {
        if (v === listRv) return true;
        if (v.equals(listRv)) return true;   // 句柄不一定 === 相等
    }
    return v.getId() === RV_ID;              // 兜底
}
```

### 6.5 查重与复用

RecyclerView 会复用 item，`injectOne` 每次都要：

1. 先用 `contentDescription` 查重（`qh_ktv_dl` / `qh_ktv_more` / `qh_ktv_info`）
2. 存在则**重新绑定 `onClick`**（闭包里的 `info` 是旧的，不重绑会下错歌）
3. 不存在才 `Ui.create` + `Ui.insert`

### 6.6 签名去重

```javascript
var sig = '0:倒带|1:说爱你|2:妥协';
if (sig === lastInjectSig) return;   // 内容没变就不重复干活
```

`onLayout` 触发很频繁，没有这个会疯狂重建按钮。

---

## 7. 排查清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `可见 item 数: undefined` | 用了 `Ui.children` | 改 `getChildCount()` |
| `主线程正被 Hook 回调占用` | 在主线程回调调 `Ui.post` | 拆成「记引用 / 建 View」两步 |
| `zeq 容器不存在` | root 不是页签根视图 | 从 `ctx.this.getView()` 拿 |
| 按钮位置乱 | ConstraintLayout 约束没生效 | `insertAfter` 有 fallback |
| 下载 403 | 点歌地址签名过期 | 刷新列表后立即下载 |
| 「无URL」 | 该曲无伴奏授权 | `dumpSongs()` 查看 |

诊断函数（脚本内置）：

```javascript
dumpSongs()      // 已采集歌曲 + 完整落盘路径
dumpRv()         // 可见 item 的真实状态（pos/top/bottom/shown）
probe()          // 控件树
manualRefresh()  // 手动重注入
```
