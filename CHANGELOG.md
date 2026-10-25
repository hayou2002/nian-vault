# 念念收藏夹 - 更新日志

## [0.20.0] - 2026-10-25

### 视频预览下线：改由系统播放器打开

本地视频内嵌预览这条路走不通，原因不在播放器本身，而在 App 的沙箱边界：

- App 进程跑在 Node 权限模型下，`--permission` 只放行 `apps/` 与 `app-data/`，
  库外的 `D:\\...` 直接 `ERR_ACCESS_DENIED`；
- 派生子进程绕不过去——子进程继承同一套权限模型（实测 `CHILD_STAT_FAIL`）；
- 宿主 `resources.read` 只能整读，且 RPC 单消息上限 `MAX_MESSAGE_BYTES = 32 MiB`，
  175 MB 的视频无论怎么切都在这一步断掉；
- 宿主自己的 `/api/resources/:id/content` 有真 Range + `createReadStream`，
  但没有暴露给 App，用不了。

所以这一版把本地视频预览**整块撤掉**，双击视频直接给「用系统播放器打开」——
那条路一直都在，而且更快。文字、图片、音频、PDF、Word、Excel、PPT 预览不受影响。

### 顺带修掉的真 bug：外部文件大小一律显示 0 B

宿主 `resources.stat` 返回的是 `{ resourceKey, resource, exists, isDirectory, version, filePath }`，
**没有 `size` 字段**。原来 `size: st.size ?? null` 于是永远拿到 `null`。
现在按 `size → byteLength → contentLength → version.size` 逐个兜底，
时间戳也认 `mtime / mtimeMs / version.mtimeMs` 三种写法。

### 清理

- 删掉 Plyr 播放器（`plyr.min.js` 110 KB + `plyr.css` 32 KB）及懒加载逻辑；
- 删掉 Range 分块读取、`toChunkedStream`/`rawBody`、`[raw]` 诊断日志
  （那些全是为绕开 32 MiB 上限而生的，问题既然不再走那条路，就不该留着）；
- 删掉被右键菜单取代的旧分类改名/删除实现、Web 时代的 `collectDroppedFile`、
  未使用的 `_sheetWarned`、纯冗余的 `RES_ICON`；
- 绝对路径判定原本散在 5 处，抽成 `isAbsPath`（前后端各一份，语义一致）。

## [0.19.3] - 2026-10-25

### 根因：响应体作为单个超大 chunk 撞上 32MiB 硬限制

在宿主 bundle 里找到了这条硬限制：

```js
class Wv { static MAX_MESSAGE_BYTES = 32 * 1024 * 1024; }   // 32 MiB

read(e) {
  ...
  if (n.byteLength > Wv.MAX_MESSAGE_BYTES)
    throw new Error("App HTTP source chunk exceeds 32 MiB",
                    { code: "APP_HTTP_CHUNK_TOO_LARGE" });
}
```

而 `new Response(整个 175MB Buffer)` 会产生什么？实测：

```
Response(175MB Buffer).body.getReader()
→ 第一块就是 183500800 字节（整个文件）
```

Buffer 给 Response 会变成一个**超大单块**，直接撞上限。宿主抛
`APP_HTTP_CHUNK_TOO_LARGE`，上层 SDK 包装这个错误时表现成
`Invalid array length`——所以前面怎么找都找不到 `new Array` 在哪。

### 修法：返回真正的分块流

```js
const CHUNK_SIZE = 8 * 1024 * 1024;
const toChunkedStream = (buf) => {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buf.length) { controller.close(); return; }
      const end = Math.min(offset + CHUNK_SIZE, buf.length);
      controller.enqueue(new Uint8Array(buf.subarray(offset, end)));
      offset = end;
    },
  });
};
const rawBody = (buf, status, headers) =>
  new Response(buf.length > CHUNK_SIZE ? toChunkedStream(buf) : buf, { status, headers });
```

### 为什么是 8MB（不是 1MB）

先实测了各种块大小的代价：

```
CHUNK  |  块数  | 宿主 RPC 次数 | Range 4MB 要不要切
  1MB  |  176   |     2801     |  要切 4 块 ← 白做功夫
  4MB  |   44   |     2801     |  不用切
  8MB  |   22   |     2801     |  不用切
 32MB  |    6   |     2801     |  不用切（但零余量，风险高）
```

