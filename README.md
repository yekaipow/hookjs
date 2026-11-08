# hookjs

抖音 KTV 点歌面板增强脚本（QuickHook / QuickJS）。

## 目录

```
douyin-ktv/
  douyin_ktv_top3_download.js   主脚本
docs/
  douyin-ktv-notes.md           反编译结论与实现笔记（关键备份）
action.sh                       LSPosed 模块快速打开管理器
```

## douyin-ktv 脚本

目标：抖音 41.0.0（`com.ss.android.ugc.aweme`），运行环境 QuickHook。

功能：

1. 在「已点」页签右侧空白区（`zeq` / `0x7f0aa6d7`）注入「注入」触发按钮
2. 点击后，在列表前 3 行各加「下载」「更多」两个按钮
3. 「更多」再插入第三个按钮（展示歌曲信息）
4. 下载走 6 线程分块，落盘到官方缓存目录
   `<X.0FKH.LIZ()>/musicPack/<musicId>/<音轨名>/<文件名>`

使用：

1. 脚本粘进 QuickHook，作用域勾选抖音
2. 重启抖音 → 进直播间 → 点歌面板 → 「已点」
3. 点页签行右侧的「注入」

## 备份与恢复

本仓库同时充当脚本备份。沙箱重置后：

```bash
git clone git@github.com:yekaipow/hookjs.git
# 脚本在 douyin-ktv/douyin_ktv_top3_download.js
```

反编译结论（类名、资源 id、字段映射）全部记录在 `docs/douyin-ktv-notes.md`，
即使设备上的 APK 更新导致偏移，也能据此重新定位。
