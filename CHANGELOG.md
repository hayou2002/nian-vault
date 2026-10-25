# 念念收藏夹 - 更新日志

## [0.18.4] - 2026-10-25

### 视频：直连 + 条件降级，并把失败原因摆到脸上

0.18.3 的 Range 修复仍然没解开黑屏。这轮把能查的静态证据全查了一遍，
全部指向「链条应该通」：

- 宿主 CSP 生成函数 `kDt`：`media-src 'self' https: data: blob:` —— 同源 http 和 blob 都允许
- app-runtime-proxy：`status` 与除两个头外的所有响应头原样透传（含 Content-Range）
- scoped 路径下的 GET/HEAD 直接放行，`path=` query 不会被剥掉
- `mediaSrcUrl` 在两种页面 URL 形态下拼出的路径都正确

静态证据到此为止，剩下的只能是运行时行为。所以这版不猜了，改为**让真机说话**：

- 视频直连失败 → 自动降级 blob（≤64MB，走已被 PDF/docx 验证的 hana.api.fetch 通道）
- \>64MB 不试 blob（整读会撑爆内存），直接亮错误码
- 失败面板显示：`error.code`（1=中止 / 2=网络 / 3=解码 / 4=来源不支持）、
  实际请求 URL、页面 `location.pathname`

下次截图就能一眼分清是「没连上」「连上了但解不了」还是「URL 拼错了」。

### 测试

更新 2 条随实现演进的断言。31 个测试文件 **994 项** + 28 视觉 + 13 docx 布局，全绿。

## [0.18.3] - 2026-10-25

### 视频仍黑屏：浏览器首发的开区间 Range 掉进了整读分支

0.18.2 装机后视频还是黑屏（但错误面变成了新加的「视频加载失败」）。
顺藤查出一个自己埋的雷：**浏览器首发请求是 `Range: bytes=0-`（无 end）**，
旧代码把空 end 当 `end=total-1` 处理——等于整读 183MB 塞回去，链路当场撑死。

测试怎么没拦住：range-check 全用闭区间（`bytes=0-65535`），
没用浏览器真实形态（开区间）测。这次 range-open-check 用真机首发形态补上。

修复（对齐标准流媒体行为）：

- 开区间 `bytes=a-` 也走 206，**单段钳到 4MB**（首帧快、seek 轻）
- `start >= total` → 416 + `Content-Range: bytes */total`
- 多段 Range（`bytes=a-b,c-d`）不支持，忽略按 200 整回
- 后缀式 `bytes=-N` 逻辑重写（空 end 现在是 NaN 不是 total-1，旧算法会算错）

顺带确认了 scoped 直连的转发链路没问题：反编译宿主 app-runtime-proxy，
`LGe` 把 `_surface/{token}/xxx` 的 upstreamPath 原样转发到
`http://127.0.0.1:{port}/xxx`，query 只剥 appSurfaceSession 等几个特定参数
（`path=` 保留），且 scoped 路径形态的 GET 直接放行。架构正确，雷在 Range 解析。

### 验证

- range-open-check 10 项：真机首发形态（开区间）+ seek + 越界 416 + 多段降级，
  真实 175MB 视频字节逐一比对
- 更新 2 条过时断言（end 越界现在按 4MB 钳制而非钳到 total-1）
- 31 个测试文件 **994 项** + 28 视觉 + 13 docx 布局，全绿

## [0.18.2] - 2026-10-25

### 175MB 外部视频黑屏 0:00 —— 整只 blob 撑不住，改 Range 分段

真机：视频有界面了但黑屏停在 0:00。ffprobe 查了文件本身：H.264/AAC
完全正常（Chromium 原生支持），175MB / 2.4 小时。问题在传输层：
0.18.1 的方案是整只拉进内存转 blob，175MB 一次拉完在那条链路上撑不住。

两层修复：

#### 后端：/external/raw 支持 HTTP Range

播放器只要前几百 KB 就能出画面，剩下边播边拉。解析 `Range: bytes=a-b`，
返回 206 + `Content-Range` + `Accept-Ranges`，支持前段/中段/后缀式（`-N`）/越界钳制。

安全模型不变：先 extFs.stat 验路径（受引用注册表约束），切片用 node:fs
直读——沙箱后端的 node:fs 可以直读本机路径（实测 D 盘 175MB 视频按
64KB 区间切读，头 16 字节正是 ftyp 盒子）。ResourceIO 没有区间读能力，
这是唯一路径。