关键发现：**宿主实际传输粒度是 64KiB（`Cz = 64*1024`），跟我的块大小无关**，
RPC 次数恒为 2801。所以 `CHUNK_SIZE` 只决定三件事：

1. `ReadableStream` 的 pull 次数（176 → 22，实测 65ms → 42ms）
2. 宿主内部块登记/回收开销
3. 宿主内存里同时驻留的整块大小（并发多视频时 ×N）

选 8MB 的理由：离 32MiB 留 4 倍余量；Range 单段上限是 4MB，整块直给不用再切；
175MB 只有 22 块。

### 验证

```
整文件 175MB  → 22 块，每块 8.00MB，字节完整 ✓
Range 4MB     → 1 块直给，状态 206 ✓
Range 32MB    → 4 块，每块 8MB ✓
```

`chunk-stream-direct` 8 项、`chunk-limit-check` 7 项、`range-fallback-check` 11 项、
`media-playback-check` 17 项全绿。

### 保留的诊断能力

`/external/raw` 全链路 trace（`[raw]` 前缀）和 `wrap()` 的错误 dump 都留着——
下次若还有问题，日志里直接能看到走到了哪个分支、读到多少字节。

## [0.19.2] - 2026-10-25

### 失败面终于会说人话了

之前失败只显示 `HTTP 400`——因为我在 `throw new Error(`HTTP ${res.status}`)`
里把响应体丢了。而后端 `wrap()` 明明把原因写在 body 的 `error` 字段里：

```js
return c.json({ ok: false, error: msg, where }, 400);
```

这版三处都补上：

- 前端读响应体，把 `error` 拼进错误信息
- 后端 catch 里补 `where`（stack 第二行），直接指出哪一行抛的
- 失败面板 `white-space: pre-wrap`，多行原因完整可见

下次截图就能看到具体是哪一行出错，不用再猜。

### Plyr 改成元数据就绪后才挂载

原来是 `el.src = src; mountPlyr(el);` 紧挨着执行——Plyr 会接管 DOM、
替换播放器结构，而 `error` 监听绑在原始 `<video>` 上，接管后可能失效。

现在改成：
```js
el.addEventListener("loadedmetadata", () => mountPlyr(el), { once: true });
```
先让原生 `<video>` 把流拉起来、元数据就绪，再交给 Plyr 做控件层。
加载路径上不再有多余的东西。

### 兜底不再看文件大小

原来 >64MB 不走 blob 兜底（怕撑爆内存）。但你实测就是大文件播不了，
所以改成：直连失败一律试取字节，能读到就能播。
（宿主 ResourceIO 整读 175MB 实测 842ms，内存也扛得住。）

### 当前状态

后端能力已用真实文件验证：
```
Range 首段/中段/尾部  → 206 + 字节与磁盘一致（沙箱回退路径）11 项全过
整读 175MB            → 842ms 完整读回
四种 read 返回形态     → 全部 206（{content} / Buffer / {text} / 抛错）
```

前端 `media-playback-check` 17 项、`range-fallback-check` 11 项全绿。

## [0.19.1] - 2026-10-25

### 400 的真因找到了：Range 用了错误的读取后端

`wrap()` 的 catch 里写着：
```js
return c.json({ ok: false, error: String(err?.message || err) }, 400);
```
所以**所有路由异常都被包成 400**——那段 `HTTP 400` 是我的后端抛错了，
不是宿主拒绝。而 `<video src>` 一上来就发 Range，于是每次都撞上它。

具体在哪里抛：`/external/raw` 的 Range 分支用了
```js
const fd = fs.openSync(raw, "r");   // node:fs 直接读磁盘
```
但库外文件（`D:\...`）在宿主沙箱里是「资源」，`node:fs` 根本读不到 →
抛 ENOENT/EACCES → 被 wrap 变成 400。

**从头到尾都不是 token 问题，也不是路径问题**，是区间读用错了后端。
（不过我前面那几处路径/token 的修正也确实是真的问题，只是它们不是最后这一关。）

### 修法：Range 读失败时回退宿主接口

```js
try {
  fs.openSync(raw, "r");      // 优先：快
  ...readSync 切区间...
} catch {
  const whole = await v.extFs.readBytes(raw);   // 回退：宿主管道
  slice = whole.subarray(start, start + len);
}
```

宿主 ResourceIO 没有区间读能力（只有 open/pick/saveFile/requestAccess），
所以回退是整读再切。大文件会浪费一次全读，但先让功能通。

