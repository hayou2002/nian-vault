# 念念收藏夹（nian-vault）

个人数字资产仓库，运行在 Hana（OpenHanako）平台上的 v2 App。把文字、网页、视频、图片、文件引用、经验笔记统一收藏成一个可备份的 Markdown 库，AI 协助归档整理，Agent 干活时可直接调用库内资产。

当前版本：**0.20.0**（详见 CHANGELOG.md）

## 它解决什么问题

- **预览力所能及**：图片、音频、PDF、Word（.docx）、Excel、PPT 双击即在面板内看；本地视频走「用系统播放器打开」——App 沙箱读不到库外大文件，硬塞进去只会黑屏，不如直接交给系统
- **收藏什么都能装**：笔记、剪藏、B站视频（带封面卡与内嵌播放）、文件路径引用、经验台账……类型存在每条的 front matter 里
- **AI 是整理员**：对话里丢一条链接说「收藏这个」，Agent 会抓取正文/封面/元信息后入库；也能让 AI「把收件箱里同类的归到一起」
- **数据是你自己的**：整个库就是一个文件夹，Markdown 文件即数据库，可直接打包备份、可换存储位置，没有私有格式绑架

## 架构与目录

```
nian-vault/
├── manifest.json        # Hana v2 App 清单（capabilities: tools.expose-to-model + resources.read/write）
├── index.js             # App 入口：注册 UI 路由 + 8 个 AI 工具
├── lib/
│   ├── frontmatter.js   # 条目 .md 的 front matter 序列化/解析（每行 key: <JSON 值>，同时是合法 YAML）
│   ├── storage.js       # 双后端：NodeFs（dataDir 内）/ ResourceFs（盘外自定义位置，走 sdk.resources）
│   ├── vault.js         # 核心库操作：分类/条目/搜索/双链/待办/树/拖拽层级/原子写/串行化
│   ├── routes.js        # UI 内部路由（HTTP 风格）
│   ├── ai.js            # 模型调用 + 暴露给 Agent 的工具实现
│   ├── article.js       # 网页正文抽取
│   ├── zip.js           # 库的打包 / 解包
│   ├── clip.js / clipstore.js  # 对话内收藏
│   └── cloud.js         # 云盘能力（可选）
├── ui/
│   ├── panel.html       # 三栏界面：分类树 | 条目列表 | 详情/编辑
│   └── assets/
│       ├── panel.js     # 全部前端逻辑（单文件，无框架）
│       ├── panel.css    # 样式，颜色全部走 --hana-* 主题变量
│       ├── markdown.js  # 自研渲染器（阅读视图用，XSS 安全）
│       ├── sdk.js       # Hana App UI SDK（卡片 iframe ↔ 宿主通信）
│       ├── vendor/      # 预览组件：docx-preview / jszip / pdf.js / SheetJS
│       └── vditor/      # 内置 Vditor 3.x（所见即所得编辑器，离线可用）
└── assets/icon.svg      # 身份图标
```

## 数据格式

库根目录默认在 App 数据区（`~/.hanako/app-data/nian-vault/vault`），可在界面「⚙ 存储位置」改到任意盘。结构：

```
vault/
├── _vault.json          # 分类清单（名称/描述/星标），原子写
├── 收件箱/              # 一个分类 = 一个文件夹
│   └── {id}.md          # 一条收藏 = 一个带 front matter 的 md 文件
├── _assets/{年月}/      # 编辑器上传的图片
└── _trash/              # 删除的条目进回收区，不直接物理删
```

front matter 字段（`lib/frontmatter.js` 的 FM_KEYS）：

| 字段 | 含义 |
|---|---|
| id / title / type / tags | 基本身份；type ∈ note,text,link,image,video,file,folder,memory,experience |
| source | 来源 URL 或本机路径 |
| cover / embed | 封面图 URL 与内嵌播放器 URL（视频/网页收藏） |
| pinned / homePinned | 列表置顶 / 钉在首页（两个独立语义） |
| parent / order | 树状层级的父条目 id 与同级排序（拖拽维护） |
| created / updated / opened | 时间与最近打开 |
| hideTodos | 该篇待办不在首页汇总显示 |

## 界面功能地图

- **◈ 首页**：待办汇总（勾选直接改回原笔记行）、📌 固定区、◷ 最近打开、🗂 分类树概览
- **左栏**：分类树，▸ 展开后是递归层级；条目可拖拽嵌套（拖到目标上=变子条目，拖到上缘=移出父级）；☆ 星标分类
- **中栏**：条目列表 / 卡片视图（▤ 切换，卡片带封面图）；搜索、四维排序、勾选批量操作
- **右栏**：详情（封面卡 + B站内嵌播放、反向链接面板、正文内待办可点）/ 编辑（Vditor 所见即所得；输入 `[[` 弹自动补全；拖图片进编辑器自动上传）
- **双链**：`[[标题]]` / `[[标题|别名]]` 语法，渲染成可点击链接，代码块内不算数

