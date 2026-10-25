# 念念收藏夹 - 更新日志

## [0.17.1] - 2026-10-25

### 上一版为什么没用：两个 bug 叠在一起

你截图里那个 docx 点开没反应，右上角写的还是「文件」而不是「Word」。
这两件事指向同一个根因——**类型被后端盖掉了**。

**bug 1：后端把 docx 归成 file**

`lib/vault.js` 里那份 `EXT_TYPE` 还写着 `docx: "file"`。
前端算类型是 `meta?.type || guessTypeOf(name)`——后端的值优先。
我上一版只改了前端表，被后端直接盖回去。
结果：类型是 file → 不进 docx 预览分支 → 点开走系统打开。
**我的 docx-preview 从头到尾没被调用过。**

现在前后端两张表都改了，测试里加了一致性校验，两端不一致会直接报红。

**bug 2：库外文件被关在预览之外**

点击处理里有这么一段：

```js
if (isExternal) {
  if (!isDir) { openWithSystem(fp); return; }   // ← 这里直接交给系统了
```

你截图那个 `新建 DOCX 文档.docx` 就在 `OH-WorkSpace` 这个库外目录里，
所以它走的是这个分支——库内文件能预览，库外一律丢给系统程序。

这不是修 bug，是补能力：库外文件现在也先试面板内预览，装不下（比如 .exe）才交给系统。

**配套：库外读字节的路由**

库内文件读字节走 `/asset/*`（库内 fs），但库外的路径必须走 `extFs`（宿主资源接口）。
沙箱里的 `node:fs` 读不到 Desktop，这条和 0.16.0 那个根因是同一个。
所以新增 `GET /external/raw?path=...`，用 `extFs.readBytes` 读，不缓存。

实测确认过：用 `extFs` 读那个 81KB 的真实 docx，字节数和文件大小一致，
前两字节是 `50 4B`（PK，docx 的 zip 头）——是合法文件，不是空壳。

### 顺带修的

**`undefined 项`**：文件夹项数取的是 `sub.items.length`，深层目录读失败时
`items` 会是 undefined，界面上就显示成「undefined 项」。后端兜了 `(sub.items || [])`，
前端也加了 `?? 0`。

### 现在点 docx 的路径

```
点击 → 判断类型是不是 doc
  → 是 .docx？→ 读字节 → docx-preview 渲染 → 面板里出文档
  → 是 .doc（老二进制格式）？→ 明确告知读不了，右键用系统程序打开
```

### 测试

新增 2 个文件 29 项：

- `external-raw-check`（5 项）：用 SandboxedFs 模拟真实沙箱，确认库内 fs 读库外会抛错、
  `extFs` 能读到真实 81KB docx、是合法 PK 头
- `fix-0171-check`（24 项）：两端类型表一致性、库外预览链路、路由走 extFs

26 个测试文件 **1017 项** + 28 项视觉体检 + 13 项 docx 布局，全绿。
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