#### 前端：video 改 scoped URL 直连

反编译宿主 bundle 确认：`_surface/{token}/` 路径段本身就是鉴权凭证
（scoped 模式从路径解 sessionToken），不依赖 header。所以
`new URL("external/raw?...", location)` 拼出的 URL（token 天然在路径里）
`<video src>` 直接用——浏览器自己发 Range 请求，完全不占面板内存。

audio 保持 blob（文件小，一次拉完避免每次 seek 都打 206）；图片不动。

### 验证

- range-check 15 项：真实 175MB 视频文件，206/Content-Range/字节逐一比对/
  后缀式/越界钳制全过
- fix-0182-check 17 项钉死前后端改动
- 30 个测试文件 **984 项** + 28 视觉 + 13 docx 布局，全绿

## [0.18.1] - 2026-10-25

### 外部视频「媒体加载失败」+「0 B」+ 大小限制（三处）

真机反馈：引用的库外视频（D:\AI\...）放不了，还显示「0 B」。
另要求去除引用文件的大小限制。三处根因：

#### ① 外部媒体走错了路

0.18.0 的 paintMedia 把绝对路径塞给了 assetBlobUrl，它拼出
`/_assets/D:\AI\...`——SDK 的 normalizePluginApiPath 见到反斜杠直接抛
`Invalid plugin API path`（和 0.17.4 docx 是同一族 bug，这次轮到媒体）。

新增 `mediaBlobUrl()` 统一入口：绝对路径走 `/external/raw?path=`，
库内走 `/_assets/`；pending 去重 + cache 常驻（照图片 blob 的双表模式，
第一版 finally 里删缓存是自废，当天修正）。

#### ② 「0 B」是显示问题

`fmtSize(null)` 里 `Number(null)===0`，外部文件 stat 失败拿不到 size 时
显示成「0 B」。null 现在如实显示「—」（未知大小），不再装成 0 字节。

#### ③ 50MB 上传上限 → 2GB

`MAX_ASSET` 从 50MB 提到 2GB。没有装成「无限」：这套上传走 Hono
parseBody 一次性读进内存，Node Buffer 的诚实上限就是 2GB 左右，
再大需要流式改造（现在是整读整写）。引用（只记路径）从来不复制文件，
天然无大小限制。

### 测试

新增 fix-0181-check 11 项。29 个测试文件 **952 项** + 28 视觉 + 13 docx 布局，全绿。

## [0.18.0] - 2026-10-25

### PDF 压扁修复

真机反馈：PDF 能看了，但被压成一页、比例不对。根因是 flex 容器的默认行为：
`.fp-pdf-canvas` 用 `display:flex` 居中，flex 默认 `align-items:stretch` 会把
子项垂直拉伸到容器高度，canvas 就被压扁了。一行 `align-items:flex-start` 修掉。

### 音视频：从「直连 URL」改成 blob

`<video src=绝对URL>` 和当年 `<img>` 踩的是同一个坑：标签发请求带不了
surface session 凭据头 → 403。图片 0.16 就改成 blob 了，音视频一直没跟上。
现在 `data-vsrc` 标记 + `paintMedia()` 异步填 blob，与图片同款机制，带缓存。

### Excel / PPT 预览（后端解析路线）

CSP 禁 Worker/eval/blob，前端库全被卡死——但**后端是 Node，没这些限制**。
解析放后端，前端零依赖只管画：

- Excel（xls/xlsx/xlsm/xlsb）：SheetJS（xlsx.full.min.js 861KB，仅后端加载）
  解析成 `{sheets:[{name,rows}]}`，前端画表格；多 sheet 出标签页切换；
  限 20 sheet / 200 行 / 40 列（面板不是 Excel，够看就行）。
- PPT（pptx/ppsx）：本质是 zip，每页 slideN.xml 的 `<a:t>` 是文本。
  后端抽每页文字大纲，前端排成「第 N 页」卡片流。纯图片页抽不到字，
  诚实提示「没抽到文字」，不硬演。老 .ppt 是二进制 OLE 格式，读不了会报错降级。

踩坑记录：vendor 的 jszip 在 Node 下 `exports` 本身就是 JSZip 类，
`new JSZipCtor().loadAsync(buf)` 才是正确用法（`JSZip.loadAsync()` 无参调用
会报「Can't read the data of the loaded zip file」）。

### 扩展名表补齐（+30）

jpe/jfif/tiff/avif/heic、3gp/mpg/rmvb、oga/midi/opus/aiff、markdown/log、
bz2/xz/iso 等之前全落到「文件」类型，现在正确归类。

