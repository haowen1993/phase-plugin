# phase-rs-zh 技术笔记

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
（<https://github.com/haowen1993/phase-rs-zh>），克隆它就能开始开发，不需要
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

| 库 | 许可 | 用了哪些 |
| --- | --- | --- |
| [Lucide](https://lucide.dev) | ISC | settings / swords / sword / shield / zap / flag / hourglass / broom |
| [Tabler Icons](https://tabler.io/icons) | MIT | rotate-clockwise / play-card / target |

ISC 与 MIT 都可以随本仓库（MIT）一起再分发，所以 `LICENSE` 不需要为图标加任何例外。

**刻意不用 Apple 的 SF Symbols**：它的许可把使用范围限定在「运行于 Apple 系统上的
App」，网页不在内，而本项目允许别人再分发——把它塞进来就得在 README 里写一段自己
没有资格授予的限制。

### 12 个图标的对应关系

| 阶段 | 图形 | 出处 |
| --- | --- | --- |
| 重置 Untap | 顺时针环形箭头 | `tabler/rotate-clockwise` |
| 维持 Upkeep | 齿轮 | `lucide/settings` |
| 抓牌 Draw | 卡牌 | `tabler/play-card` |
| 第一主阶段 | **「M1」字形**（无外框） | 自绘 |
| 战斗开始 | 交叉双剑 | `lucide/swords` |
| 宣告攻击者 | 单手剑 | `lucide/sword` |
| 宣告阻挡者 | 盾牌 | `lucide/shield` |
| 战斗伤害 | 闪电 | `lucide/zap` |
| 战斗结束 | 旗帜 | `lucide/flag` |
| 第二主阶段 | **「M2」字形**（无外框） | 自绘 |
| 结束步骤 | 沙漏 | `lucide/hourglass` |
| 清理 Cleanup | 扫帚 | `lucide/broom` |

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

### 两个主阶段为什么是「整块字形」而不是图形 + 角标

换过四版，写清楚免得再走回去：

1. **圆 + 数字 `1`/`2`**：单看一个数字读者不知道它指什么，10px 下也糊。
2. **`tabler/target` 同心圆 + 右上角挂一个「M1」小角标**：两个毛病。一是图形仍是
   target，两个主阶段看起来还是同一个图案——而「两个主阶段图形相同」正是这次要修的
   原版问题。二是几何上无解：图标本身只有 10px，而要在角上写清两个字符至少横向要
   6 个单位，24 网格里放不下「角标与图形不重叠」，只能叠着，实测很挤。
3. **圆角矩形包着 M1/M2**：图形本身成了标签，两个主阶段一眼可分，重叠问题也没了。
   但那个方框让字变小、整体也显得笨重。
4. **现在这版：没有外框，直接就是「M1」/「M2」两个字**，按 24 网格画满大半个画布
   （高 18、宽约 14）。

字形画在 SVG 内部而不是往 button 里插节点：`PhaseDot` 的 button 有 4 个子节点
（激活条 / 图标 / 停止点 / tooltip 锚点），都是 React 管的；画进 SVG 内部就完全没这个
问题，因为 SVG 的子树是我们整体替换的。

文字是**手绘路径**而不是 `<text>`：`<text>` 的宽度取决于字体，中文环境下
`-apple-system` 落到哪个字体不受我们控制，两个字符可能错位；手绘路径还顺带让笔画
粗细随图标一起缩放，10px 下不会糊。主阶段**不套那 1.15 倍放大**——坐标本来就按画满
画布算的。

「M」的宽度调过一次：最早按宽 6.2、高 18 画，两竖几乎贴在一起，显得又瘦又挤；现在是
宽 8.4。

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
node /path/to/phase-rs-zh/tools/check-app-data-coverage.mjs
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
9. 两个主阶段应当直接是**「M1」/「M2」两个字**（没有外框、没有 target 圆形），
   一眼可分；若某个阶段设了停止点，中下方的黄点不应和字挤在一起。
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

- 描边式图标来自 **[Lucide](https://lucide.dev)**（ISC 许可）与
  **[Tabler Icons](https://tabler.io/icons)**（MIT 许可）。两者都允许再分发，所以
  12 个图形可以随本仓库一起以 MIT 分发，`LICENSE` 不需要加例外条款。
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
- **发一行字**：把 `dist/phase-rs-zh.bookmarklet.txt` 里那一整行（约 6.4 KB）连同
  「新建书签 → 把地址替换成这一行 → 打开 phase.rs 后点它」贴进聊天即可。
- **挂一个链接**：想给一群人用就把它挂到任意静态托管上分享 URL。
  例如用 GitHub Pages（`git subtree` 不一定可用，所以用临时目录建分支）：

  ```bash
  cd /tmp && rm -rf zh-pages && mkdir zh-pages && cd zh-pages
  git init -q -b gh-pages
  cp <本目录>/dist/install.html index.html
  git add . && git commit -m "docs: phase-rs-zh 安装页"
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
phase-rs-zh/
├── README.md                               安装与日常使用（短）
├── NOTES.md                                本文件：设计、维护、分发（长）
├── src/content.js                          全部逻辑——唯一真源
├── dist/
│   ├── install.html                        安装页（拖拽 / 右键 / 复制地址）
│   ├── phase-rs-zh.bookmarklet.txt         书签地址（javascript: 一行）
│   └── phase-rs-zh.bookmarklet.js          未编码的压缩正文（供审阅）
├── docs/
│   ├── index.html                          GitHub Pages 入口，与 dist/install.html 逐字节相同
│   └── .nojekyll                           让 Pages 跳过 Jekyll 处理
├── test/
│   ├── content.test.mjs                    零依赖：卡图纯逻辑 + 产物同源/等价校验
│   ├── phase-icons.test.mjs                零依赖：图标数据、字形几何、绘制指令
│   ├── assembly.dom.mjs                    DOM 装配测试：卡图（vitest + happy-dom）
│   └── phase-icons.dom.mjs                 DOM 装配测试：阶段图标的识别与替换
├── tools/
│   ├── build-bookmarklet.mjs               从 src/content.js 生成上面那些产物
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
| 完全没有变化 | 绝大多数情况是**忘了点书签**，或刷新后没再点。点了还没反应就看 Web Inspector 控制台有没有 `[phase-rs-zh] 已启用 v…`。 |
| 点了书签但控制台没有那行 | 浏览器拦掉了 `javascript:` 地址，或你没把它建成书签（地址栏直接粘贴会被浏览器去掉 `javascript:` 前缀）。 |
| 卡图变成文字占位 | 说明应用自己的降级链接手了。请记下卡名，并跑 `npm run check:live` 看映射是否已变化。 |
| 一部分卡是英文 | 正常：大学院废墟没有这些印刷的中文图，已按设计降到英文层。 |
| 网络面板出现 404 | 正常：那是中文层的判据，紧接着会降级或重试。只有持续 404 且最终裂图才是问题。 |
| **时好时坏、同一张卡有时中文有时英文** | v1.1.0 已修。根因是图床那 4 个地址大多拒连，而旧版把「连不上」当成「没有中文图」。若在新版仍出现，`__phaseZhCardArtDebug = true` 后可在控制台看到每次是「原地重试」还是「降级」。 |
| **阶段图标没换 / 只换了一部分** | 先确认点过书签。控制台应打印 `[phase-rs-zh] 已启用 v1.2.0`。若某个图标仍是原版，多半是它所在的容器不符合已知的四种结构（3 个 / 2 个 / 5 个战斗 / 12 个一组）——脚本对认不出来的容器**故意不动**，以免把图标画到错误的阶段上。把 `__phaseZhCardArtDebug = true` 打开可以看到结构判据与文案判据不一致的警告。 |
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