## AI 工具（8 个，注册名会带哈希后缀）

| 工具 | 用途 |
|---|---|
| nian_vault_save | 收藏一条内容（网页/视频先 web_fetch 抓正文与封面再入库） |
| nian_vault_search | 全库搜索（标题/标签/正文加权） |
| nian_vault_get | 按 id 读全文 |
| nian_vault_categories | 列分类 |
| nian_vault_update | 更新/移动/置顶/挂层级某条 |
| nian_vault_save_file | 把本机文件登记成 file 类型条目（只存路径引用） |
| nian_vault_list_inbox | 列收件箱待整理条目 |
| nian_vault_batch_move | 批量改分类/加标签（AI 归并同类的主力工具） |

## 安装

**不需要装任何依赖**，也不需要 Node 环境——整个 App 只用宿主提供的 SDK 和
Node 内置模块，预览用的第三方库（docx-preview / jszip / pdf.js / SheetJS）
已经放进 `ui/assets/vendor/`。

1. 打开 Hana（OpenHanako）→ 设置 → 应用
2. 选「导入应用」，指向这个目录（或把 `nian-vault-<版本>.zip` 拖进去）
3. 首次启动会在 `<Hana 数据区>/app-data/nian-vault/vault` 自动建库，开箱可用

数据默认落在上面那个位置，可在界面「⚙ 存储位置」改到任意盘。换机器时把
那个文件夹拷过去即可，全是 Markdown，没有私有格式。

### 验证（开发者用）

```sh
# 静态校验（0 error 为准，1 条 DYNAMIC_DEPENDENCIES 为已知 warning）
node <hana仓库>/scripts/validate-app.mjs --dir /path/to/nian-vault

# 模拟别人装上能不能直接用（拷到临时目录、查依赖/路径/资源、真启动）
node tools/fresh-install-check.mjs
```

## 测试（不依赖 Hana 运行时，node ≥ 20 直接跑）

```sh
node tests/vault-check.mjs          # 库核心 204 项（父子层级/防环/待办回写/原子写）
node tests/routes-check.mjs         # 路由层 76 项
node tests/preview-check.mjs        # 预览分发 18 项
node tests/video-removed-check.mjs  # 视频已下线 + stat 大小兜底 34 项
node tools/panel-symbols-check.mjs  # 前端符号可达性 29 项（jsdom 真执行）
node tools/panel-reachability.mjs   # 每个顶层定义逐个探测
node tools/video-hint-visual.mjs    # 视频提示块真实 CSS 渲染 18 项
```

> 有 8 个测试（`ui-check` `boot-check` `preview-real-check` 等）依赖一套
> 早期的 jsdom eval 桩，那个桩不支持 `import.meta`，**改动之前就是红的**，
> 与产品无关。真要修得重写桩，见「已知边界」最后一条。

## 已知边界与坑（给接手者）

- **App 沙箱读不到库外大文件**：`--permission` 只放行 `apps/` 与 `app-data/`，
  子进程继承同一套限制；宿主 `resources.read` 只能整读且 RPC 单消息上限 32 MiB。
  所以**本地视频不做内嵌预览**，一律交给系统播放器——这并不是偷懒，
  是唯一能工作的做法。别试图用 Range/分块绕，源头就读不出来。
- **App 沙箱无外网**：网页抓取必须由 Agent 侧 web_fetch 完成后转存，App 内不做 fetch 外部站点
- **出图白名单**：封面只放行 https 图片；内嵌播放只放行 `player.bilibili.com`
- **卡片 iframe 里 `window.prompt/confirm` 静默失败**，一切弹窗用自绘 `dialog()`
- **PowerShell 写 JSON 会带 BOM** 破坏 manifest 解析，落盘一律用无 BOM UTF-8
- **`_vault.json` 与条目写入全部走 `serial()` 串行 + 临时文件 rename 原子写**，改 vault.js 时别绕开
- **树里删父条目**：子条目自动上提挂到祖父下，不会变孤儿；**跨分类移动**：父链断、子孙随行
- iframe 内 jsdom 测不出的视觉问题（flex 挤压、字号）只能真机验收

## 交接说明（给其他 Agent）

1. 先读 CHANGELOG.md 了解演进，再读本 README 的「架构与目录」定位要改的文件
2. 所有写操作走 `Vault.serial()`；改数据格式先看 `lib/frontmatter.js`
3. 改完跑三套测试（187 项），UI 改动需要真机看
4. 设计参照系：思源笔记（层级/双链/拖拽语义）、Karakeep（收藏卡片）、Obsidian（补全与反链面板）——调研细节见 RESEARCH.md