### 顺便：真的接了 Plyr 播放器

按用户要求接入了轻量播放器 Plyr（vendor 里 110KB JS + 32KB CSS，无依赖）：

- 控件：播放/进度/时间/音量/倍速/画中画/全屏
- 懒加载：第一次播放才载入，加载失败自动退回原生 `<video>`
- 样式按需插 `<link>`（CSP 允许 'self'）
- 中文文案（速度/正常/画质/静音）

### 验证

模拟真实沙箱（`fs.openSync` 抛错、`extFs` 可读），三种 Range 全测：

```
首段 bytes=0-1048575   → 206 ✓ 1MB ✓ 内容与磁盘一致 ✓ 走了 extFs 回退 ✓
中段 bytes=50MB-...    → 206 ✓ 长度 ✓ 内容与磁盘一致 ✓
尾部 bytes=(total-4MB)- → 206 ✓ 有数据 ✓ 末字节一致 ✓   ← moov 就在这附近
```

**11 项全过**。尾部 Range 通过意味着播放器能拿到 moov，这是这个 MP4 能播的关键。

### 测试

- 新增 `range-fallback-check` 11 项：沙箱场景下三种 Range + 字节级校验
- `media-playback-check` 17 项、`direct-search-token-e2e` 直连端到端

## [0.19.0] - 2026-10-25

### 两个关键点终于同时对了

前几版各对一半，所以一直差一口气：

| 版本 | 路径 | token | 结果 |
|---|---|---|---|
| 0.18.6 | ✘ 拼到 ui 静态目录 | ✔ 从 search 取 | 404 HTML → 码 4 |
| 0.18.9 | ✔ routes | ✘ 从 pathname 取 | 403 JSON → 码 4 |
| **0.19.0** | **✔ routes** | **✔ 从 search 取** | **通** |

两件事的正确来源：

**① 路径必须走 `routes/`**
`ui/` 是静态文件服务，只返回 `ui/` 目录里真实存在的文件。
`external/raw` 是后端 Hono 的动态路由，挂在 `routes/` 前缀下。

**② token 必须从 `location.search` 取**
SDK 的权威实现：
```js
function readSurfaceSession(w) {
  return new URLSearchParams(w.location.search).get("appSurfaceSession") || null;
}
function pluginApiFetch(targetWindow, input, init) {
  const surfaceSession = readSurfaceSession(targetWindow);
  headers.set("X-Hana-App-Surface-Session", surfaceSession);  // ← 就是它
}
```
图片 / PDF / docx 全部正常，正因为它们走 `hana.api.fetch` 拿这个 token。

### 兜底通道也统一了

直连失败时的兜底改成**不带任何自定义 header** 的 `hana.api.fetch`，
和图片/PDF/docx 完全同一条通道（它们都正常，说明这条路一定能过宿主）。
之前兜底带 `Range` 头，怀疑被宿主桥拒绝（截图里的 400 可能就是这个）。

### 端到端验证（完全复刻真实形态）

```
页面: /api/apps/nian-vault/ui/_surface/{desc}/panel.html?appSurfaceSession={token}
视频: /api/apps/nian-vault/routes/external/raw?path=...&appSurfaceSession={token}

视频: 175.0 MB
页面 search 带 token: true
状态: meta 8531s 1600x720
Range 请求: 4        ← 只发 4 段，175MB 主体没动
readyState: 4
→ ✓ 直连可播
```

### 关于内置播放器

没有引入。理由还是那条：播放器库只管**控件和解码调度**，
不管字节怎么来。这次跑通靠的是修对 URL 的两个组成部分，
不是换播放器。原生 `<video>` 拿到正确 URL 后工作得比任何库都直接。

如果你希望有更丰富的控件（倍速、画面比例、截图），那可以后续单独加，
但那是「体验增强」，不是「能不能播」的问题。

### 测试

- 新增 `direct-search-token-e2e`：真实页面形态 + search token + 175MB 直连
- `media-playback-check` 17 项：两关键点、运行时拼 URL、兜底通道

## [0.18.9] - 2026-10-25

### 回到直连流式：不把文件塞进 App 内存

上一版改成分块拉字节，方向还是错的。真正的原则很简单：

> `<video src="url">` 天生就是流式的。浏览器自己按需拉取，
> App 内存里只该有一个 URL 字符串。

175MB 也不需要读进来——那本来就该是浏览器的事。

