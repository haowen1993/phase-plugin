# phase-plugin 技术笔记

这份文档面向「要改这个工具」或「想知道它为什么这么做」的人。
**安装与日常使用看 [README.md](README.md) 就够了。**

---

## 它需要 phase.rs 的仓库吗？

**不需要。** 运行时完全独立：书签就是一段在页面里执行的 JS，它不认识 phase.rs 的代码、
不 import 任何东西、不请求任何接口。它能工作的全部依据是「应用渲染出了
`cards.scryfall.io` 的卡图 URL」这一件事。

唯一的例外是一个**可选的**守卫脚本：`tools/check-app-data-coverage.mjs` 读
`client/public/scryfall-*.json`，那是 phase.rs 仓库里的生成物。没有仓库它跑不了，
但**工具本身照常工作**。

所以：phase.rs 的仓库可以不要。本仓库是独立仓库
（<https://github.com/haowen1993/phase-plugin>），克隆它就能开始开发，不需要
phase.rs 的任何东西。想跑那个可选的覆盖率守卫时，才需要另外克隆一份 phase.rs。

## 效果与实测覆盖率

| 情况 | 显示 |
| --- | --- |
| 大学院废墟有该印刷的简体中文图 | 中文卡图（`images.mtgch.com/zhs/…`） |
| 大学院废墟没有中文图 | 大学院废墟的英文图（`images.mtgch.com/sf/…`） |
| 大学院废墟连英文图都没有 | 回退到应用原本的 Scryfall URL（兜底） |

覆盖正面、背面（双面牌）、`small` / `normal` / `large` 三种尺寸，以及衍生物（token）。

实测（用 phase.rs 自己的 90,607 张印刷数据取样，`Range: 0-0` 每张只探 1 字节）：

| 样本 | 大学院废墟英文图 | 简体中文图 |
| --- | --- | --- |
| 最新 60 张（含 2027 促销、2026 Star Trek） | 60/60 = 100% | 0/60（这些本来就没有中文印刷） |
| 随机 60 张（1993–2027） | 60/60 = 100% | 25/60 = 42% |

所以第三级（退回 Scryfall）在实际样本里一次都没触发；它守的是「新系列刚发售、
Scryfall 已有图而大学院废墟还没同步完」那段窗口。

## 原理：三级阶梯

两张 CDN 的 URL 形状一一对应，差别只有 host、`/zhs|sf/` 前缀和扩展名：

```
https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg?1783921885   ← 应用原本输出
        │  在属性写入时同步改写（small | normal | large，正/背面）
        ▼
https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp          ← 中文卡图
        │  404（该印刷没有中文图）
        ▼
https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp           ← 大学院废墟的英文图
        │  404（兜底，几乎不会发生）
        ▼
https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg              ← 绝不让画面比原版更差
```

**判据就是 404，不需要查 API。** 大学院废墟对没有中文图的印刷直接让 `/zhs/` 路径返回
404，脚本在图片加载失败时把该元素降到下一级。全程自动，你不参与任何判断。

`art_crop`（插画裁切）直接走 `sf` 层：画框裁切只是插画本身，与语言文字无关，大学院
废墟也没有 `zhs/art_crop`（实测 404）。其 `sf/art_crop/…` 实测为 626×457，与 Scryfall
的 art_crop 尺寸一致，换过去不改变取景。

### 为什么书签能做到这件事

脚本要在浏览器发起请求**之前**改掉属性值，否则会先闪一下英文图。React 通过
`node.setAttribute("src" / "srcset", …)` 写属性，而只有**页面自己的 JS 世界**才改得动
页面原型——浏览器扩展的隔离世界改不了（所以扩展必须声明 `world: "MAIN"`），
userscript 管理器的默认沙箱也改不了（所以必须写 `@inject-into page`）。

书签的 `javascript:` 地址**本来就在页面自己的世界里执行**，这个坑天然不存在。

代价是注入时机由你点击决定，而不是页面加载时。脚本对此不敏感：它既给后续的属性写入
打补丁，也会在注入瞬间扫一遍页面上已存在的卡图，所以点之前已经渲染出来的卡同样会变中文。

### 三个必须小心的地方

**一、失败时不能交给应用自己的降级链。** phase.rs 的 `CardImage` 带
`onError={() => advanceFailedSource(src)}`。一旦换上去的图加载失败，应用的降级链会以为
这张卡的美术挂了，把整张卡换成**纯文字占位**——比看到英文卡图糟得多。所以脚本在捕获
阶段拦下 `error`、自己降级，并用 `stopPropagation()` 阻止应用的 `onError` 触发。只有
退到最后的 Scryfall 层还失败时，才放手让应用按原有逻辑降级。

`stopPropagation()` **必须同步调用**（v1.1.0 修正）。React 19 把 `onError` 委托在根
容器上，靠事件在 window 捕获阶段被拦下来才不会触发；而脚本要先 `await` 一个存在性探测
才知道该重试还是降级。把拦截放到 `await` 之后就晚了——事件传播早已结束，应用的降级链
照跑不误。所以顺序是：**先同步拦下（纯 URL 判断，不需要网络），再异步决定怎么改**。

**二、退到 Scryfall 层会死循环。** 写回 Scryfall URL 会再次经过我们补丁过的
`setAttribute`，于是被立刻打回中文层，形成 `404 → 改写 → 404`。所以退级前先把该
`印刷id:尺寸` 记入一个内存里的「放弃」集合，`rewriteUrl` 对已放弃的图原样放过。
按尺寸而不是只按印刷做键：`sf/art_crop` 缺失不代表同一张印刷的 `zhs/normal` 也缺失。

**三、失败 ≠ 404，这是 v1.1.0 修掉的那个「时好时坏」。** `<img>` 的 error 事件不带
状态码，「这张印刷没有中文图」和「这次没连上」长得一模一样。早期版本把两者都当 404
直接降级，于是一张**有**中文图的牌碰上一次网络抖动就被永久打成英文，而「放弃」集合记下
之后本次加载再也不重试。现在降级前先发一个便宜的存在性探测（`Range: bytes=0-0` 的
GET）：206/2xx → 原地重试（带新缓存参数，最多 2 次）；404/410 → 降级；探不动（无
fetch、被 CSP 拦、5xx、超时）→ 按存在处理，重试一次再降级。

这不是假想的边角情况，是实测出来的：

| 实测项 | 结果 |
| --- | --- |
| 同一个卡图 URL 连续 12 次请求 | **只有 1 次**拿到 200，其余是连接被拒 |
| `images.mtgch.com` 的 DNS | CNAME 到腾讯 EdgeOne，一次解析出 **4 个地址**，多数拒连 |
| 每个响应的 `access-control-allow-origin` | **出现两次**（都是 `*`）。浏览器直接判该响应无效，所以带 `crossOrigin="anonymous"` 的请求**永远**失败 |
| 同样这些图，经**同源**中继取 | 10/10 成功 |

最后两行解释了 phase.rs 中文分支为什么要自建 `/card-art` 同源中继——那个重复的 CORS 头
是图床自己的问题，客户端绕不开，只能不跨源。本脚本因此也认得中继地址
（`/card-art/zhs|sf/…`，相对路径），降级时**只换层级、不换寻址方式**：把相对路径写成
绝对地址会把那条刻意绕开的 CORS 又拉回来。带 `crossOrigin` 的元素上的**跨源** Scryfall
地址则一律不改写——换过去只会从「有英文图」变成「没图」。

另外，重复点击书签不能让同一张图降两级（两个 error 监听各降一级就会跳过英文层），
所以装配带一道幂等闸；重复点击只会重新扫一遍页面。

## 阶段图标替换

除了卡图，脚本还把回合阶段栏的 **12 个内联 SVG 图标**换成公开图标库的图形。