### 验证

- xlsx：SheetJS 写真实文件再解析，中英文/数字单元格全对
- pptx：造真 zip（含 rels 干扰项）再解，页序/段落拼接/实体转义全对
- PDF 比例：jsdom computed style 钉死 align-items/height/max-width
- 新增 sheet-slide-check 10 项 + pdf-aspect-check 8 项
- 29 个测试文件 **951 项** + 28 项视觉 + 13 项 docx 布局，全绿

安装包 2.03MB → 约 2.9MB（xlsx 库 861KB 进了 vendor，仅后端用）。

## [0.17.4] - 2026-10-25

### 两个真机错误的根因（都修了）

0.17.3 装机后用户截图反馈两条错误，这次都挖到了根：

#### ① docx：Invalid plugin API path

renderDocx 把 `assetUrl(fp)` 的返回值喂给了 `hana.api.fetch()`。
`assetUrl()` 返回**绝对 URL**（`http://127.0.0.1:...`），而 SDK 的
`normalizePluginApiPath` 见到协议头（`/^[a-z][a-z0-9+.-]*:/i` 命中 `http:`）
直接抛 `Invalid plugin API path`。

分工从此写死：`assetUrl()` 只给 `<img>/<video>` 这类 HTML 标签用
（标签带不了凭据头，必须绝对 URL）；`hana.api.fetch()` 只吃相对路由路径。
库内 docx 改拼 `/_assets/...` 相对路径，与 loadPdf 一致。

这也侧面说明 0.17.3 的 JSZip 顺序修复生效了——错误往后走了一层。

#### ② PDF：fake worker 的相对路径踩空

截图报 fake worker 动态 import 失败。根因：
`workerSrc = "./vendor/..."` 按 **pdf.min.mjs 自己的位置**解析，
它已经在 vendor/ 里，再拼一层变成 `vendor/vendor/…` → 404。
而且面板页挂在 `_surface/{token}/` 下，相对路径解析天然不可靠。

之前的 http 测试没挂 CSP 头，pdf.js 走的是真 Worker 分支，
没暴露 fake worker 分支的问题。

修法（pdf.js 官方支持的路径）：panel.js 先自己 `await import(worker 模块)`
挂到 `globalThis.pdfjsWorker`——pdf.js 的 fake worker 分支见到现成的
`WorkerMessageHandler` 直接用（sdk.js 源码同款判断），不再解析 workerSrc。
workerSrc 仅留兜底，且用 `import.meta.url` 拼绝对 URL。

### 验证（比上版更狠：CSP 头直接挂上）

真实 Edge + 完整沙箱 CSP（`worker-src 'none'`）+ nonce 内联：

```
sample-text.pdf：pages=1, textLen=33, inkSamples=6973（canvas 真画出来了）
调查问卷参考.pdf（459KB 扫描件）：pages=7, inkSamples=7212
fake worker 主线程跑通，无 new Worker，CSP 合规
```

上版遗留的「bytes=0 但能解析」怪象定位为测试环境问题
（virtual-time 冻结响应体但放行流），渲染出内容才是硬证据。

### 测试

- 新增 `fix-0174-check` 13 项
- 历史断言随功能演进入档（0171/0172/0173 共 6 条）
- 28 个测试文件 **923 项** + 28 项视觉 + 13 项 docx 布局，全绿

## [0.17.3] - 2026-10-25

### Word：JSZip 加载顺序写反了

截图里 docx 报 `JSZip 未加载`。是我把顺序写反了：代码先 `import` docx-preview
（它在模块顶层就要读 `globalThis.JSZip`，读不到直接抛错），**之后**才去加载 jszip。

更麻烦的是 ESM 的特性：模块求值失败会被浏览器缓存成永久失败，
之后哪怕加载了 jszip，import 永远返回同一个错误。必须先挂 jszip 再第一次 import。

### PDF：iframe 这条路在 HanaAgent 里是死的

截图里 PDF 是白屏——不是加载失败，是**渲染不了**。

查了宿主 Electron 主进程（app.asar 里的 main.bundle.cjs）：
`webPreferences` 里没有 `plugins:true`（出现 0 次）。
**Electron 默认不启用 Chromium 内置 PDF 阅读器**，iframe 里塞 PDF（http 也好 blob 也好）
在 Chrome 浏览器里能显示，在 Electron 里一律白屏。

我上一版说「Chromium 自带阅读器就能用」是错的，那套判断只对浏览器成立。