### 之前为什么一直失败：token 取错位置

宿主 bundle 里的 `Iq()` 写得很清楚：

```js
function Iq(t) {
  const e = /^\/api\/apps\/([^/]+)\/ui(?:\/(.*))?$/.exec(t);
  ...
  const s = /* 段[1] */, i = /* 段[2] */;   // i = sessionToken
  return { kind: "scoped", appId: s, sessionToken: i, relativePath: ... };
}
```

而鉴权链是：
```js
const u = c.kind === "scoped" ? c.sessionToken        // ← 路径里的 token（权威）
        : t.req.header(EM) || t.req.query(Y2)          // header 或 query
        || cookie;
```

**`_surface/{token}/` 那一段就是权威 token。** 0.18.6 我误改成从 `location.search`
取（那里是空的），反而把唯一正确的来源丢掉了。

### 现在的做法

```
<video src="/api/apps/{id}/routes/external/raw?path=...&appSurfaceSession={pathname里的token}">
```

- 默认直连，浏览器原生 Range 流式拉取，App 内存只有 URL
- token **pathname 优先**，`location.search` 只作老宿主兜底
- 失败才条件兜底：≤64MB 取字节走 blob；>64MB 直接给系统播放器入口
- 真实错误上屏（`取字节失败 · HTTP 403（鉴权未通过）`）

### 端到端验证（这次完全按真实形态）

真实页面 `/api/apps/nian-vault/ui/_surface/{token}/panel.html`，
页面脚本只做一件事：`v.src = mediaSrcUrl(file)`，**不 fetch**。

```
视频: 175.0 MB
状态: meta 8531s 1600x720
Range 请求次数: 4          ← 只发了 4 段 Range，没有整读
readyState: 4
duration: 8531
→ ✓ 直连流式可用（未把文件塞进内存）
```

**4 次 Range 请求**就是证据：浏览器自己把元数据解出来了，
175MB 的 mdat 主体根本没动。

### 测试

- 新增 `direct-stream-e2e`：真实页面 + 真实 `<video src>` 直连 + 175MB 视频
- `media-playback-check` 重写 18 项：直连构造、token 来源优先级、默认路径
- `ext-raw-path-check` 7 项：宿主两条读取路径

## [0.18.8] - 2026-10-25

### 把失败原因摆到脸上 + 大文件改分块拉

上一版失败时界面只显示「读不到文件内容」——因为 `catch` 把真实错误
只写进了 `console.warn`。等于我自己把诊断信息藏了。

这版：

- **真实错误上屏**：`HTTP 403（鉴权未通过）`、`第 7 段失败：HTTP 500`、
  `只读到 73.5 MB / 175.0 MB，未读完` 这类信息直接显示在失败面板
- **大文件走分块 Range**：每段 4MB，逐段拉取
  - 服务端本来就支持 206，分块能给准确进度
  - 绕开「一次性返回超大响应体」这类未知限制
  - 首段顺便探路：能拿 206 就分段，拿 200 说明服务端忽略 Range，回退流式读
  - 空段直接收手，不死循环

### 实测数据（这些排除了「速度限制」这个猜测）

后端 `/external/raw` 两条路径都验过：

```
带 Range   → fs.openSync 直接读盘，不碰宿主接口
             206 / 1MB / Content-Range 正确
不带 Range → extFs.readBytes 走宿主资源接口
             175.0 MB 完整读回，842ms（宿主侧 94ms）
```

宿主资源审计日志（resource-audit.jsonl）显示每次 `stat`/`read` 都是 `allowed`，
没有拒绝记录。所以不是权限问题，也不是磁盘速度问题。

### 关于「内置轻量播放器」

没有内置。判断依据：

- 播放器库（video.js / artplayer / plyr）负责的是**控件和解码调度**，
  它们不管字节怎么来——仍然要 App 自己提供数据源
- 当前卡点是**数据获取层**（一次性 175MB 进内存），换播放器不改变这一点
- 前端拿到 blob 之后，原生 `<video>` 本来就是最优解，不需要中间层

如果分块拉取仍不理想，下一步该做的是**服务端转封装**（把 moov 移到文件头），
让 MP4 变成可流式播放，而不是加播放器。

### 测试

- `media-playback-check` 25 项：分块逻辑、进度、MIME、在线分流、错误上屏
- `ext-raw-path-check` 7 项：真实宿主两条读取路径 + extFs 调用追踪
- `media-bytes-check` 9 项：175MB 完整读取 + Range
- 改动范围外的测试未全量重跑（按用户要求只测改动处）

