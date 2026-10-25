# 念念收藏夹 - 更新日志

## [0.17.0] - 2026-10-25

### Word 预览：接进面板了

先说为什么只有 Word，没有 Excel 和 PPT——**这是限制导致的，不是我漏做**。

宿主给 App 容器的安全策略：

```
sandbox allow-scripts        ← 没有 allow-same-origin
worker-src 'none'            ← Worker 完全禁用
object-src 'none'            ← 插件/embed 禁用
connect-src 'none'           ← 不能发网络请求
script-src 'self'            ← 只能加载包内脚本
img-src 'self' data:         ← 图片只认 data:，不认 blob:
```

这条 CSP 直接毙掉了市面上大多数预览库：

| 库 | 体积 | Worker | 结果 |
|---|---|---|---|
| filens | 318KB+WASM | 用了 | ✗ 排除 |
| @js-preview/docx | 339 KB | 用了 | ✗ 排除 |
| @file-viewer/pptx | 660 KB | 用了 | ✗ 排除 |
| **docx-preview** | **74 KB** | **不用** | **✓ 唯一满足** |

Excel 和 PPT 目前没找到同等条件（纯 JS、不用 Worker、不用 WASM）的库，
所以先不做，右键「打开文件位置」交给系统程序打开。不硬撑一个残缺的实现。

### 实测数据（真实中文文档，Chromium 无头）

```
AI编程学习路径_小白详解版.docx  (990 KB)
  文字 20616 字 · 图片 9 个（全部 data: 合规）· 表格 34 个 · 2 页

饥荒联机版 双人首玩全流程攻略.docx  (81 KB)
  文字 24649 字 · 表格 52 个 · 20 页

sample.docx  (2 KB)
  文字 88 字 · 表格 1 个 · 1 页
```

三份都渲染成功，中文正常、表格正常。

### 关键那行：useBase64URL

CSP 里 `img-src` 只认 `data:`，不认 `blob:`。docx-preview 默认用 blob URL 显示
文档内图片，放到这个沙箱里会**全部不显示**——而且不报错，就是空白。

所以必须传 `useBase64URL: true`。测试里把这条钉住了，改坏了会立刻报红。

### 落地细节

- `ui/assets/vendor/jszip.min.js` 95 KB（docx-preview 的依赖）
- `ui/assets/vendor/docx-preview.mjs` 74 KB（原版 `import jszip` 是裸模块名，
  浏览器解析不了，改成从 `globalThis.JSZip` 取）
- 合计 **169 KB**，安装包体积增加不到 0.2 MB
- 老 `.doc` 是二进制格式，这个库读不了，走降级提示，不假装修好了
- 文档内超链接一律去掉 href：沙箱会拦跳转，点了没反应更让人困惑

### 现在能预览什么

| 类型 | 状态 |
|---|---|
| 图片 png/jpg/webp/gif/svg | ✓ |
| 音频 mp3/wav/m4a/flac | ✓ |
| 视频 mp4/webm | ✓ |
| PDF | ✓（Chromium 自带阅读器）|
| **Word .docx** | **✓ 新增** |
| Excel / PPT | 降级：交给系统程序打开 |

### 测试

新增 `docx-preview-check` 29 项（类型分类、vendor 完整性、CSP 硬约束、
不破坏已有能力）。25 个测试文件 **1018 项** + 28 项视觉体检，全绿。