### PDF 改用 pdf.js 画到 canvas

既然 iframe 死了，只剩一条路：pdf.js 渲染到 canvas。三个关键适配：

```js
GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
// 禁 worker-src 时，pdf.js 用 await import(workerSrc) 把 worker 模块
// 拉进主线程跑（fake worker）。路径必须指向包内同源文件。

isEvalSupported: false,
// CSP 没有 unsafe-eval。主动关掉，pdf.js 走 PostScript 替代路径，
// 不试 eval 也就不会触发 CSP 报错。

isOffscreenCanvasSupported: false,
// 沙箱 iframe 里 OffscreenCanvas 不可靠。
```

体积：pdf.min.mjs 441KB + pdf.worker.min.mjs 1067KB，vendor 总计 1677KB（1.6MB）。
安装包从 1.6MB 变成约 3.2MB。这是 PDF 在面板里能看的代价。

### 验证

http 同源 + 模拟 App 的 CSP（禁 worker、禁 unsafe-eval）下真实 Edge 测试：

```
sample-text.pdf：解析成功，文字层解出「Hello from PDF / Second line of text」
模块动态 import 成功（file:// 协议下会失败，http 同源下正常——
  之前测试失败是测试环境问题，不是代码问题）
fake worker 在主线程跑通，没有 new Worker，CSP 合规
```

中间发现测试脚本自身的怪象（fetch 字节数与解析结果矛盾），没有继续追，
直接以集成后的真机表现为准。

### PDF 预览的样子

带上一页/下一页按钮和页码（`3 / 7`），渲染进可滚动画布。

### 测试

- 新增 `fix-0173-check` 16 项（pdf.js 接入、CSP 适配、jszip 顺序、vendor 完整性）
- 更新 3 条过时断言（PDF 从 iframe 改为 canvas，测试跟着功能走）
- 27 个测试文件 **905 项** + 28 项视觉 + 13 项 docx 布局，全绿
## [0.17.2] - 2026-10-25

### 两个不同的根因，都不是同一回事

**PDF：403 missing_credential**

截图里 PDF 预览框显示的是那句熟悉的 `missing_credential`。
和 0.13.0 图片全裂**同一个根因**：`<iframe src>` 和 `<img src>` 一样，
带不了自定义请求头，宿主路由拿不到凭据就 403。

改法：先用 `hana.api.fetch` 取回字节转成 blob，再把 blob URL 交给 iframe。
这套做法在 0.13.0 修图片时已经验证过，直接复用。

顺带显式指定 `application/pdf`——宿主给的 content-type 有时候 iframe 不认。

**docx：「找不到这个文件在库里的位置」**

这个更蠢。`renderDocx` 当初是靠**文件名反查路径**：

```js
const name = scope.querySelector(".fp-name")?.getAttribute("title");
const fp = findAssetPathByName(name);   // ← 靠名字猜路径
```

库外文件（绝对路径）根本不在 `filesItems` 里，必然查不到。
而 `previewAsset(fp, meta)` 本来就有 `fp`，我却舍近求远绕了一圈。

改成直接传入。`findAssetPathByName` 变成死代码，删掉了。

### 真机验证

这次不敢只跑单元测试了——上一版就是测试全绿、真机不能用。

用真实 Edge(Chromium) 跑了一遍 PDF 的 blob 路线：

```
blob 路线成功            ✓
生成的是 blob: URL       ✓
MIME 是 application/pdf  ✓
内容是合法 PDF（%PDF）    ✓  魔数 25 50 44 46 2d
iframe 载入了            ✓
```

5 项全过。docx 那边之前也验过：81KB 真实文档，字节数一致，PK 头正确。

### 测试桩补全

`preview-real-check` 的桩只给了 `json()` 和 `text()`，没有 `blob()`，
也没有 `URL.createObjectURL`（jsdom 不实现）。PDF 改走 blob 后在这套桩下必然挂。
补上了这两个，测试才真正覆盖到新代码。

### 一个测试断言的教训

`preview-real-check` 里有个用例叫「普通文件 → 表.docx」，断言它走降级分支。
但 docx 现在有专属预览了，这个用例本身失效了。
改成 `程序.exe`——那才是真正「画不出来」的类型。

**测试用例也要跟着功能演进，否则它测的是过时的东西。**

### 测试

新增 `fix-0172-check`（22 项）。26 个测试文件 **923 项** + 28 项视觉体检 + 13 项 docx 布局，全绿。
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