## [0.18.7] - 2026-10-25

### 换思路：本地文件不当网址用，取字节再播放

前六版都在围绕「怎么让 `<video>` 自己去请求这个地址」打转——
Range、直连、token、静态目录，一层层修。方向从一开始就偏了：

> **本地文件不是网址。**

`<video src>` 天生是为网络资源设计的，用在磁盘文件上要穿过鉴权、
静态目录、CSP、Range 语义一堆关卡，每关都可能出岔子。
自己把字节取回来、交给播放器，一关都不用过。

### 新逻辑

```
本地文件 → hana.api.fetch 取字节（流式，带进度）→ Blob → blob: URL → <video>
在线地址 → 直接给 src（真正的网络流才该交给浏览器）
```

- 读取时显示进度条（`读取中 42%（73.5 MB / 175.0 MB）`），不是黑屏干等
- 按扩展名推断 MIME（mp4/webm/mkv/avi/mov/mp3/flac…），
  免得 blob 类型不对被播放器拒绝
- 失败时给明确原因 + 「用系统播放器打开」按钮
- 删掉了整套 `mediaSrcUrl` 直连逻辑（34 行，无残留引用）

### 顺带挖出的真问题：这个 MP4 的索引在文件尾部

用 ffprobe 和 box 扫描查了那个 175MB 的视频：

```
ftyp(0.0MB)  free(0.0MB)  mdat(170.3MB)  moov(4.8MB) ← 在最后
```

`moov` 是 MP4 的元数据索引（时长、分辨率、关键帧位置）。
它在文件**末尾**，意味着浏览器必须**先读完整文件**才能知道这视频多长、怎么解码。

这就是为什么所有「边下边播」方案在这个文件上都不行——**不是代码问题，是文件结构**。
也解释了之前各种 `readyState` 卡死、黑屏、超时。

而 blob 方案天然绕开这一点：整文件进内存，moov 自然到位。

### 验证

Node 端真实取字节（175MB）：
```
读取耗时 1031ms，2801 个 chunk
✓ 字节数完整   ✓ MP4 魔数 ftyp   ✓ 文件头尾与磁盘一致
```

MP4 结构分析 + 完整解码：
```
moov 在尾部 → 必须读完整文件（已确认为黑屏根因）
完整字节 ffprobe 可解：8530.7s，h264 720x1600（旋转标记）
```

Range 能力保留（在线视频仍需要）：206 + Content-Range + 4MB 单段钳制。

### 测试

- 新增 `media-playback-check` 22 项：取字节通道、进度、MIME、在线分流、失败出路
- 新增 `media-bytes-check` 9 项：真实 175MB 完整读取 + Range
- 新增 `mp4-moov-check` 8 项：box 结构分析 + 完整字节可解码
- 新增 `mp4-structure-check`：moov 位置诊断工具
- 更新 `fix-0181` / `fix-0182` 断言，删除已废弃的 `mediaSrcUrl` 相关测试
- **1038 项** + 28 视觉全绿

### 关于「换轻量播放器」

没有引入第三方播放器库。原因：
video.js / artplayer / plyr 都是「控件 + 解码调度」，字节来源仍要自己解决。
换了库，取字节这一层的问题（token、moov 在尾部）一个都不会消失，
反而多一层要排查的封装。原生 `<video>` + Blob 是浏览器给的标准能力，够用。

## [0.18.6] - 2026-10-25

### 视频黑屏的最后一层：token 抓错了地方

上一版把 URL 改到 `routes/` 后仍然报错误码 4。真正的错在**凭据取错源**。

SDK 里的权威实现只有四行：

```js
function readSurfaceSession(w) {
  return new URLSearchParams(w.location.search).get("appSurfaceSession") || null;
}
```

真正的 token 在 **`location.search`**（URL 的 `?` 后面）。
而我一直在 pathname 里正则抓 `_surface/{...}` 那段——
那其实是 base64 编码的 session 描述 JSON：

```
eyJzY2hlbWFWZXJzaW9uIjoxLCJzZXJ2aWNlSWQiOiJhcHBzZXNzaW9uOjc0YjgyZTRmIn0
→ {"schemaVersion":1,"serviceId":"appsession:74b82e4f"}
```

