# 念念收藏夹 - 更新日志

## [0.11.1] - 2026-10-24

### 去掉主页九宫格

用户反馈丑，改回文字列表。coverUrlOf/catHue 与九宫格 CSS 一并删除。

### 修：附件上传失败

**根因是我 0.11.0 重复造了一个坏路由。**

库里本来就有能用的 POST /asset/upload（FormData，file + subdir），我没查就新写了
POST /assets/upload 收 base64，前端还配了 `Array.from(buf)` ——
一个 1MB 图片会变成 100 万个数字的 JSON 数组，请求直接垮。
而且那条路由返回 `{ path }` 没有 `ok` 字段，前端读 `r.ok` 也会误判失败。

现在删掉我加的那条，前端改走已有的 /asset/upload + FormData，按 `j.path` 判成功，
并加了 20MB 前置检查（后端也有上限，两边一致）。

### 文件管理器：面板内文件预览

原来双击文件 = 跳出面板用系统应用打开，面板里什么都看不了。现在双击走 previewAsset：

- 图片：居中显示，限高不撑爆
- 视频/音频：原生播放器
- 文本/md：拉回来渲染，md 走 renderMarkdown（含 ![[资源]] 卡片），纯文本 pre 换行
- PDF：iframe
- 其他：图标 + 名字 + 大小 + 系统打开入口（诚实降级）

文本限长 20 万字符，超了截断并说明；读取失败显示错误，不假装空文件。

### MD 编辑器：Vditor 图片上传与路径解析

Vditor 原来没配 upload，也没处理相对路径：

- 配了 `upload.handler`，接同一个 /asset/upload，`filename` 用真实文件名（不用随机串）
- wysiwyg 下 `<img src="_assets/x.png">` 按面板 base URL 解析会裂，
  现在用 MutationObserver 把相对路径统一改写成 `../routes/_assets/...`
  （http/data/绝对路径不碰）

### 顺手修掉两个真 bug

1. **openAssetFile 里 `await` 在非 async 函数里** —— 语法错误，右键菜单
   「📂 用系统应用打开」从来没能成功过。已补 async。
2. **CSS 被误删** —— 删九宫格时用 `slice(0, indexOf(标记))` 截断，
   把加在后面的附件面板 CSS 和预览 CSS 一起删了。已重补。

### 测试

新增 fix-0111-check（50 项）：九宫格确认已删净、上传改走旧路由且没有爆体积写法、
预览的五种分支与降级、Vditor upload/MutationObserver、附件面板与资源索引没被误删、
五个源文件括号配平。

**13 个测试文件合计 623 项全绿。**

## [0.11.0] - 2026-10-24