### 图形从哪来

**不自己画。** 12 个图标全部取自两个宽松许可的图标库：

12 个图标**全部**来自 **[Tabler Icons](https://tabler.io/icons)（MIT 许可）**。

早先混用过 Lucide（ISC）与 Tabler 两家，后来把非 Tabler 的 6 个图标全换成 Tabler 的
对应图形，**就是为了把许可面从两份收窄到一份**。代价是「扫帚」变成了「刷子」
（Tabler 没有 broom）。

版权声明与许可全文收录在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。MIT 允许
再分发，所以 `LICENSE` 不需要为图标加例外；但 MIT 要求「版权声明与许可声明出现在所有
副本中」，那份文件就是为满足这一条而存在的——**改图标时别忘了同步它**。

**刻意不用 Apple 的 SF Symbols**：它的许可把使用范围限定在「运行于 Apple 系统上的
App」，网页不在内，而本项目允许别人再分发——把它塞进来就得在 README 里写一段自己
没有资格授予的限制。

### 12 个图标的对应关系

| 阶段 | 图形 | 出处 |
| --- | --- | --- |
| 重置 Untap | 顺时针环形箭头 | `tabler/rotate-clockwise` |
| 维持 Upkeep | 齿轮 | `tabler/settings` |
| 抓牌 Draw | 卡牌 | `tabler/play-card` |
| 第一主阶段 | 方框 + `1` | `tabler/square-number-1` |
| 战斗开始 | 交叉双剑 | `tabler/swords` |
| 宣告攻击者 | 单手剑 | `tabler/sword` |
| 宣告阻挡者 | 盾牌 | `tabler/shield` |
| 战斗伤害 | 火焰 | `tabler/flame` |
| 战斗结束 | 三角旗 | `tabler/flag-3` |
| 第二主阶段 | 方框 + `2` | `tabler/square-number-2` |
| 结束步骤 | 沙漏 | `tabler/hourglass` |
| 清理 Cleanup | 刷子 | `tabler/brush` |

顺带修掉了原版的两处重复：`PreCombatMain` 与 `PostCombatMain` 原本是**同一个菱形**，
`BeginCombat` 与 `CombatDamage` 原本都是交叉双剑（只差中心一个圆点）。

### 怎么认出每个 SVG 是哪个阶段

12 个里有**两组图形完全相同**，所以光看 SVG 内容分不出来。第一层判据是**结构**：

| 容器 | 判据 | 对应 |
| --- | --- | --- |
| `[data-combat-phase-indicator]` | 5 个，源码顺序 | `COMBAT_PHASES` |
| 组内 3 个 | 玩家 HUD 左条 | Upkeep / Draw / PreCombatMain |
| 组内 2 个 | 玩家 HUD 右条 | PostCombatMain / End |
| 12 个一组 | 手机操作行与阶段抽屉 | `ALL_PHASES`（CR 500.1 全序列） |

结构判据不读任何文案，所以换成英文界面照样工作。第二层用 `aria-label` 里的描述文案
做**交叉校验**，只在结构判据已经有结论时打个警告，不参与定位——上游改了顺序或措辞时
这条警告就是最先冒出来的信号。

手机端 Chip 是唯一的例外：它是唯一自带 `aria-haspopup="dialog"` 的阶段图标，先靠这个
结构特征认出「这是 Chip」，再用 `phaseName` 表定阶段。

**认不出来就不动。** 没有兜底规则：一个 4 个按钮的容器实测会被「默认按全序列」认走 3 个，
而把某个阶段的图标画到另一个阶段上比不换糟得多。

### 为什么不用 MutationObserver 硬扛重渲染

React 重渲染其实**很少**碰这些图标，实测依据来自源码：

- `PHASE_ICONS` 是模块级常量，每次渲染返回的是**同一个 React element 对象引用**。
  React 在 reconcile 时遇到 `prevChild === nextChild` 会直接 bailout，不生成任何 patch。
- 就算不 bailout，React 也只增删改它自己管的属性（`class`、`d`…），不会清空整个元素，
  所以我们贴的 `data-prz` 与换过的子节点都不受影响。
- 桌面端最常看的 5 个图标在 `GamePage.tsx` 里被 `useMemo(() => <PlayerHud />, [])` 固定住，
  DOM 一次挂载后不再重建。

真正会丢的只有「组件卸载后重建」这几种（横竖屏切 `CombatPhaseIndicator`、开局时
`MobilePhaseChip` 从 null 变有、打开阶段停止抽屉）。所以 `MutationObserver` 只当**兜底**：
监听 `childList`，发现没打过标记的阶段图标就补一次扫描。它**不和卡图那个观察器合并**——
那个挂的是 `attributes` + `src`/`srcset`，两种语义混在一个回调里会让两边都变难读。

`data-prz` 标记同时是防死循环的闸：我们的写入会再次触发观察器，认标记就不会无限循环。

### 图标尺寸：内容放大 1.15 倍

图标库给的是 24×24 网格，但网格四周各留了约 2 的空白，缩到 10px 时实际图形只占约
8.3px，比原版 14×14 的图标显得轻。做法是**绕画布中心把内容放大 1.15 倍**。

**为什么是「缩放内容」而不是「收窄 viewBox」。** 收窄 viewBox 看着更省事，但两条路
都走不通，都渲染对比过：

- `viewBox="0 0 20 20"`：这是**矩形裁切**四周各 2 单位。圆形图标（target 外圈到半径
  9，`x` 到 3）左右两端正好落在裁切线上，会被切掉。
- 收窄 viewBox 再让内容缩小去适配：内容缩到 20 却仍摆在 24 画布里，**反而比原来更小**
  （20/24 = 0.83 倍）。

放大按 viewBox 单位算，所以描边宽度（同样是 viewBox 单位）跟着一起变粗——这正好，
图形变大而线条不变粗反而会显得单薄。

### 怎么确认图标放大后没超出画布

`ICON_ZOOM` 把内容绕中心放大 1.15 倍，图形可能顶出 24×24 的画布。这件事**用纯逻辑测
不可靠**，做过三版都失败，而且失败方向是**假绿**（把图形改到画布外，测试照样通过）：

1. 只认大写 `M`/`L`：漏掉小写 `v`/`h`。把 flag-3 的竖杆拉到 y=30，测试照样绿。
2. 补上相对命令：`M8 6h.01` 这类相对小点被当成绝对坐标，误报「抓牌跑到画布外」。
3. 按时序追踪当前点：Lucide 齿轮图标里有**隐式重复**的圆弧命令
   （`a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915` 是两段），按「末两个数是
   终点」取会参数错位，又一次误报。

更根本的是：**圆弧与贝塞尔曲线会鼓到端点之外**，所以「端点都在画布内」推不出「图形在
画布内」。这是方法论问题，不是解析器写得不够好。

所以改用 `tools/check-icon-fits.mjs`：起一个 headless Chrome，对每个图标调
`getBoundingClientRect`，取**渲染后的真实包围盒**（曲线、圆弧、线帽全算进去），再换算回
24 网格的用户单位。

两个必须记住的坑：

- **`getBBox()` 不能用**：它返回**未经变换的局部坐标**。把 `ICON_ZOOM` 从 1.15 改到
  1.5，它给出的四个数一模一样——拿它判边界就是假绿。`getBoundingClientRect` 才是屏幕
  像素、包含祖先链上的所有变换。
- **`viewBox` 不裁剪内容**。实测 `<svg viewBox="0 0 24 24">` 里画 `M4 24V30`，笔画照样
  画到元素底部。所以「越界」不会表现为「被切掉」，而是**图形过大、重心偏移、可能盖到
  相邻的按钮上**。检查量的是「有没有超出画布」，不是「有没有被裁」。
- Tabler 的图标开头都有一条透明占位路径（`stroke="none"` 的 `M0 0h24v24H0z`），它撑满
  整个画布。算进去的话每个图标都「刚好占满」，什么都查不出来——必须按 `stroke` 过滤掉。

当前结果：12 个图标全部在画布内，最小余量 0.40 单位（Cleanup / End / CombatDamage /
DeclareBlockers 这几个贴得最近）。

### 两个主阶段：用图标库里现成的「方框带数字」

换过五版，全部记下来——这段弯路值得留着，因为每一版失败的原因都不同：

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| 1 | 圆 + 数字 `1`/`2` | 单看一个数字读者不知道它指什么；10px 下也糊 |
| 2 | `target` 同心圆 + 右上角挂一个「M1」小角标 | 图形仍是 target，两个主阶段看起来还是同一个图案；而且几何上无解（见下） |
| 3 | 圆角矩形包着 M1/M2 | 图形本身成了标签，重叠问题没了，但外框让字变小、整体笨重 |
| 4 | 去掉外框，手绘「M1」「M2」 | 手画的字精细度比不过专业图标库：太宽太挤、和旁边图标不像一套 |
| 5 | **`tabler/square-number-1` / `-2`** | 现成的方框带数字，一对齐；12 个图标终于一视同仁 |

**第 2 版那条几何上无解的约束**值得单独记：图标本身只有 10px，而要在角上写清两个
字符至少横向要 6 个单位，24 网格里放不下「角标与图形不重叠」。

**为什么第 3、4 版都不如第 5 版**：手绘字形每个方向都在互相拉扯——高度要留住（不然
10px 下糊）、宽度要收（不然显大）、字间距要拉（不然两笔连成一团）、笔画要减（不然显
重）。四个方向只能一起调，而调出来的结果仍旧比不上 Tabler 里已经调好的现成图标。

Tabler 的 `*-number-N` 是一整个系列（支持 0–4，还有 `square-rounded-`、`circle-`、
`hexagon-` 等形状，以及 `square-letter-*` 字母版）。这次选了直角方框，因为它和
phase.rs 按钮本身的圆角形状拉开层次。

**实现上，两个主阶段现在没有任何特殊路径**：它们就是 `PHASE_ICON_INNER` 里的两个
普通条目，和其他 10 个走完全相同的「取图形 + 套 1.15 倍放大」流程。方框原始范围是
3..21，放大后 1.8..22.2，仍在画布内。

### 和卡图逻辑的关系

两者**操作对象完全不相交**：卡图改 `HTMLImageElement` 的 `src`/`srcset`，图标换
`SVGSVGElement` 的子节点。观察器各挂各的（一个 `attributes`，一个 `childList`），
补丁各打各的，谁也唤不醒谁。

唯一共用的是幂等闸 `__phaseZhCardArtInstalled`：重复点击书签时两边都不该再挂第二份监听，
而「补一次扫描」对两边都成立。

## phase.rs 更新了怎么办

**通常什么都不用做。** 这个工具依赖的是四个「外部契约」，都不是 phase.rs 的内部实现：

1. 卡图 URL 的形状——那是 **Scryfall** 的格式，不是 phase.rs 的代码；
2. 应用用 `<img>` + 属性写入渲染卡图——React 的通用行为；
3. 应用带 `onError` 降级链——我们压住它，即使它被删掉我们也不受影响；
4. 大学院废墟的路径约定——第三方。

真要动手的情况只有这几种：

| 变化 | 症状 | 需要改什么 |
| --- | --- | --- |
| phase.rs 换掉卡图 CDN（不再用 Scryfall） | 点书签后**完全没反应** | 改 `src/content.js` 里两个 host 常量与路径判断（几行），重新构建 |
| 大学院废墟改了路径 | **静默**退回英文图或 Scryfall | `node tools/check-live.mjs` 会直接告诉你 |
| phase.rs 加了严格 CSP | 书签完全失效（控制台报 CSP 违规） | 书签路线走不通，需要改成浏览器扩展。本仓库不含扩展代码，得重写（`src/content.js` 的逻辑可以直接复用，要改的只是「怎么送进页面主世界」那一层） |
| 新增卡图尺寸（如 `grid`、`thumb`） | 只有那批图保持英文 | 往 `FACE_SIZES` 加尺寸；不加也不影响其他卡 |
| 应用改成完全不写 `src` 属性 | 完全没反应 | 现在还有 `MutationObserver` 兜底；连属性都不写就得换方案 |

**更新后花两分钟自查：**

```bash
node tools/check-live.mjs    # 第三方那一侧（需要网络，在本仓库里跑）

# 应用那一侧：该脚本读 client/public/scryfall-*.json，所以要在 phase.rs 克隆的
# 根目录下运行，指向本仓库里的脚本（本仓库不需要是 phase.rs 的子目录）
cd /path/to/phase-rs-clone
node /path/to/phase-plugin/tools/check-app-data-coverage.mjs
```

再用浏览器打开应用点一次书签，随便看一张卡。三条都过就什么都不用做。

## 本地需要留什么

**必留**（这就是后续开发所需的全部）：

```
src/content.js                  逻辑——你唯一要改的文件
tools/build-bookmarklet.mjs     重新生成三个产物
test/content.test.mjs           零依赖测试（node --test）
dist/                           产物；可再生，但留着省事
README.md                       面向使用者：安装与常见问题
NOTES.md                        本文件：设计、维护、分发
```

**可选**：

```
tools/check-live.mjs              守大学院废墟那侧的 URL 约定（需要网络）
test/assembly.dom.mjs              DOM 装配测试（需要 node_modules）
vitest.config.mjs  package.json    上面那个测试的配置
tools/check-app-data-coverage.mjs  守应用那侧；只有留着 phase.rs 仓库才有用
node_modules/                     esbuild + vitest + happy-dom，删了 npm install 就能回来
```

重新构建需要一个 **esbuild**，而它已经是本仓库的 devDependency——`npm install` 之后
`npm run build` 就能用。构建脚本的查找顺序是：

1. `ESBUILD_BIN` 环境变量（想指定某个特定版本时用）；
2. **本目录自带的 `node_modules/.bin/esbuild`**（主路径；显式找它，所以直接
   `node tools/build-bookmarklet.mjs` 也能跑，不必经过 npm）；
3. `PATH` 上的任意 esbuild（`brew install esbuild` 也行）；
4. 万一本目录被放进某个 phase.rs 克隆里，用它 `client/` 下已装好的那份。

也就是说本仓库自带构建依赖，不依赖任何外部环境。

## 维护

```bash
npm run build      # 从 src/content.js 重新生成 dist/ 三件套
npm test           # 零依赖：纯逻辑 + 产物同源/等价校验（18 项）
npm run check:live # 对真实图床核对三级阶梯（需要网络）
npm run test:dom   # DOM 装配测试（11 项，需先 npm install）
```

`node_modules/` 只是 `test:dom` 需要的 56 MB，随时可以删掉重新装。如果 `npm install`
报 `EPERM` 或「cache folder contains root-owned files」（本机就遇到过），那是在用系统
级 npm 缓存导致的，两种解法：

```bash
npm install --cache /tmp/npm-cache     # 换一个私有缓存目录，立即绕开
sudo chown -R $(id -u):$(id -g) ~/.npm # 或者根治那个缓存目录的属主
```

`npm test` 里有三道防漂移，保证「逻辑只有一份」不是靠自觉：

1. 书签地址必须是**单行、纯 ASCII、无控制字符**。压缩器会把源码里的 `"\t"` / `"\n"`
   改写成真实控制字符，所以 `src/content.js` 里刻意用码点表做空白比较。
2. 压缩正文尾部记录的 `src/content.js` sha256 必须对得上；安装页里记录的哈希、以及
   安装页里可拖拽的链接与 `.txt` 的一致性，也一并校验。
3. 压缩后的正文与源码在干净沙箱里跑同一组断言，逐项比对结果。

改了源文件却忘了重新生成，第 2 条会直接失败。

`npm run test:dom` 覆盖的是纯函数测试看不出来的部分：给 `Element.prototype.setAttribute`
打补丁能否拦住 React 的写入、捕获阶段**同步** `stopPropagation()` 能否压住应用的
`onError`、降级阶梯是否只走一级、抖动时是否原地重试且次数有上限、中继地址是否只换层级
不换寻址方式、带 `crossOrigin` 的跨源地址是否原样放过、重复装配是否幂等。

这套测试里 `fetch` 被换成了替身，由 `setProbe("present" | "missing" | "unknown")` 决定
探测怎么回答——不挡的话它会去打真实的 `images.mtgch.com`，而那个图床的抖动率会让断言
随机红绿。探测结果本身有 30 秒缓存（真实使用里这是省请求的关键），所以 `setProbe` 会
顺手清掉缓存，否则用例之间会串味。

### 悬停时「先空白、等一会儿才出图」是怎么来的

用户报过一个很具体的现象：同一手牌里，鼠标悬停时有的卡立刻出图、有的先空白一会儿、
有的先出「找不到图」的占位再出图。**他确认过：只有装了本脚本才这样。**

三个原因，都跟「换算发生在什么时候」有关：

1. **换算发生在失败之后，就必然多一轮往返。** 表里没有的中文 id 会先按原 id 拼一个
   必然 404 的地址 → 浏览器白跑一次请求 → 失败路径查表 → 换成正确 id 再发一次。
   这一轮往返的耗时决定了那张卡「空白多久」，而每张卡撞上的缓存/网络状况不同，
   于是同一手牌里表现得五花八门。

2. **反查表是懒加载的，第一次用到它时谁在等谁不确定。** 谁先撞上「表里没有的 id」，
   谁就替后面所有卡把表拉起来。表到之前失败的那些卡各自走了一遍上面的往返。

   → 修法：**装配时就预载**（`install()` 里 `isChineseUi()` 为真就拉）。实测这份表
   下载 + 解析合计约 **68 ms**，提前拉几乎不花时间，却能让第一次渲染就用对 id。
   只在中文界面下拉——英文界面一次都用不上，没必要白占 4 MB 流量。

3. **曾经在「表到了」之后把全文档的图片重写一遍**，`src` 一改浏览器就重新下载，
   已经显示出来的图会闪一下甚至先空一会儿。这是最直接的闪烁来源。
   → 改成**谁失败了谁自己纠正**：失败路径查表后只改那一张，其他图完全不受影响。

**现场诊断**：控制台执行 `__phaseZhCardArtReport()` 会返回一份快照——每张卡走到哪一层、
有几张已加载失败、反查表是否就绪、走了几次 API 换算。排查「哪张卡为什么慢」先看它。

### 卡图（1.9.4 起）：自己把本地化表取回来（修掉 Safari 上一片 404）

**现象**：Safari 中文界面下，控制台一大片 404：

    GET https://mtgch.com/api/v1/card/023332ea-aa2b-4ae1-99d1-e02d0b56b4ae/  → 404
    GET https://mtgch.com/api/v1/card/87586070-ed73-44f9-9e52-50f3d4790bd9/  → 404
    … 十几个

查过：这些 id 在 Scryfall 里全是 **`lang: zhs`（中文印刷）**。也就是说**没还原成英文 id**，
把中文 id 原样拿去问大学院了。

**根因**：截获 `fetch` 只在「书签在应用加载那张表**之前**执行」时才有效。而实际用起来是
**先打开页面、应用早把表加载完，然后才点书签** —— 于是永远截不到。后果很隐蔽：那些卡
查不到图，就**永远不会被换成大学院的图**（不报错、不崩溃，只是悄悄不生效）。

**修法**：截不到就**自己去取那张表**。URL 就在线上 bundle 里（不用猜）：

    await fetch("https://data.phase-rs.dev/scryfall-images.v2.{lng}.json".replace("{lng}", e))

三个要点：

1. **语言代码取主标签。** 表按 `zh` / `ja` / `de` 分文件，`zh-CN` 与 `en` 都是 404
   （英文界面应用不加载表 —— 地址里本来就是英文 id，不需要）。
2. **表到手后必须重扫一遍。** 表到手之前，中文界面下的地址还原不出英文 id，那些卡已经
   被跳过了；不重扫它们永远不会被处理。
3. **按语言记「取过没有」**，不是「取过就不再取」：phase.rs 允许不刷新页面就切语言，
   切到另一种非英文语言时要换一份表。

流量上不亏：表有 ETag，实测第二次是 **304、下载 0 字节**，而且应用本来也要下这一份。

实测（headless Chrome，中文界面，**不预置任何表**）：

    初始 src: …/9a235bac….jpg        ← 应用写出来的【中文印刷 id】
    索引条数: 123745                 ← 自己取回来了
    最终 src: …/00006596….webp       ← 还原成【英文印刷 id】查到了大学院的图

---

### 卡图（1.9.3 起）：修掉「图闪一下才出来」

**现象**：每次悬停（应用重渲染把 `src` 写回 Scryfall 时），图会先闪一下才出现。

**根因**：两件事叠在一起。

1. **应用那张 Scryfall 图在玩家本地是热的** —— 交手、滚牌用的都是它，已经在浏览器缓存里，
   显示是瞬时的。
2. **我们换上的大学院图本地是冷的** —— CDN 侧不慢（实测冷启动 **79ms**，而 Scryfall 是
   **1025ms**），但玩家本地没下过，得真下。

于是「把快的换成要现下的」，中间那段没有图可显示 —— 就是那一下闪。

**解法：先暖后换。** 先把大学院的图拉进浏览器图片缓存，**暖好了再写 `src`**。换的那一刻
直接命中缓存，实测 **8ms**、**0 闪烁帧**。

两个细节：

- **顺序不能反。** 一边预热一边立刻换更糟：实测首次要 **616ms**（两边抢带宽）。
- **预热记录要跨页面保留**（存 `localStorage`）。大学院图床是
  `cache-control: public, max-age=31536000, immutable`（一年不可变），所以预热过的地址
  下次打开页面时浏览器缓存里仍然有，可以直接算暖。不记的话每次刷新后**第一次**悬停都要
  重下（实测 **745ms**），还是闪。记了之后：首次 745ms / 之后 **9ms**。

用 `new Image()` 预热而不是 `fetch`：`fetch` 会真读字节（费内存与时间），而 `new Image()`
走的就是 `<img>` 之后要用的那份**图片缓存**。

---

### 卡图（1.9.1 起）：中英文界面都生效，走大学院 API

**1.9.1 的关键改进：截获应用自己的本地化表。**

大学院图床只认 **Scryfall 的英文印刷 id**，而 phase.rs 在中文界面下会把地址**本地化**：
`localizeImageUrl()`（`client/src/services/scryfall.ts:622`）拿英文印刷 id 去查
`localeArtResolved.map`，查到就换成中文印刷的 URL。所以中文界面下渲染出来的地址里
是**中文印刷 id**。

那张表是应用自己 fetch 来的：

    const resp = await fetch(__SCRYFALL_IMAGES_LOCALE_URL_TEMPLATE__.replace("{lng}", lang));
    return parseLocalizedArtMap(await resp.json());

书签在页面自己的 JS 世界里执行，所以**可以包装 `fetch` 截获这个响应**（`clone()` 一份
给应用、一份给我们，应用看到的字节完全一样），**零额外流量**。

#### 为什么是「按 URL 精确匹配」而不是「按 id 反查」

试过下载那张表、按「中文 id → 若干英文 id」反查，**31% 的卡会指到别的整卡**：

| 中文 id 的反向情况 | 占比 |
| --- | --- |
| 唯一（1 个英文 id）→ 能精确还原 | 68.9% |
| 歧义（≥2 个）→ 还原不了 | **31.1%** |

根源是上游的 `same-card-localized-printing-v1` 回填算法（`scripts/lib/localized-image-fallback.py`，
由 **Makeinu1** 在 `6b58a6b5a` 引入，动机是「Wizards 的官方简体中文印刷在 Bloomburrow
（2024-02）之后就停了」）——它按 `oracle_id` 分组，把一张本地化图指派给该牌**所有**缺图
的英文印刷。基本地最严重：一个中文「山脉」被 **598 个**英文印刷共用，而它们的插画本来
各不相同。

**按 URL 精确匹配没有这个问题**：表里每条记录的值就是该英文印刷的中文图 URL，也就是应用
写在 `<img src>` 上的那个字符串——命中的是**唯一一条**记录，那条记录的**键**就是英文
印刷 id。

```
"00006596…"(英文 ZEN#21) → faces[0].normal = "…/9a235bac….jpg?1783014248"
"540f3ddf…"(英文 GN3#14) → faces[0].normal = "…/540f3ddf….jpg?…"
```

两条不会撞，所以还原精确且唯一。

#### 两个踩过的坑

1. **必须先查表、再按形状解析。** 本地化后的地址与英文地址**形状完全一样**（都是
   `cards.scryfall.io/<size>/front/<a>/<b>/<uuid>.jpg`），区别只在那个 uuid 属于哪套
   id 空间。所以「按形状解析」对两者都会成功——先走它的话，中文地址会原样返回中文 id，
   表现为「中文界面下等于没生效」。
2. **索引是模块级且幂等的**（不覆盖已有键），所以测试之间要清空，否则第二个用例的
   `added` 会是 0 —— 那是测试污染，不是实现问题。

#### 时序上的兜底

如果书签点击时应用**已经**加载完那张表，响应就截不到了。此时：
- 英文界面不受影响（地址里本来就是英文 id）
- 中文界面下该图的地址还原不出来，`englishPrintingIdOf` 返回 null，**保持原样不换** ——
  宁可换不成，也不会换成别的整卡

---

### 卡图（1.9.0）：只在英文界面生效

> ⚠️ 已被 1.9.1 取代，保留以记录当时的取舍。



**这一节是当前实现。下面「所有图都走大学院废墟，以及中文印刷 id 这个坑」记的是
1.8.x 的做法，已经整体废弃** —— 保留它是为了记住为什么那条路走不通。

## 为什么中文界面不碰卡图

1.8.x 试过在中文界面下也换卡图，做法是「用大学院图床的地址规律去拼」。走不通：

- 大学院图床用的是 **Scryfall 的英文印刷 id**，而 phase.rs 中文界面给的是**中文印刷
  id**。实测两者**完全不相交**（84393 条映射里交集只有 4 个）。
- 于是要换算，就得下载 phase.rs 那张 33.9 MB 的映射表（线上 4 MB）**倒过来查**。
- 而那张表是**多对一**的：一个中文 id 平均被 2.07 个英文 id 指向，**31% 的卡有歧义**。
  实测「寇族验装兵」的中文版同时被 `zen#21` 与 `gn3#14` 指向，而那是**两张不同的整卡**
  （基本地更糟：不同系列的插画整个不一样）。

**反查会指到别的整卡。** 这条路的收益（中文卡图）phase.rs 自己已经提供了，所以直接
放弃，只在英文界面下工作。中文界面下卡图部分完全不装配、一个请求都不发。

## 现在怎么做（英文界面）

    1. 认出应用写的 Scryfall 地址，从文件名取出英文印刷 id
    2. GET https://mtgch.com/api/v1/card/{英文印刷id}/
    3. zhs_image_uris 存在就用它（中文），否则用 image_uris（大学院英文图）
    4. 把 src 与 srcset 换成对应尺寸的大学院地址

第 3 步的**回落意味着永远不会没图**：跨 12 个系列实测 3409 张有中文、1329 张回落到
大学院英文图、0 张无图。

### 关于大学院 API 的几个实测事实

- **只有 v1**，`/api/v2` 与 `/api/v3` 都是 404。
- 有 OpenAPI 文档：`https://mtgch.com/api/v1/openapi.json`（153 个端点）。
- `GET /api/v1/card/{uuid}/` **只认大学院自己的 id**。用中文印刷 id 查是 404，用
  oracle id / illustration id / mtgjson id 查也是 404，查询参数一律被忽略。
- 响应里有个 `scryfall_card_uuid` 字段，**存的其实是 MTGJSON 的 UUID**（实测与
  `mtgjson_id` 完全相同），不能拿来换算。
- 单卡查询实测 **52~132 ms**。CORS **对所有来源放行**（回显 Origin）。
- 另一个更好用的端点：`GET /api/v1/set/{系列}/cards/?unique=scryfall_id`，
  **一次返回整个系列**并带现成的 `image_url`（已自动选好中文/英文）。将来嫌单卡慢
  可以改用它。

### 已知取舍：会有一次闪烁

地址是应用先写进 DOM 的，浏览器立刻就发请求了，API 回来之前英文图可能已经显示出来。
先显示（哪怕短暂是英文）比先空白更好——这是刻意的选择。要改成不闪，就在换好之前把
img 置为 `visibility: hidden`（不影响布局，不会跑位）。**用户明确选了这个取舍。**

### 实现上的两个要点

- **原型补丁而不是只靠观察器**：`MutationObserver` 的回调是异步的（一个微任务之后），
  而 `setAttribute` 补丁在属性写入的那一刻就能拿到 id 并发出请求，让 API 往返与浏览器
  加载原图**并行**。补丁是**只读**的（不改 value），真正的写入在 Promise 回调里，
  所以不会递归。
- **补丁自带被包住的原生方法**（`patched.__phaseZhNative`）。不做这件事的话，测试里
  存下来的「原生方法」其实已经是打过补丁的，还原就还原不掉，表现为「中文界面下仍然会
  发请求」这种假失败。踩过。

---

### 卡图：所有图都走大学院废墟，以及「中文印刷 id」这个坑

> ⚠️ **1.8.x 的做法，已废弃。** 保留是为了记住为什么走不通，别再改回去。



要求是**中英文卡图一律走大学院图床**。要做到这一点，必须先搞清一件事：

**大学院图床用的是 Scryfall 的「英文印刷 id」。** 而 phase.rs 在中文界面下会查它自己
那份 `scryfall-images.v2.zh.json`，把地址换成**中文印刷的 id**。这两组 id **完全不相交**
——实测 84393 条映射里，中文 id 与英文 id 的交集只有 **4 个**。

后果：只要地址里是中文 id，大学院必然 404。实测 60 个中文 id：`/zhs/` **0/60**、
`/sf/` **0/60**，而同一批 id 在 Scryfall 上 **60/60**。用户看到的正是「有中文图的卡
反而裂了」——图确实能显示（走 Scryfall），但那不是大学院的图。

**另一个必须记住的点**：中文地址在 Scryfall 上**能加载成功**，所以**不会触发 `error`**，
失败路径根本没机会跑。因此换算必须**在请求发出之前同步完成**。

换算分两条途径，先便宜的后贵的：

| 途径 | 成本 | 何时用 |
| --- | --- | --- |
| **反查表** | 一次下载 4 MB，覆盖 84386 条 | 首选 |
| **Scryfall REST API** | 每张卡 1~2 个请求 | 表还没到 / 表里没有 |

反查表就是从 phase.rs 自己发布的那张映射表**反过来读**：

```
https://data.phase-rs.dev/scryfall-images.v2.zh.json     ← 线上 4 MB，CORS 全开
```

它本来是「英文 id → 中文 id」，倒过来就是「中文 id → 英文 id」。**零 API 调用。**
只在真的遇到一个查不到的 id 时才去下载，所以英文界面下永远不会拉这 4 MB。

REST 兜底用的是 `oracle_id` 而不是 `illustration_id`：后者只在「同一张插画被重印」时
才跨语言一致，而 `oracle_id` 标识的是**这张牌本身**，任何语言的任何印刷都指向同一个值。

**踩过两次的坑：`shardA`/`shardB` 是 id 的前两个字符，换 id 就必须一起换。**
`urlFor` 用的是 `parsed.ref` 里的分片，只改 `printingId` 会拼出
`/front/d/0/0000579f-…` 这种「分片目录与文件名不符」的地址，大学院直接 404。
两处（`rewriteUrl` 与失败路径）都踩过，现在都有单测守着。

顺带一提：`stopPropagation()` 拦下应用自己的 `onError` 是必要的（否则应用会把整张卡换成
纯文字占位），但也意味着**我们必须自己兜住所有失败**——这正是上面那条链路存在的理由。

### 替换手法：只读 + 旁挂（**别改回就地修改**）

用户报过「用了之后游戏崩溃」，界面是 phase.rs 的 ErrorBoundary 兜底页，而且
**点书签时没事、玩一会儿切换阶段才崩、每次都复现**。

根因是替换手法本身：早先是就地改那个 `<svg>`——设 viewBox / fill / stroke，再
`innerHTML =` 换掉它的子节点。那会**把 React 记账的 `<path>`/`<circle>` 从 DOM 里摘掉**，
并往 `<svg>` 里塞进 React 不知道的 `<g>`。React 后续任何一次针对那些节点的操作
（重渲染、卸载、切换子节点）都可能出问题。

现在的做法是**只读 + 旁挂**，一个 React 拥有的节点都不动：

| | 原版 `<svg>` | 注入的 `<svg>` |
| --- | --- | --- |
| 归属 | React | 我们 |
| 属性 | 只加一个 `data-prz-src` 标记 | 图标库那一套（24 网格、描边式） |
| 子节点 | **原样不动** | 图标库的图形 |
| 样式 | `visibility: hidden` | 绝对定位覆盖在原位 |

几个必须记住的点：

- **用 `visibility: hidden`，不是 `display: none`。** 原版要**继续占着**它那格布局；
  一旦退出布局，按钮里其它依赖流式排布的兄弟会跑位。实测 `visibility: hidden` 的元素
  `getBoundingClientRect()` 仍返回真实尺寸，只有 `display: none` 才归零。
- **尺寸靠照抄 class。** 注入节点与原版 class 相同、又在同一个父容器里，所以整条 CSS
  级联（按钮里的 `h-2.5 lg:h-3.5`、chip 与抽屉里父级的 `[&>svg]:h-3`…）对两者的结果
  必然一致。试过写 `width`/`height` 属性（会和 CSS 打架：CSS 只约束高度时属性又把宽度
  定死，实测注入 14px 而原版 4px）和写内联像素（当下一定对，但站点 CSS 变化时不会跟着
  变），都不如照抄 class。
- **位置要实测锚定。** 绝对定位元素的「静态位置」在 flex 容器里与原版并不总是重合
  （实测 10 个里有 1 个横向偏 3.7px，因为原版是被 `justify-center` 居中的 flex item）。
  用 `offsetLeft`/`offsetTop` 照抄：它的定义就是「相对 offsetParent 的边框盒偏移」，
  与绝对定位 `left`/`top` 的基准天然一致。**不要**自己拿两个 `getBoundingClientRect()`
  相减——那是边框盒坐标，会漏掉祖先的 border 与 padding（试过，10 个全偏）。
- **观察器里对原版节点的插入要 `record.preventDefault()`**：等于告诉 React「这次没插成」，
  它会去插自己的下一个候选，把控制权交回 React。
- **组内计数只数原版**（`groupFans`）。每个阶段恰好一个原版，序号与源码顺序一一对应；
  把注入节点也算进来会让一个 3 阶段的容器变成 6 个「扇区」，组识别直接失效（踩过）。

**两条只在真浏览器里才查得出来的坑**，都已经被 `npm run check:crash` 的「视觉核对」
（原版与注入必须同位同尺寸，容差 0.5px）自动挡住：

1. **先隐藏再量尺寸 → 量到 0 → 图标整个消失。** 当时想「量出来再藏」，顺序写反了。
2. **行内 `<svg>` 没有宽高属性时在浏览器里是 0×0**（与 `<img>` 那种替换元素不同）。
   原版平时能显示完全靠 Tailwind 的 `h-2.5 w-2.5` 撑着——所以拿掉 CSS 去量是量不到的。

### 为什么「异常绝不泄漏」是硬要求

**phase.rs 把任何未捕获异常都上报成 `js_error`**：

```js
// client/src/services/telemetryEvents.ts
window.addEventListener("error", (event) => trackEvent("js_error", errorFields(event.error, ...)));
window.addEventListener("unhandledrejection", (event) => trackEvent("js_error", ...));
```

用户报过一次「用了之后游戏崩溃」，界面是 phase.rs 的 `ErrorBoundary` 兜底页。所以对我们
来说，**代码里任何一处没接住的异常，在用户那里都表现为「游戏崩溃」**——哪怕它其实只是
一条卡图处理失败。

于是所有异步/事件入口都必须自己接住异常。清单（改动时别漏）：

| 入口 | 为什么危险 |
| --- | --- |
| 卡图的 `MutationObserver` 回调 | 观察器回调抛错没人接，直接变成未捕获异常 |
| 阶段图标的 `MutationObserver` 回调 | 同上 |
| `window` 的 `error` 捕获监听（`onResourceError`） | **每次图片加载失败都会调用**，是触发最频繁的入口 |
| `scanCardImages` / `scanPhaseIcons` | 逐条 try，一张失败不该带走整轮 |
| `resolveTierFailure(...)` 的 Promise | 它是 `async`，用 `void` 调用**不接住拒绝** → `unhandledrejection` |
| `install()` 本体 | 初始化抛错会让整个功能不可用，还会被记成 `js_error` |

`test/assembly.dom.mjs` 末尾有一组「异常绝不泄漏给页面」的用例守着这条不变量。

**排查这类问题的工具**：`npm run check:crash`——在真实 Chrome + 真实 React 里跑「注入图标
→ 反复切换阶段 → 同时压卡图失败路径」，检查有没有未捕获异常、有没有出现兜底界面。

一个方法论上的教训：**persist 用纯 DOM 模拟（happy-dom）复现不出真浏览器的行为**，
而且 React 19 的 `render()` 不包 `act()` 时根本不会落到 DOM 上，用例会**假绿**
（我一开始就是这么被骗过一轮的）。所以这个检查必须在真浏览器里跑。

### 图标对照页怎么重建

```bash
npm run build:preview
```

产出两份：

- `docs/icon-comparison.png` —— README 里内联的那张对照表（GitHub 直接渲染图片）
- `preview/current-icons.html` —— 交互页，多出 10px 与激活态、以及「按真实阶段栏排列」

**原版图标是从 phase.rs 源码里解析的**，不手抄：读
`<phase.rs>/client/src/components/controls/PhaseStopBar.tsx` 的 `PHASE_ICONS`。所以需要
一个 phase.rs 克隆，路径按 `$PHASE_RS_DIR` → `../phase` → `../phase.rs` → `~/phase` 的顺序找，
找不到会明确失败。手抄一份进本仓库会随上游改动悄悄过时，不如要不到就报错。

两处必须注意：

1. **JSX 属性名要转成 SVG 属性名**（`strokeWidth` → `stroke-width`）。源码是 TSX，
   直接把 JSX 塞进 HTML 的话描边宽度完全不生效，原版图标会全画成细线。
2. **标记必须在 Node 侧拼好，不能把函数源码塞进页面。** 踩过一次：把 `svNew` 的函数
   源码内联进页面，而它的函数体引用了 `icons.viewBox`——`icons` 只存在于 Node 侧，浏览器
   里抛 `ReferenceError` 让整段脚本挂掉，页面渲染出来只有表头、正文全空。而且那个失败
   很像「截图时机不对」，容易往错的方向查。

截图那块也踩过两个坑，都写进脚本注释了：`--screenshot` 只截窗口大小（给大了留空白、
给小了裁内容），所以改成**先用 `--dump-dom` 量出页面实际尺寸、再按尺寸截**；另外
Chrome 可能在内容画完之前就落盘，但那次实测的根因其实是上面的 `ReferenceError`，
不是时机问题。

### 手动验收

1. 打开 <https://phase-rs.dev>，进入一局游戏或打开牌组。
2. 点一下书签栏里的「中文卡图」。
3. 卡图应为简体中文。Web Inspector → 网络 过滤 `images.mtgch.com`，应看到 `/zhs/…` 200。
4. 找一张确实没有中文图的印刷（例如 Unfinity 的 *Standard Procedure*）：应显示英文
   卡图，**而不是**文字占位卡——网络面板里先出现 `/zhs/…` 404，紧接着 `/sf/…` 200。
5. 刷新页面且不再点书签，卡图应恢复为原版 Scryfall 英文图。
6. 连点两次书签：不应有任何异常（幂等）。
7. 设 `__phaseZhCardArtDebug = true` 后反复翻牌组：控制台只应在**真的缺中文图**时打印
   「降级」；若某张牌反复打印「原地重试」然后仍是英文，说明图床那天确实不稳定。
8. **阶段图标**：点完书签后，头像两侧与右侧战斗条上的 12 个图标都应换成新图形。原版的
   太阳 / 水滴 / 菱形 / 沙漏 / 小人一律不该再出现。
9. 两个主阶段应当是**方框里带 1 / 2** 的现成图标，一眼可分（不再共用同一个图形）；
   若某个阶段设了停止点，中下方的黄点不应和方框挤在一起。
10. 12 个图标整体应比图标库默认尺寸**显大**（内容放大 1.15 倍），且线条不显单薄。
10. 在阶段栏上悬停、点击切换：图标应随状态变色（未激活灰、悬停变白、激活纯白）——
    和原版行为一致。若颜色不跟随，说明 `stroke/fill="currentColor"` 被破坏了。
11. 窗口高度跨越断点（拉窄到横屏手机尺寸）让战斗条隐藏再出现：图标应当自动补上，
    不应退回原版图形。这一条验的是 MutationObserver 兜底。
12. 手机尺寸下打开阶段停止抽屉（点头部的阶段胶囊）：抽屉里 12 行的图标也应是新图形。

## 已知限制

- **每次重新加载页面后要点一下。** 页面内跳转不需要。
- **只作用于网页版。** 桌面版（DMG / Tauri 套壳）是个把 WebView 导航到
  `https://phase-rs.dev` 的壳，书签在 WebView 里用不了。
- **不翻译界面文案。** 只改卡图。
- **没有中文图的卡会闪一下，而且 v1.1.0 起更久了一点。** 中文层失败后要等一次存在性探测
  有结果才降级到英文层。探测带 `Range` 只取 1 字节、结果缓存 30 秒，正常在几十毫秒内
  回；但图床不稳定时最坏要等 4 秒（超时上限）。同一张图在一次会话里只发生一次。
  这是「宁可多等一会儿也不要把有中文图的卡误判成缺图」的取舍。
- **探测失败会让重试次数上限生效得晚一点。** 每张图最多原地重试 2 次，用尽后即使图还在
  也会降级——一个永远取不到的资源不能把页面拖在重试循环里。
- **中文图由第三方社区站点提供。** 覆盖范围与画质取决于大学院废墟；刚发售的新系列
  可能还没镜像，此时靠英文层或 Scryfall 兜底，不会出现裂图。
- **只处理应用实际使用的四种尺寸**（small / normal / large / art_crop）。遇到 `png`、
  `border_crop`、`thumb` 等尺寸原样放过，不猜。
- **依赖站点没有严格 CSP。** 目前 phase.rs 生产站点（Cloudflare Pages 的 `_headers`
  与 GitHub Pages 预览）都只设缓存头，实测确认。书签靠 `javascript:` 执行，受
  `script-src` 管辖；若将来加了 CSP 会直接失效。同时若 CSP 限制 `img-src`，还需把
  `https://images.mtgch.com` 加进白名单。

## 隐私

**不发送任何「关于你」的数据。** 没有分析、没有上报、不读取页面内容，不碰
`localStorage` / `sessionStorage` / cookie，不查任何 API，不缓存图片。「放弃」与「重试次数」
两个账本都只存在于内存，刷新页面即清空。

v1.1.0 起有一处**明确的例外**，必须说清楚：图片加载失败时，脚本会向**那个图片自己的
URL** 发一次 `Range: bytes=0-0` 的 `fetch`，只为读状态码（404 = 这张印刷真没有中文图，
其余都当网络抖动）。它没有 URL 参数、没有请求体、不带凭据（`fetch` 默认
`credentials: "same-origin"`，而这些都是跨源或同源静态资源），响应体也从不读取。

换句话说：请求的目标**永远只是那张卡图本身**，任何一张卡图本来就会被浏览器请求一次；
探测只是让「这次到底有没有取到」这个答案变得可读。这是本脚本唯一需要的网络能力，
也是它能把「抖动」和「404」分开的唯一手段。

对代码做过能力面审计：`XMLHttpRequest`、`sendBeacon`、`WebSocket`、`import()`、`eval`、
`new Function`、`GM_*` 全部 0 处；`fetch` 只有上面那一处，且**只在图片已经加载失败之后**
才会用到（正常浏览过程中一次都不发）。

## 归属与许可

**代码**用 [MIT](LICENSE)，版权归 `haowen1993`。选它的理由：小工具、无专利风险，MIT 的
「随便用/改/再发，只要保留版权声明」就够了；而且 phase.rs 本身是 `MIT / Apache-2.0`
双许可，同向选 MIT 不会有将来合并回上游的许可障碍（Apache-2.0 多出的专利条款是给大
项目用的，这里属于多余复杂度）。

**阶段图标跟着 MIT 走**，因为它们的来源同样是宽松许可：

- 12 个图标全部来自 **[Tabler Icons](https://tabler.io/icons)**（MIT 许可）。
  MIT 允许再分发，所以这些图形可以随本仓库一起以 MIT 分发，`LICENSE` 不需要加例外条款；
  但它要求「版权声明与许可声明出现在所有副本中」，所以仓库根有一份
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 收录完整的版权行与许可全文。
  **改图标时要同步那份文件。**
- 早先混用过 Lucide（ISC），为了把许可面从两份收窄到一份，非 Tabler 的 6 个图标已全部
  换成 Tabler 的对应图形。
- **刻意没用 Apple 的 SF Symbols**：它的许可把使用范围限定为「运行在 Apple 系统上的
  App」，网页不在内。要用就得在 README 里写一段限制，而那段限制本仓库没有资格授予
  （不是 Apple，无权转授权）。

**卡图不在这份许可范围内**，它们各有归属：

- 卡图来自**大学院废墟**（[mtgch.com](https://mtgch.com)，图床 `images.mtgch.com`）。
  其中既包含官方简体中文印刷图，也包含社区制作的中文图；大学院废墟在 `zhs_image`
  字段里标注了每张图的来源（如 `官方`、`衍生物`、`TrentTouch`、`万智烽火`、`新版风云集`）。
- 本脚本**不复制、不缓存、不再分发**任何卡图，只在显示时把浏览器指向大学院废墟的图床。
  卡图的权利归属与使用条款由该站点及其上游来源决定。
- Magic: The Gathering 是 Wizards of the Coast 的商标。本脚本是非官方作品，与
  Wizards of the Coast 及 phase.rs 项目均无关联。

## 分发给别人

- **发文件**：把 `dist/install.html` 发过去（邮件、AirDrop、网盘都行）。对方用自己的
  浏览器打开，把按钮拖到书签栏就完事。文件纯自包含，不需要托管。
- **发一行字**：把 `dist/phase-plugin.bookmarklet.txt` 里那一整行（约 6.4 KB）连同
  「新建书签 → 把地址替换成这一行 → 打开 phase.rs 后点它」贴进聊天即可。
- **挂一个链接**：想给一群人用就把它挂到任意静态托管上分享 URL。
  例如用 GitHub Pages（`git subtree` 不一定可用，所以用临时目录建分支）：

  ```bash
  cd /tmp && rm -rf zh-pages && mkdir zh-pages && cd zh-pages
  git init -q -b gh-pages
  cp <本目录>/dist/install.html index.html
  git add . && git commit -m "docs: phase-plugin 安装页"
  git remote add origin <你的仓库地址>
  git push origin gh-pages   # 然后在仓库 Settings → Pages 里把 Source 选成 gh-pages
  ```

两点提醒：

1. **卡图是第三方社区站点提供的。** 分发给很多人等于把流量导向大学院废墟。脚本不缓存、
   不转发，每人每张图一次请求，与原本打 Scryfall 的流量同级；但量明显大了，最好知会
   对方一声。
2. **永远不要往分发包里放卡图文件。** 一旦放了，性质就从「运行时引用」变成「再分发」。

## 文件结构

```
phase-plugin/
├── README.md                               安装与日常使用（短）
├── NOTES.md                                本文件：设计、维护、分发（长）
├── src/content.js                          全部逻辑——唯一真源
├── dist/
│   ├── install.html                        安装页（拖拽 / 右键 / 复制地址）
│   ├── phase-plugin.bookmarklet.txt         书签地址（javascript: 一行）
│   └── phase-plugin.bookmarklet.js          未编码的压缩正文（供审阅）
├── docs/
│   ├── index.html                          GitHub Pages 入口，与 dist/install.html 逐字节相同
│   ├── icon-comparison.png                 README 内联的图标对照表（由 build:preview 生成）
│   └── .nojekyll                           让 Pages 跳过 Jekyll 处理
├── preview/
│   └── current-icons.html                  交互式图标对照页（由 build:preview 生成）
├── test/
│   ├── content.test.mjs                    零依赖：卡图纯逻辑 + 产物同源/等价校验
│   ├── phase-icons.test.mjs                零依赖：图标数据、字形几何、绘制指令
│   ├── assembly.dom.mjs                    DOM 装配测试：卡图（vitest + happy-dom）
│   └── phase-icons.dom.mjs                 DOM 装配测试：阶段图标的识别与替换
├── tools/
│   ├── build-bookmarklet.mjs               从 src/content.js 生成上面那些产物
│   ├── build-icon-preview.mjs              生成图标对照图与交互页（需要本地 Chrome）
│   ├── check-icon-fits.mjs                 量图标放大后有没有超出画布（需要本地 Chrome）
│   ├── check-crash-safety.mjs              真浏览器 + 真 React 压崩溃（需要本地 Chrome 与 phase.rs 克隆）
│   ├── crash-harness/harness.jsx           上面那个检查用的页面（复刻 PhaseDot 结构）
│   ├── check-live.mjs                      对真实图床核对三级阶梯
│   └── check-app-data-coverage.mjs         用 phase.rs 的数据核对 URL 识别覆盖率
└── package.json  vitest.config.mjs         仅 DOM 测试需要
```

**为什么 `docs/index.html` 必须存在**：GitHub **不渲染**仓库里的 `.html` 文件——点
`dist/install.html` 只会看到源码。所以「README 里点一下就能拖按钮」必须靠 GitHub Pages
提供一个真正的网页，而 Pages 只支持从分支根目录或 `/docs` 发布。这份副本由构建脚本
生成、与 `dist/install.html` 逐字节相同，并由测试守着不许漂移。

两个测试文件用后缀区分运行器，不是随意命名：`node --test` **只收集 `*.test.mjs`**
（实测确认），所以 `assembly.dom.mjs` 不会被它捡走；而 vitest 的 `include` 被显式配成
`*.dom.mjs`。这样零依赖那套永远不需要 node_modules。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 完全没有变化 | 绝大多数情况是**忘了点书签**，或刷新后没再点。点了还没反应就看 Web Inspector 控制台有没有 `[phase-plugin] 已启用 v…`。 |
| 点了书签但控制台没有那行 | 浏览器拦掉了 `javascript:` 地址，或你没把它建成书签（地址栏直接粘贴会被浏览器去掉 `javascript:` 前缀）。 |
| 卡图变成文字占位 | 说明应用自己的降级链接手了。请记下卡名，并跑 `npm run check:live` 看映射是否已变化。 |
| 一部分卡是英文 | 正常：大学院废墟没有这些印刷的中文图，已按设计降到英文层。 |
| 网络面板出现 404 | 正常：那是中文层的判据，紧接着会降级或重试。只有持续 404 且最终裂图才是问题。 |
| **时好时坏、同一张卡有时中文有时英文** | v1.1.0 已修。根因是图床那 4 个地址大多拒连，而旧版把「连不上」当成「没有中文图」。若在新版仍出现，`__phaseZhCardArtDebug = true` 后可在控制台看到每次是「原地重试」还是「降级」。 |
| **阶段图标没换 / 只换了一部分** | 先确认点过书签。控制台应打印 `[phase-plugin] 已启用 v1.2.0`。若某个图标仍是原版，多半是它所在的容器不符合已知的四种结构（3 个 / 2 个 / 5 个战斗 / 12 个一组）——脚本对认不出来的容器**故意不动**，以免把图标画到错误的阶段上。把 `__phaseZhCardArtDebug = true` 打开可以看到结构判据与文案判据不一致的警告。 |
| **阶段图标没换，但提示结构判据冲突** | 说明 phase.rs 改了阶段顺序或文案。结构判据优先（它是源码顺序），所以图标仍然是对的；那条警告是提醒你 `PHASE_TEXT` 表该更新了。 |
| 中文卡图旁边小图（srcset 的 146w）是英文 | 检查网络面板里 `/zhs/small/…` 的状态。若为 404，说明该印刷只有大图有中文；这是图床的事实，不是脚本的问题。 |

### 自己动手看一眼

在控制台里（点过书签之后）：

```js
__phaseZhCardArt.version                       // 装的是哪一版
__phaseZhCardArt.parseArtUrl("https://cards.scryfall.io/normal/front/f/2/f29ba16f-c8fb-42fe-aabf-87089cb214a7.jpg")
__phaseZhCardArt.givenUp.size                  // 已经放弃（确认缺图）的印刷数
__phaseZhCardArt.retryCounts.size              // 正在重试的印刷数
__phaseZhCardArtDebug = true                   // 之后每次失败都会在控制台说明重试还是降级
```