拿这个描述当 token 去请求 → 宿主校验不过 → 返回 403 的 **JSON** →
`<video>` 收到 JSON → `error.code = 4`（来源不支持）。

### 为什么图片/PDF/docx 一直是好的

它们全部走 `hana.api.fetch`，而 SDK 内部会自动从 `location.search` 取 token 放 header。
只有视频为了支持 Range 流式播放，绕开 SDK 自己拼 URL，于是掉进了这个坑：
拼对了路径、拼错了凭据。

### 修法

```js
const token = new URLSearchParams(location.search).get("appSurfaceSession") || "";
```

一行。没有新增依赖，没有换播放器。

### 关于「换轻量播放器」

没有换，理由是**换播放器解决不了这个问题**：
video.js / artplayer 只负责解码和控件，字节还得自己去取；
token 抓错，任何播放器都拿不到数据。
原生 `<video>` 本身没问题——端到端测试里 `readyState=4`（HAVE_ENOUGH_DATA）
就是浏览器把整条流读到「数据足够」的硬证据。
多引一个库只多一层可能出错的地方。

### 验证（完全复刻宿主形态）

页面：`/api/apps/nian-vault/ui/_surface/{base64描述}/panel.html?appSurfaceSession=TOKEN`
视频：`/api/apps/nian-vault/routes/external/raw?path=...&appSurfaceSession=TOKEN`

真实 Edge + 真实 175MB 视频：

```
状态: meta 8531s 1600x720
{ code:'timeout', readyState:4, duration:8531, vw:1600 }
→ ✓ 完整加载
```

### 测试

- `mediasrc-url-check` 重写 10 项：强制断言「token 来自 search 而非 pathname 描述」
- 新增 `video-e2e-real`：复刻真实页面形态的端到端加载验证
- 31 个测试文件 **1412 项** + 28 视觉 + 13 docx 布局，全绿

## [0.18.5] - 2026-10-25

### 黑屏真凶：视频请求打到了 ui 静态目录，404 HTML 被当成视频

0.18.4 的错误码 **4（来源不支持）** 加上截图里的 URL 形态，把答案摆在了明面上：

```
页面：/api/apps/nian-vault/ui/_surface/{token}/
我拼：/api/apps/nian-vault/ui/_surface/{token}/external/raw?path=...
                                                    ↑ 这个路径不存在于 ui/ 目录
```

`ui` 是**静态文件服务**——它只返回 `ui/` 目录里真实存在的文件。
`external/raw` 是后端 Hono 的动态路由，挂的是 `routes/` 前缀。
我把动态路由挂到了静态目录下 → 服务器返回 404 的 **HTML 错误页** →
`<video>` 拿到一坨 HTML → `error.code = 4`（来源不支持）。

所以前几版 Range、CSP、内存全是对的，**可我请求的根本不是那个路由**。

### 修法：走 routes + 凭据放 query

```js
/api/apps/{appId}/routes/external/raw?path=...&appSurfaceSession={token}
```

为什么凭据能放 query：宿主鉴权链是
```
header(X-Hana-App-Surface-Session) || query(appSurfaceSession) || cookie
```
（bundle 里鉴权函数就这么写）。`<video src>` 带不了 header，但带 query 没问题。

库内文件同理：`/api/apps/{id}/routes/_assets/x.mp4?appSurfaceSession=...`
（之前也是靠 /_assets/ 直接给的 hana.api.fetch，标签用不了，现在统一了）

### 验证（这次是端到端，不再靠推断）

起真实 HTTP 服务 + 真实 175MB 视频 + 真实 Edge 浏览器的 `<video>`：

```
状态: meta 8531s 1600x720
{ ok:false, code:'timeout', readyState:4, duration:8531 }
→ ✓ 完整加载（readyState=4 = HAVE_ENOUGH_DATA）
```

`readyState: 4` 是硬证据：浏览器把整个视频流读到「数据足够」状态，
时长 8531 秒（=2.37 小时，与 ffprobe 一致）、分辨率 1600×720 全对。
headless 里 `play()` 被自动播放策略挡住导致 currentTime 停在 0，
那不是加载问题（真实 App 里用户点播放即可）。

### 测试

- 新增 `mediasrc-url-check` 11 项：两种页面 URL 形态下拼出的 routes 地址全对
- 新增 `video-e2e-check2`：真实浏览器 + 真实视频的端到端加载验证
- 31 个测试文件 **1209 项** + 28 视觉 + 13 docx 布局，全绿

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
