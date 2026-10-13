/**
 * Phase 中文卡图 — 书签小工具正文（bookmarklet，在页面自己的世界里执行）。
 *
 * 做两件事：
 *   1. 把 phase.rs 网页版渲染的卡图，全部改走大学院废墟（mtgch.com）的图床；
 *   2. 把回合阶段栏的 12 个内联 SVG 图标换成公开图标库的图形。
 * 两件事互不相干，各自独立装配（见文件末尾「阶段图标替换」一节）。
 *
 * 作用（卡图部分）：把 phase.rs 网页版渲染的卡图，全部改走大学院废墟（mtgch.com）的图床：
 * 该印刷有简体中文图就用中文图，没有就用大学院废墟自己的英文图。点一次书签脚本即注入
 * 并生效；刷新页面后脚本不再运行，页面自然回到 Scryfall 英文图。
 *
 * ── 三级阶梯 ────────────────────────────────────────────────────────────
 *
 * 两张 CDN 的 URL 形状一一对应，改动只是 host、`/zhs|sf/` 前缀和扩展名：
 *
 *   https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg?1783921885
 *   https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp   ← 中文
 *   https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp    ← 英文
 *
 * 改写是无状态的、同步的，不需要查任何 API：大学院废墟对「没有中文图」的印刷
 * 直接让 `/zhs/` 路径返回 404，这个 404 就是判据。加载失败时本脚本把该元素降到
 * 下一级，于是：
 *
 *   zhs（中文） --404--> sf（英文，仍是大学院废墟） --404--> scryfall（最终兜底）
 *
 * 第三级看似冗余——它就位是为了保证「绝不会比原版更差」。前两级都取不到图时
 * 说明大学院废墟侧缺这张印刷，此时退回应用本来就用的 Scryfall URL，而不是让
 * 卡牌变成裂图。
 *
 * `art_crop`（插画裁切）直接走 `sf`：画框裁切只是插画本身，与语言文字无关，
 * 大学院废墟也没有 `zhs/art_crop`（实测 404）。其 `/sf/art_crop/…` 实测为
 * 626x457，与 Scryfall 的 art_crop 尺寸一致，所以换过去不改变取景。
 *
 * ── 失败不等于 404：这是本脚本最容易搞错的一处 ──────────────────────────
 *
 * `<img>` 的 error 事件不带状态码，「这张印刷没有中文图（真 404）」和「这次请求
 * 没连上（网络抖动）」在事件里长得一模一样。早先的版本把两者都当成 404 直接降级，
 * 于是一张**有**中文图的牌只要碰上一次抖动就被打成英文，而 `givenUp` 记下之后本次
 * 页面加载再也不重试——用户看到的就是「时好时坏，很多卡莫名其妙是英文」。
 *
 * 这不是假想的边角情况。实测 images.mtgch.com：同一个 URL 连续 12 次只有 1 次拿到
 * 200，其余全是连接被拒（它挂在腾讯 EdgeOne 后面，一次解析出 4 个地址，多数拒连）。
 * 同一个 host 还对**每一个**响应重复发两次 `access-control-allow-origin`，浏览器会
 * 直接判该响应无效——所以任何带 `crossOrigin="anonymous"` 的请求永远失败。那是应用
 * 的 WebGL / 施放动画路径，本脚本改不动也不该改（见下面 `isCorsOnly`）。
 *
 * 于是降级前先发一个**便宜的存在性探测**：`Range: bytes=0-0` 的 GET。
 *
 *   2xx/206 → 图确实存在，刚才只是抖动 → **原地重试**，不降级
 *   404/410 → 图确实没有 → 降级
 *   探不动（无 fetch、被 CSP 拦、超时）→ 按「存在」处理，重试一次再降级
 *
 * 探测同样走这个 CDN，所以它自己也可能失败——但它是**独立**发出去的：`<img>` 那条
 * 卡在某个坏地址上时，探测有另一次机会落到别的边缘节点。这正是实测中「同源中继
 * 10/10 成功、直连 curl 只有约 8%」的原因（Node 会并行尝试全部地址、谁先通用谁）。
 *
 * 重试有上限：图存在却一直取不到时不能无限重试，每个 `印刷:尺寸` 最多重试 2 次，
 * 之后老老实实降级。
 *
 * ── 为什么必须「先改写，失败再降级」而不是交给 onError 处理 ──────────────
 *
 * phase.rs 的 CardImage 自带降级链：`onError={() => advanceFailedSource(src)}`。
 * 一旦换上去的图加载失败，应用的降级链会认为这张卡的美术挂了，把整张卡换成纯
 * 文字占位——比看到英文卡图糟得多。所以本脚本在捕获阶段拦下 `error`，自己降级，
 * 并用 `stopPropagation()` 阻止应用自己的 onError 触发。只有当 URL 已经处于
 * 最后一级（Scryfall）时我们才放手，让应用按原有逻辑降级——那才是真正的加载
 * 失败。
 *
 * ── 为什么要改页面原型（书签天然满足） ──────────────────────────────────
 *
 * 要零闪烁就必须在浏览器发起请求之前改掉属性值。React 18 通过
 * `node.setAttribute(...)` 写入 `src` 与 `srcset`，而只有页面自己的 JS 世界才改得动
 * `Element.prototype`——浏览器扩展的隔离世界改不了（所以扩展得声明 `world: "MAIN"`，
 * userscript 管理器得写 `@inject-into page`）。书签的 `javascript:` 地址本来就在页面
 * 自己的世界里执行，这个坑天然不存在，于是可以直接给 `Element.prototype.setAttribute`
 * 打补丁，同步改写，浏览器永远看不到英文 URL。代价是拿不到 `chrome.*` API——本脚本
 * 也不需要，它不请求任何接口。
 *
 * ── 同一份脚本也要认得应用自己发出的中文图地址 ──────────────────────────
 *
 * phase.rs 的某些分支（中文分支、本地开发）自己就会把卡图指向大学院废墟，甚至为了
 * 绕开上面那个重复 CORS 头改成走**同源中继** `/card-art/zhs/…`。同源地址在浏览器里
 * 是最可靠的一种（不同源，也就没有 CORS 检查）。此时本脚本不该装作看不见：认得出它，
 * 才能在它 404 时把阶梯接着往下走。所以解析器同时接受
 *
 *   https://images.mtgch.com/zhs|sf/…      （绝对，跨源）
 *   /card-art/zhs|sf/…                     （同源中继，相对路径）
 *
 * 两种写法，并保持原样往回写——**只换层级，不换寻址方式**。把相对路径改成绝对路径
 * 会把应用刻意绕开的 CORS 又拉回来。
 *
 * ── 刻意不处理的东西 ───────────────────────────────────────────────────
 *
 * - `backs.scryfall.io`（CARD_BACK_URL，牌背）与语言无关，host 不匹配即跳过。
 * - 已安装的「图像包」：用户显式安装的资源，URL 不在 scryfall.io 下，天然不碰。
 * - small/normal/large/art_crop 之外的尺寸（png、border_crop、thumb…）：应用
 *   目前不使用，遇到就原样放过，不猜。
 * - 桌面版（DMG / Tauri 套壳）：书签在 WebView 里用不了，本工具只覆盖网页版。
 *
 * ── 隐私与缓存 ─────────────────────────────────────────────────────────
 *
 * 不写任何持久化状态：没有 localStorage / sessionStorage / cookie，不查 API，
 * 不缓存图片。存在性探测只读状态码、用 `Range` 取 0 字节，结果只在内存里存
 * 几十秒。它做的全部事情就是在属性写入时换一个 URL，在加载失败时先探一下、
 * 再决定重试还是降级。
 */
(() => {
  "use strict";

  /**
   * 必须与 package.json 的 `version` 一致——它是用户在控制台确认「装的是哪一版」
   * 的唯一依据，而控制台那行日志是排障的第一步。test/content.test.mjs 里有断言
   * 防止两者漂移。
   */
  const VERSION = "1.7.0";

  const SCRYFALL_IMAGE_HOST = "cards.scryfall.io";
  const MTGCH_IMAGE_HOST = "images.mtgch.com";

  /**
   * 应用自建的同源中继前缀。
   *
   * 与 phase.rs 中文分支的 `DERIVED_ART_PROXY_PATH`（client/src/services/scryfall.ts）
   * 以及 vite 的 `/card-art` 代理保持一致。它是那条分支的实现细节，所以这里只当作
   * 「一种要认得的寻址方式」：缺了它本脚本照常工作，只是看不到那条路径上的图。
   */
  const RELAY_PATH = "/card-art";

  const ZHS_PREFIX = "zhs";
  const SF_PREFIX = "sf";

  /**
   * 三个来源层级。`prefix` 为 null 表示该 host 下没有子目录（Scryfall）。
   * `artCrop` 表示该层是否提供插画裁切图：中文层不提供（插画与语言无关）。
   */
  const TIERS = {
    zh: { host: MTGCH_IMAGE_HOST, prefix: ZHS_PREFIX, extension: "webp", artCrop: false },
    "mtg-en": { host: MTGCH_IMAGE_HOST, prefix: SF_PREFIX, extension: "webp", artCrop: true },
    scryfall: { host: SCRYFALL_IMAGE_HOST, prefix: null, extension: "jpg", artCrop: true },
  };

  const TIER_ORDER = ["zh", "mtg-en", "scryfall"];

  /**
   * 寻址方式。`origin` 决定 URL 往回写成什么样，它与层级（tier）是两个正交的维度：
   *
   *   cdn    → `https://images.mtgch.com/…`   绝对，跨源
   *   relay  → `/card-art/…`                  同源，相对路径
   *   direct → `https://cards.scryfall.io/…`  绝对，应用原本的地址
   *
   * 同一层级在两种 origin 下各有一种写法，`urlFor` 就是这两者的叉乘，也是全脚本
   * 唯一的 URL 拼装点。
   */
  const ORIGINS = {
    cdn: { scheme: "https", host: MTGCH_IMAGE_HOST, prefix: "", relative: false },
    relay: { scheme: "", host: "", prefix: RELAY_PATH, relative: true },
    direct: { scheme: "https", host: SCRYFALL_IMAGE_HOST, prefix: "", relative: false },
  };

  /** 带卡面的尺寸。应用只用这三种，加 art_crop 共四种。 */
  const FACE_SIZES = new Set(["small", "normal", "large"]);
  const ART_CROP = "art_crop";
  const FACES = new Set(["front", "back"]);

  const ART_FILENAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/;

  // ────────────────────────────────────────────────────────────────────────
  // URL 解析与改写（纯函数，可脱离 DOM 单测）
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 拆出 scheme / host / path 段。
   *
   * 不用 `new URL()` 的原因和 phase.rs 里 `splitSizedImageUrl` 一致：这里会在
   * 每个卡图属性上被调用，输入可能是空串、相对路径或测试替身；手写拆分没有
   * 抛异常的分支，不认识就返回 null。
   */
  function splitHttpsUrl(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/.exec(value);
    if (!match) return null;
    const [, scheme, host, pathname] = match;
    return {
      scheme,
      host: host.toLowerCase(),
      segments: pathname.split("/").filter((segment) => segment.length > 0),
    };
  }

  /**
   * 只取 host：用于 `crossOrigin` 判定（相对路径 = 同源 = 没有 CORS 检查）。
   * 不复用 splitHttpsUrl 是因为它连段数一起校验，而这里只想要 host。
   */
  function hostOf(value) {
    if (typeof value !== "string") return null;
    const match = /^https?:\/\/([^/?#]+)/.exec(value);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * 路径开头的语言层级标注：中继前缀（`/card-art`，可省）后面紧跟的那一段。
   * 返回 `"zh"` / `"mtg-en"`，没有标注则返回 null。
   *
   * 判定与「段数必须是 5」是两件事，所以这里独立成函数：语言前缀要先于段数校验
   * 被认出来并从 segments 里摘掉，而摘掉之后就没法再回头判断它是哪一级了。
   */
  function pathTier(value) {
    if (value.startsWith(RELAY_PATH + "/")) {
      const rest = value.slice(RELAY_PATH.length + 1);
      if (rest.startsWith(ZHS_PREFIX + "/")) return "zh";
      if (rest.startsWith(SF_PREFIX + "/")) return "mtg-en";
      return null;
    }
    if (value.startsWith("/" + ZHS_PREFIX + "/")) return "zh";
    if (value.startsWith("/" + SF_PREFIX + "/")) return "mtg-en";
    if (value.includes("://")) {
      const path = value.slice(value.indexOf("://") + 3);
      const slash = path.indexOf("/");
      if (slash < 0) return null;
      return pathTier(path.slice(slash));
    }
    return null;
  }

  /**
   * 把一张卡图 URL 解析成 `{ tier, origin, ref, scheme, base }`，或返回 null。
   *
   * `ref` 里的分片目录（uuid 的前两位）会与 uuid 交叉校验，这样一条构造畸形的
   * URL 不会被改写成另一张卡的图片请求——宁可漏改，不可改错。
   *
   * 查询串（`?1783921885` 这类时间戳、以及重试时我们自己加的随机参数）在解析时
   * 被丢弃：`urlFor` 不带走入参的查询串，于是**降级不会把旧缓存参数带下去**，
   * 需要重试时由 `retryUrl` 显式加一个新的。
   */
  function parseArtUrl(value) {
    if (typeof value !== "string" || value.length === 0) return null;

    const tier = pathTier(value);
    let origin = null;
    let segments = null;
    let scheme = "https";

    if (value.startsWith(RELAY_PATH + "/")) {
      // 同源中继：相对路径，没有 scheme 也没有 host。
      origin = "relay";
      scheme = "";
      // 查询串（`?ts=…` 或重试参数）不属于路径，先剥掉再切段：否则它会粘在最后
      // 一段上，让文件名正则失配——表现为「重试地址解析不出来」这种怪事。
      const relative = value.slice(RELAY_PATH.length).split("?")[0].split("#")[0];
      segments = relative.split("/").filter((segment) => segment.length > 0);
    } else {
      const split = splitHttpsUrl(value);
      if (!split) return null;
      if (split.scheme !== "https") return null;
      scheme = split.scheme;
      segments = split.segments;

      if (split.host === SCRYFALL_IMAGE_HOST) origin = "direct";
      else if (split.host === MTGCH_IMAGE_HOST) origin = "cdn";
      else return null;
    }

    // 大学院废墟图床与同源中继都必须带语言前缀；应用原本的 Scryfall 地址则没有。
    if (tier !== null) segments = segments.slice(1);
    else if (origin !== "direct") return null;

    if (segments.length !== 5) return null;

    const [size, face, shardA, shardB, rawFilename] = segments;
    if (!FACE_SIZES.has(size) && size !== ART_CROP) return null;
    if (!FACES.has(face)) return null;
    if (!/^[0-9a-f]$/.test(shardA) || !/^[0-9a-f]$/.test(shardB)) return null;

    const match = ART_FILENAME.exec(rawFilename.split("?")[0].split("#")[0]);
    if (!match) return null;
    const printingId = match[1];
    if (printingId[0] !== shardA || printingId[1] !== shardB) return null;

    const ref = { size, face, shardA, shardB, printingId };
    // 应用的 Scryfall 地址是唯一的兜底层；带前缀的那两种按前缀定级。
    const resolvedTier = tier ?? "scryfall";
    // 中文层没有 art_crop（插画与语言无关），这个尺寸只可能落在英文层。
    if (size === ART_CROP && !TIERS[resolvedTier].artCrop) return null;

    return { tier: resolvedTier, origin, ref, scheme, base: ORIGINS[origin].prefix };
  }

  /**
   * 按层级把 `ref` 渲染成 URL。这是全脚本唯一的 URL 拼装点。
   *
   * 寻址方式由**目标层级**决定，不是照抄入参：
   *
   *   目标 scryfall → 永远写绝对地址（那是应用原本的形状，兜底就得原样还回去）
   *   目标 zh / mtg-en → 保留来源的寻址方式（图床绝对地址，或同源中继的相对路径）
   *
   * `parsed.origin` 是**来源**的寻址方式，所以「升到中文层」这个跨 host 的动作
   * 必须显式说明目标用 `cdn`——它绝不该被当成目标 host 用（那样会写出
   * `https://cards.scryfall.io/zhs/…` 这种两边都不存在的地址）。
   */
  function urlFor(parsed, tier, origin) {
    const target = ORIGINS[origin];
    const spec = TIERS[tier];
    const prefix = spec.prefix ? `/${spec.prefix}` : "";
    const path = `${target.prefix}${prefix}`
      + `/${parsed.ref.size}/${parsed.ref.face}/${parsed.ref.shardA}/${parsed.ref.shardB}/`
      + `${parsed.ref.printingId}.${spec.extension}`;
    return target.relative ? path : `${target.scheme}://${target.host}${path}`;
  }

  /**
   * 已经确认大学院废墟两层都取不到图的 `印刷id:尺寸`。
   *
   * 为什么必须有这个集合：降到第三级时要写回 Scryfall URL，而这次写入会再次
   * 经过我们补丁过的 `setAttribute`，于是 `rewriteUrl` 会立刻把它改回中文层，
   * 造成 404 → 改写 → 404 的死循环。登记之后 `rewriteUrl` 对这张图原样放过。
   *
   * 按「印刷 + 尺寸」而不是只按印刷做键：`sf/art_crop` 缺失不代表同一张印刷的
   * `zhs/normal` 也缺失，键太粗会让整张卡白丢中文。
   *
   * 纯内存、不持久化；页面刷新即重置。有上限，避免长会话里无界增长。
   */
  const givenUp = new Set();
  const MAX_GIVEN_UP = 5000;

  /** 已原地重试的次数，键为 `印刷id:尺寸`；防止「图存在但永远取不到」时无限重试。 */
  const retryCounts = new Map();
  const MAX_RETRIES = 2;

  let retryCounter = 0;

  function ladderKey(ref) {
    return `${ref.printingId}:${ref.size}`;
  }

  function giveUpOn(ref) {
    if (givenUp.size >= MAX_GIVEN_UP) givenUp.clear();
    givenUp.add(ladderKey(ref));
  }

  /**
   * 应用的英文卡图 URL → 我们想显示的第一选择。
   *
   * 带卡面的尺寸走中文层；`art_crop` 走英文层（中文层没有这个尺寸，插画也与
   * 语言无关）。已经是大学院废墟的 URL、以及任何不认识的输入都原样返回，所以
   * 本函数是幂等的——属性写入路径会重复经过它。已放弃的图直接返回原值。
   *
   * 只改写**应用原本的 Scryfall 地址**：已经在中继层或大学院废墟层上的 URL 一律
   * 原样放过，于是「只换层级，不换寻址方式」这条不变量在这里也成立。
   */
  function rewriteUrl(value) {
    const parsed = parseArtUrl(value);
    if (!parsed || parsed.origin !== "direct" || parsed.tier !== "scryfall") return value;
    if (givenUp.has(ladderKey(parsed.ref))) return value;
    return urlFor(parsed, parsed.ref.size === ART_CROP ? "mtg-en" : "zh", "cdn");
  }

  /**
   * 下一级 URL，或 null。
   *
   * `origin` 保持原样（同源中继降级后仍是同源中继），层级按 TIER_ORDER 往下走；
   * 已经在最后一级时返回 null，调用方据此把错误交回应用自己处理。
   *
   * 这里**不做网络判断**，纯粹的阶梯映射——「这次失败到底是不是 404」由
   * `probeArtUrl` 回答，两者分开的好处是这段逻辑零依赖、可以被 Node 单测逐条钉死。
   *
   * 准备退到 Scryfall 层时顺手登记放弃——登记必须发生在写回属性之前，见
   * `givenUp` 的说明。
   */
  function nextTierUrl(value) {
    const parsed = parseArtUrl(value);
    if (!parsed) return null;
    const next = TIER_ORDER[TIER_ORDER.indexOf(parsed.tier) + 1];
    if (!next) return null;
    if (next === "scryfall") giveUpOn(parsed.ref);
    // 兜底层是应用的原始形状：绝对地址、Scryfall 主机。中继/图床层则沿用来源的
    // 寻址方式，于是 `<img src="/card-art/zhs/…">` 降级后是 `/card-art/sf/…`。
    return urlFor(parsed, next, next === "scryfall" ? "direct" : parsed.origin);
  }

  /** 给同一个资源换一个新的缓存参数，用于原地重试。 */
  function retryUrl(value) {
    const parsed = parseArtUrl(value);
    if (!parsed) return null;
    retryCounter += 1;
    const separator = value.includes("?") ? "&" : "?";
    return `${value}${separator}r=${parsed.ref.printingId.slice(0, 8)}${retryCounter}`;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 存在性探测：把「连不上」与「真 404」分开
  // ────────────────────────────────────────────────────────────────────────

  const PROBE_TIMEOUT_MS = 4000;
  const PROBE_CACHE_TTL_MS = 30000;
  const PROBE_CACHE_LIMIT = 512;

  /** url → { exists, at }；exists 为 true/false/null（null = 探不动）。 */
  const probeCache = new Map();
  /** url → Promise，避免 srcset 的多个候选各发一次一模一样的探测。 */
  const probePending = new Map();

  function cacheProbe(url, exists) {
    if (probeCache.size >= PROBE_CACHE_LIMIT) probeCache.clear();
    probeCache.set(url, { exists, at: Date.now() });
  }

  function readProbeCache(url) {
    const hit = probeCache.get(url);
    if (!hit) return undefined;
    if (Date.now() - hit.at > PROBE_CACHE_TTL_MS) {
      probeCache.delete(url);
      return undefined;
    }
    return hit.exists;
  }

  /** 把一个响应状态翻译成「存在 / 不存在 / 说不清」。 */
  function classify(status) {
    if (status >= 200 && status < 300) return true;
    if (status === 404 || status === 410) return false;
    // 5xx、403、429……都说不清：当成「存在」处理，让调用方重试一次，
    // 而不是凭一个我们读不懂的状态码把卡图降级。
    return null;
  }

  /**
   * 探测 `url` 是否真实存在：`true` / `false` / `null`（探不动）。
   *
   * `Range: bytes=0-0` 让响应只传 1 个字节（200 变 206）。实测该 CDN 对缓存未命中
   * 的 HEAD 会错报 404，所以 GET + Range 才是可靠的那一种——tools/check-live.mjs
   * 里记着同一件事。
   *
   * 任何异常都收敛成 null（探不动），绝不向外抛：一个探测不该让页面上的图片处理
   * 崩掉。
   */
  async function probeArtUrl(url) {
    const cached = readProbeCache(url);
    if (cached !== undefined) return cached;
    const pending = probePending.get(url);
    if (pending) return pending;

    const task = (async () => {
      let result = null;
      if (typeof fetch === "function") {
        let timer = null;
        try {
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          if (controller) timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
          const response = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            cache: "no-store",
            redirect: "follow",
            signal: controller ? controller.signal : undefined,
          });
          result = classify(response.status);
        } catch {
          result = null;
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }
      // 探不动也缓存：否则每张降级的图都会白探一次。
      cacheProbe(url, result);
      return result;
    })();

    probePending.set(url, task);
    try {
      return await task;
    } finally {
      probePending.delete(url);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // srcset 解析
  // ────────────────────────────────────────────────────────────────────────

  /**
   * `srcset` 语法里的空白字符（HTML 规范的定义）：空格、TAB、LF、FF、CR。
   *
   * 用码点表而不是 `"\t"` / `"\n"` 这类转义字面量：压缩器会把它们改写成**真实的**
   * 控制字符（esbuild 就会），而书签小工具的正文要能安全地放进一个 URL 里，一个
   * 控制字符都不该有。写成码点表顺带把「哪些字符算空白」变成了可读的数据。
   */
  const SRCSET_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d]);

  function isSrcsetWhitespace(character) {
    return SRCSET_WHITESPACE.has(character.charCodeAt(0));
  }

  /**
   * 对 `srcset` 的每个候选套用 `map`，保留 `146w` / `2x` 这类描述符。
   * 一个都没变时返回原串，避免无谓的属性写入（那会再触发 MutationObserver）。
   *
   * 不能简单地按逗号切分：`data:` URL 自带逗号（`data:image/png;base64,AAAA`），
   * 按逗号切会把一个候选拆成两个。这里按 srcset 的解析规则走——URL 到空白或
   * 分隔逗号为止，而 `data:` URL 里的逗号属于 URL 本身；描述符则是接下来的
   * 非空白内容，直到下一个逗号。
   */
  function mapSrcset(value, map) {
    if (typeof value !== "string" || value.length === 0) return value;

    let index = 0;
    let changed = false;
    const candidates = [];

    while (index < value.length) {
      // 跳过候选之间的空白与分隔逗号。
      while (index < value.length && (isSrcsetWhitespace(value[index]) || value[index] === ",")) index += 1;
      if (index >= value.length) break;

      const isDataUrl = value.slice(index, index + 5).toLowerCase() === "data:";
      const urlStart = index;
      while (index < value.length && !isSrcsetWhitespace(value[index])) {
        if (!isDataUrl && value[index] === ",") break;
        index += 1;
      }
      // 仅 `data:` 分支可能收集到结尾的分隔逗号。
      const url = value.slice(urlStart, index).replace(/,+$/, "");

      // URL 与描述符之间的空白要原样保留，否则 `… 1x, … 2x` 会被拼成 `…1x`。
      const separatorStart = index;
      while (index < value.length && isSrcsetWhitespace(value[index])) index += 1;
      const separator = value.slice(separatorStart, index);
      const descriptorStart = index;
      while (index < value.length && value[index] !== ",") index += 1;
      const descriptor = value.slice(descriptorStart, index);

      if (url.length === 0) continue;
      const next = map(url);
      if (next !== url) changed = true;
      candidates.push(`${next}${separator}${descriptor}`);
    }

    return changed ? candidates.join(", ") : value;
  }

  /** `srcset` 里的全部候选 URL（用于失败判定）。 */
  function srcsetCandidates(value) {
    const urls = [];
    mapSrcset(value, (url) => {
      urls.push(url);
      return url;
    });
    return urls;
  }

  // ────────────────────────────────────────────────────────────────────────
  // DOM 改写
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 带 `crossOrigin="anonymous"` 的元素不该被换到大学院废墟。
   *
   * 那个 host 对每个响应重复发两次 `access-control-allow-origin`，浏览器直接判响应
   * 无效——所以这类元素（应用的 WebGL / 施放动画，它们必须上传不污染画布的贴图）
   * 换过去只会从「有英文图」变成「没图」。同源中继地址没这个问题，照常改写。
   */
  function isCorsOnly(image, value) {
    if (image.crossOrigin == null || image.crossOrigin === "") return false;
    const host = hostOf(value);
    if (host === null) return false; // 相对路径 = 同源 = 没有 CORS 检查
    return host !== location.host.toLowerCase();
  }

  function rewriteElement(image) {
    const src = image.getAttribute("src");
    if (src) {
      const next = isCorsOnly(image, src) ? src : rewriteUrl(src);
      if (next !== src) image.setAttribute("src", next);
    }
    const srcset = image.getAttribute("srcset");
    if (srcset) {
      const next = mapSrcset(srcset, (url) => (isCorsOnly(image, url) ? url : rewriteUrl(url)));
      if (next !== srcset) image.setAttribute("srcset", next);
    }
  }

  function scanCardImages() {
    for (const image of document.querySelectorAll("img")) {
      try {
        rewriteElement(image);
      } catch (error) {
        // 一张图失败不该让整轮扫描停下，更不该把异常抛到观察器/事件层。
        if (debug()) console.warn("[phase-rs-zh] 卡图改写失败", error);
      }
    }
  }

  /**
   * 把该元素上仍处于大学院废墟/中继层级的 URL 整体降一级，或原地重试。
   *
   * 返回这次做了什么：
   *   "advanced"  已降级，调用方应拦下错误事件
   *   "retried"   已原地重试，调用方应拦下错误事件
   *   "exhausted" 没有可动的了（已是 Scryfall 层，或根本不是卡图），交回应用
   *
   * `srcset` 先写、`src` 后写：带 `sizes` 的 srcset 优先于 src，先落 srcset 才能
   * 保证这次重载取的是新的一级。
   */
  function advanceLadder(image, retry) {
    const src = image.getAttribute("src");
    const srcset = image.getAttribute("srcset");

    const nextSrcset = srcset ? mapSrcset(srcset, (url) => stepUrl(url, retry) ?? url) : null;
    const nextSrc = src ? stepUrl(src, retry) : null;

    const srcsetChanged = nextSrcset !== null && nextSrcset !== srcset;
    const srcChanged = nextSrc !== null && nextSrc !== src;

    if (srcsetChanged) image.setAttribute("srcset", nextSrcset);
    if (srcChanged) image.setAttribute("src", nextSrc);

    if (!srcsetChanged && !srcChanged) return "exhausted";
    // 「这次是重试还是降级」由 stepUrl 的返回值自己说：重试过的 URL 与原值同层
    // （只多了缓存参数）。用返回值判断而不是用入参 retry，是因为入参只表达意图，
    // 重试额度用尽时 stepUrl 会改降级。
    const moved = nextSrc ?? nextSrcset;
    const original = nextSrc !== null ? src : srcset;
    return hopKind(original, moved);
  }

  /** 比较一次跳转前后的层级：同层 = 原地重试，降了一级 = 降级。 */
  function hopKind(before, after) {
    const from = firstParsedTier(before);
    const to = firstParsedTier(after);
    if (from === null || to === null) return "advanced";
    return from === to ? "retried" : "advanced";
  }

  /** 取一段值里第一个可解析的卡图 URL 的层级。 */
  function firstParsedTier(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    for (const url of [value, ...srcsetCandidates(value)]) {
      const parsed = parseArtUrl(url);
      if (parsed) return parsed.tier;
    }
    return null;
  }

  /**
   * 一次失败之后，这个 URL 该换成什么。
   *
   * `retry` 表达的是「探测说这张图确实存在，刚才只是没取到」——那是唯一值得原地
   * 重试的情形。额度用尽（`MAX_RETRIES`）之后即使图还在也降级：一个永远取不到的
   * 资源不能把页面拖在重试循环里。
   */
  function stepUrl(value, retry) {
    const parsed = parseArtUrl(value);
    if (!parsed) return null;
    if (parsed.tier === "scryfall") return null;
    if (retry) {
      const key = ladderKey(parsed.ref);
      const used = retryCounts.get(key) ?? 0;
      if (used < MAX_RETRIES) {
        if (retryCounts.size >= MAX_GIVEN_UP) retryCounts.clear();
        retryCounts.set(key, used + 1);
        return retryUrl(value);
      }
    }
    return nextTierUrl(value);
  }

  /**
   * 图片来源加载失败。
   *
   * 只处理还处在大学院废墟/中继层级的元素——降到 Scryfall 层还失败，说明是真的
   * 加载不出来，此时放手让应用按原有逻辑处理。
   *
   * **`stopPropagation()` 必须同步调用。** 应用的 `onError` 是 React 19 在根容器
   * 上的委托监听，靠事件从 window 捕获阶段被拦下来才不会触发；而这里要先 await 一个
   * 存在性探测才能决定重试还是降级。把拦截放到 await 之后就晚了——事件传播早已结束，
   * 应用的降级链（把整张卡换成文字占位）照跑不误。所以：先同步拦下，再异步决定怎么改。
   *
   * 「同步拦下」的判据是「这个元素上还有可降的层级」，这不需要网络：纯粹的 URL 判断。
   */
  function onResourceError(event) {
    // 这个监听**每次图片加载失败都会被调用**，是整个脚本里触发最频繁的入口之一。
    // 它抛出的异常没有任何人接：会变成未捕获异常，被 phase.rs 的全局 `error` 监听
    // 上报成 `js_error`（`services/telemetryEvents.ts`），界面上就是「游戏崩溃」。
    // 所以整段都包在 try 里——代价是一次 try，收益是这条路径永远不会把异常泄漏出去。
    try {
      handleResourceError(event);
    } catch (error) {
      if (debug()) console.warn("[phase-rs-zh] 卡图失败处理出错", error);
    }
  }

  function handleResourceError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;

    const candidates = imageCandidates(image);
    const onLadder = candidates.filter((url) => {
      const parsed = parseArtUrl(url);
      return parsed !== null && parsed.tier !== "scryfall";
    });
    if (onLadder.length === 0) return;

    // 同步拦住，别让应用看到这次失败。
    event.stopPropagation();
    // `void` 只表示「不 await」，**不接住拒绝**：这个 async 函数一旦抛错就变成
    // `unhandledrejection`，而 phase.rs 同样监听该事件并上报 `js_error`
    // （`services/telemetryEvents.ts`）。所以显式接住。
    resolveTierFailure(image, onLadder).catch((error) => {
      if (debug()) console.warn("[phase-rs-zh] 降级处理失败", error);
    });
  }

  /** 该元素上所有待判定的卡图 URL：`src` 与 `srcset` 的全部候选。 */
  function imageCandidates(image) {
    const candidates = [];
    const src = image.getAttribute("src");
    if (src) candidates.push(src);
    const srcset = image.getAttribute("srcset");
    if (srcset) candidates.push(...srcsetCandidates(srcset));
    return candidates;
  }

  /**
   * 异步的那一半：探测 → 决定原地重试还是降级 → 改写属性。
   *
   * 探测回答的是「这张图真的不存在吗」。只要**任一**候选确实存在（或探不动），
   * 就按抖动处理、原地重试；只有确认不存在才降级。
   */
  async function resolveTierFailure(image, onLadder) {
    const src = image.getAttribute("src");

    let exists = false;
    for (const url of onLadder) {
      const answer = await probeArtUrl(url);
      if (answer !== false) {
        exists = true;
        break;
      }
    }

    if (!image.isConnected) return;
    const outcome = advanceLadder(image, exists);
    if (outcome === "exhausted") return;
    if (debug()) {
      console.info(`[phase-rs-zh] ${outcome === "retried" ? "原地重试" : "降级"}：${src}`, {
        exists,
      });
    }
  }

  function debug() {
    return globalThis.__phaseZhCardArtDebug === true;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 装配
  // ────────────────────────────────────────────────────────────────────────

  /** 给 `HTMLImageElement.prototype` 上的一个反射属性打补丁。 */
  function patchImageProperty(name, map) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name);
    if (!descriptor || typeof descriptor.set !== "function" || typeof descriptor.get !== "function") return;
    Object.defineProperty(HTMLImageElement.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(this, map(value, this));
      },
    });
  }

  /**
   * 给 `Element.prototype.setAttribute` 打补丁。
   *
   * 这是真正起作用的那一层：React 18 对 `src` / `srcset` 走的是
   * `node.setAttribute(...)`，在这里同步改写，浏览器就不会先发一次英文请求，
   * 也就没有「先闪一下英文」。
   */
  function patchSetAttribute() {
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (this instanceof HTMLImageElement) {
        const attribute = String(name).toLowerCase();
        if (attribute === "src") {
          const text = String(value);
          value = isCorsOnly(this, text) ? text : rewriteUrl(text);
        } else if (attribute === "srcset") {
          const text = String(value);
          value = mapSrcset(text, (url) => (isCorsOnly(this, url) ? url : rewriteUrl(url)));
        }
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }

  /** 兜底：内联 HTML、SSR 或任何绕开上面两条路径的属性写入。 */
  function observe() {
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      // 同上：回调抛出的异常会变成未捕获异常，被应用的遥测上报成 js_error。
      try {
        for (const record of records) {
          if (record.type !== "attributes") continue;
          const target = record.target;
          if (target instanceof HTMLImageElement) rewriteElement(target);
        }
      } catch (error) {
        if (debug()) console.warn("[phase-rs-zh] 卡图属性改写失败", error);
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
  }


  // ────────────────────────────────────────────────────────────────────────
  // 阶段图标替换
  // ────────────────────────────────────────────────────────────────────────
  //
  // phase.rs 的回合阶段栏（重置/维持/抓牌/战斗…共 12 个）用的是**内联 SVG**，
  // 不是 <img>，所以和上面的卡图逻辑毫无交集：那边改 img 的 src/srcset，这边换
  // svg 的子节点。两者唯一的共同点是都要对付 React 重渲染，但机制可以各管各的。
  //
  // ── 图形来自公开图标库，不自己画 ────────────────────────────────────────
  //
  //   Tabler Icons  https://tabler.io/icons   MIT 许可
  //
  // **全部 12 个都来自 Tabler 一家**，这样只需要遵守一份许可。早先混用过 Lucide（ISC），
  // 后来把非 Tabler 的 6 个换成了 Tabler 的对应图形——收窄许可面的价值大于「扫帚」
  // 变成「刷子」的语义损失。
  //
  // 版权声明与许可全文见仓库根的 THIRD-PARTY-NOTICES.md；MIT 要求它随所有副本分发，
  // 所以改图标时要同步那份文件。
  // 这里刻意**不用** Apple 的 SF Symbols：它的许可只覆盖运行在 Apple 系统上的
  // App，网页不在范围内，而本项目允许别人再分发。
  //
  // ── 为什么角标画在 SVG 内部，而不是往 button 里插一个 span ────────────────
  //
  // PhaseDot 的 button 有 4 个子节点（激活条 / 图标 / 停止点 / tooltip 锚点），
  // 它们都是 React 管的。往里塞第五个节点会参与 React 的子节点协调，一旦
  // PHASE_ICONS 的引用在未来某个版本被打断、React 真的去 diff 子节点，这个外来
  // 节点就可能被挪走或移除。角标画进 SVG 内部就完全没有这个问题——SVG 的子树
  // 是我们自己整体替换的，多画一个圆和一个数字不需要 React 知道。
  //
  // 代价是数字很小：手机端图标本身只有 10px（见下面 SIZE 的说明），角标圆占
  // 2.5/24 的 viewBox，数字大约只有 1.4 个屏幕像素高。此时「角标」传达的是
  // 「这是主阶段」，而「具体是第几个」要靠抽屉里的中文标签。桌面端 14px 下数字
  // 可以辨认。这是「角标 + 10px 图标」这个组合的物理下限，不是实现取舍。

  /**
   * 12 个阶段的新图标，`inner` 是图标库 SVG 去掉外层 <svg> 之后的图元。
   * `source` 只用于排障时说明出处（控制台里能看到）。
   */
  const PHASE_ICON_SOURCE = {
    Untap: "tabler/rotate-clockwise",
    Upkeep: "tabler/settings",
    Draw: "tabler/play-card",
    PreCombatMain: "tabler/square-number-1",
    BeginCombat: "tabler/swords",
    DeclareAttackers: "tabler/sword",
    DeclareBlockers: "tabler/shield",
    CombatDamage: "tabler/flame",
    EndCombat: "tabler/flag-3",
    PostCombatMain: "tabler/square-number-2",
    End: "tabler/hourglass",
    Cleanup: "tabler/brush",
  };

  /** 阶段顺序，必须与 phase.rs 的 PhaseStopBar.tsx / MobilePhaseChip.tsx 一致。 */
  const PHASES = [
    "Untap", "Upkeep", "Draw", "PreCombatMain",
    "BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat",
    "PostCombatMain", "End", "Cleanup",
  ];

  /** 图标库统一 24×24 网格；描边宽度走库的默认值 2。 */
  const ICON_VIEW_BOX = "0 0 24 24";
  const ICON_STROKE_WIDTH = "2";

  /**
   * 内容整体放大 1.15 倍，绕画布中心。
   *
   * 图标库在 24 网格四周各留了约 2 的空白，缩到 10px 时图形只占约 8.3px，比原版
   * 14×14 的图标显得轻。放大 1.15 把它补回来。
   *
   * **为什么是「缩放内容」而不是「收窄 viewBox」。** 收窄 viewBox 看着更省事，但两条
   * 路都走不通，都渲染对比过：
   *   - `viewBox="0 0 20 20"` 是**矩形裁切**四周各 2 单位。图形贴到裁切线上的图标会
   *     被切掉——两个主阶段的方框正好是 3..21，切在边上。
   *   - 收窄 viewBox 再让内容缩小去适配：内容缩到 20 却仍摆在 24 画布里，**反而比
   *     基准更小**（20/24 = 0.83 倍）。
   * 缩放内容没有这两个问题：画布不动，只把内容放大。
   *
   * 放大按 viewBox 单位算，所以描边宽度（同样是 viewBox 单位）跟着一起变粗，正好——
   * 图形变大而线条不变粗的话，反而会显得单薄。
   *
   * 12 个阶段**一视同仁**都套这层放大，包括两个主阶段。主阶段的方框会从 3..21 长到
   * 1.8..22.2，仍在画布内、不会被裁。
   */
  const ICON_ZOOM = 1.15;

  /** 绕 (12, 12) 缩放，图标库的内容本来就以这里为中心。 */
  const ICON_ZOOM_TRANSFORM = `translate(12 12) scale(${ICON_ZOOM}) translate(-12 -12)`;

  const PHASE_ICON_INNER = {
    Untap: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5" />',   // tabler/rotate-clockwise
    Upkeep: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" /> <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />',   // tabler/settings
    Draw: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M19 5v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2" /> <path d="M8 6h.01" /> <path d="M16 18h.01" /> <path d="M12 16l-3 -4l3 -4l3 4l-3 4" />',   // tabler/play-card
    PreCombatMain: '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14" /> <path d="M10 10l2 -2v8" />',   // tabler/square-number-1
    BeginCombat: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M21 3v5l-11 9l-4 4l-3 -3l4 -4l9 -11l5 0" /> <path d="M5 13l6 6" /> <path d="M14.32 17.32l3.68 3.68l3 -3l-3.365 -3.365" /> <path d="M10 5.5l-2 -2.5h-5v5l3 2.5" />',   // tabler/swords
    DeclareAttackers: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M20 4v5l-9 7l-4 4l-3 -3l4 -4l7 -9l5 0" /> <path d="M6.5 11.5l6 6" />',   // tabler/sword
    DeclareBlockers: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />',   // tabler/shield
    CombatDamage: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.294 -2.333 5.588c0 3.704 3.134 6.706 7 6.706c3.866 0 7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235" />',   // tabler/flame
    EndCombat: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M5 14h14l-4.5 -4.5l4.5 -4.5h-14v16" />',   // tabler/flag-3
    PostCombatMain: '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14" /> <path d="M10 8h3a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 0 -1 1v2a1 1 0 0 0 1 1h3" />',   // tabler/square-number-2
    End: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M6.5 7h11" /> <path d="M6.5 17h11" /> <path d="M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1" /> <path d="M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1" />',   // tabler/hourglass
    Cleanup: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /> <path d="M3 21v-4a4 4 0 1 1 4 4h-4" /> <path d="M21 3a16 16 0 0 0 -12.8 10.2" /> <path d="M21 3a16 16 0 0 1 -10.2 12.8" /> <path d="M10.6 9a9 9 0 0 1 4.4 4.4" />',   // tabler/brush
  };

  /**
   * 把原版图标换成图标库的图形——**不碰 React 拥有的任何节点**。
   *
   * ## 为什么要写成这样（重要，别改回去）
   *
   * 早先的做法是就地改那个 `<svg>`：设 viewBox / fill / stroke，再 `innerHTML =`
   * 换掉它的子节点。那会**把 React 记账的 `<path>`/`<circle>` 从 DOM 里摘掉**，
   * 并往 `<svg>` 里塞进 React 不知道的 `<g>`。React 后续任何一次针对那些节点的操作
   * （重渲染、卸载、切换子节点）都可能出问题，用户看到的就是 phase.rs 的
   * ErrorBoundary 兜底页。实测「点书签时没事、玩一会儿切换阶段才崩、每次都崩」，
   * 与「React 之后才去动那些被摘掉的节点」完全吻合。
   *
   * 现在的做法是**只读 + 旁挂**：
   *
   *   1. 把原版 `<svg>` 置为 `visibility: hidden` —— 它保持完整、保持占位，
   *      React 想怎么管都行，我们一个属性和子节点都不动（只加数据标记）。
   *   2. 在它旁边**插入一个我们自己新建的 `<svg>`**，装着要显示的图形。
   *      这个节点完全归我们所有，React 从不认领它、也就不会去动它。
   *
   * 为什么用 `visibility` 而不是 `display: none`：原版 SVG 得**继续占着**它那格布局。
   * 一旦它退出布局，按钮里其它依赖流式排布的兄弟会跑位。`visibility: hidden` 同时
   * 满足「看不见」和「仍占位」。
   *
   * 尺寸靠**照抄原版的 class**：注入节点与原版 class 相同、又在同一个父容器里，
   * 所以整条 CSS 级联（按钮里的 `h-2.5 lg:h-3.5`、chip 与抽屉里父级的 `[&>svg]:h-3`…）
   * 对两者的结果必然一致，我们不需要复刻任何一条 CSS 逻辑。
   */
  function patchIcon(svg, phase) {
    // 把原版藏起来并标记：这样即使下面注入失败，也不会在同一轮里被反复处理。
    // 用内联样式而不是 class —— 内联样式优先级高于任何选择器，不会被站点 CSS 改回去。
    svg.style.visibility = "hidden";
    svg.setAttribute(ORIGINAL_MARK, phase);

    // 我们自己的 SVG。属性用图标库那一套（24 网格、描边式）。
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", ICON_VIEW_BOX);
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", ICON_STROKE_WIDTH);
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("data-prz", phase);

    // 尺寸：照抄 class（见上面的说明）。class 缺失也能跑，只是会退回 SVG 默认尺寸。
    const originalClass = svg.getAttribute("class");
    if (originalClass) icon.setAttribute("class", originalClass);

    // 尺寸**只靠照抄来的 class**，不写内联宽高。
    //
    // 注入节点与原版的 class 完全相同、又在同一个父容器里，所以整条 CSS 级联
    // （按钮上的 `h-2.5 lg:h-3.5`、chip 与抽屉里父级的 `[&>svg]:h-3`…）对两者的
    // 结果必然一致——包括 flex 收缩这类不好复刻的情况。
    //
    // 试过另外两种写法，都不如这条：
    //   * 写 `width`/`height` **属性**：属性与 CSS 会打架（CSS 只约束高度时，
    //     属性又把宽度定死），实测注入 14px 而原版 4px。
    //   * 把量到的像素写成**内联样式**：优先级最高，虽然当下一定对得上，但站点 CSS
    //     变化时不会跟着变，而且每多一个内联维度就多一处要跟 CSS 对齐的东西。
    try {
      icon.style.color = getComputedStyle(svg).color;
    } catch { /* 取不到就靠继承 */ }

    // 覆盖在原版上面。`visibility` 会继承，所以新节点必须显式设回 visible，
    // 否则它跟着原版一起隐形。
    icon.style.visibility = "visible";
    icon.style.position = "absolute";
    icon.style.pointerEvents = "none";

    // 位置也**实测锚定**，不靠「绝对定位元素的静态位置」。
    //
    // 静态位置在 flex 容器里和原版的真实位置并不总是重合——实测 10 个图标里有 1 个
    // 横向偏了 3.7px（原版是被 `justify-center` 居中的 flex item，而绝对定位元素的
    // 静态位置由流内内容决定）。
    //
    // 用 `offsetLeft`/`offsetTop` 而不是自己拿两个 `getBoundingClientRect()` 相减：
    // 后者是**边框盒**坐标，相减时会漏掉祖先的 border 与 padding（试过，10 个全偏）。
    // `offsetLeft`/`offsetTop` 的定义就是「相对 offsetParent 的边框盒偏移」，
    // 而绝对定位元素的 `left`/`top` 也是相对包含块边框盒的偏移——两者天然对齐。
    //
    // 唯一的误差来源是 `offsetParent` 与「CSS 包含块」不是同一个元素：前者要求祖先
    // `position !== static`，与包含块的定义一致；找不到时 `offsetParent` 是 `<body>`，
    // 也正好落在初始包含块内。所以这个近似是可靠的。
    if (svg.offsetParent) {
      icon.style.left = `${svg.offsetLeft}px`;
      icon.style.top = `${svg.offsetTop}px`;
    }
    icon.innerHTML = `<g transform="${ICON_ZOOM_TRANSFORM}">`
      + PHASE_ICON_INNER[phase] + "</g>";

    // 插在原版**后面**（不是前面）：绝对定位元素会画在静态流内容之上，
    // 位置对，而且不会打乱 React 维护的子节点顺序。
    svg.after(icon);
    return icon;
  }

  /**
   * 原始图标的外层 <svg> 只保留 class 与 viewBox 两个属性——其余的（fill 等）
   * 由 `patchIcon` 重设。写成这个形状是为了让适配层可单测：给一个属性快照就能
   * 断言，不需要真的建 DOM。
   */
  const SVG_ATTRS_KEPT = new Set(["class", "viewBox"]);

  function originalSvgAttrs(svg) {
    const attrs = {};
    for (const attr of Array.from(svg.attributes)) {
      if (SVG_ATTRS_KEPT.has(attr.name)) attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  /**
   * 这个 <svg> 是我们要替换的阶段图标吗？
   *
   * `viewBox="0 0 14 14"` 是唯一的判据，实测它在本仓库全代码库里只出现 12 次，
   * 全是阶段图标（其它图标用 16×16 / 20×20 / 24×24），所以不会误伤。
   *
   * 已经打过标记的按「已处理」返回 false，于是这个函数天然幂等——这一点同时是
   * 防死循环的关键：我们的写入会再次触发 MutationObserver，认标记就不会无限循环。
   */
  const ICON_SELECTOR = 'svg[viewBox="0 0 14 14"]';

  /**
   * 原版图标：**保持原样**，只加一个数据标记。
   *
   * 与 `INJECTED_ICON_SELECTOR` 共用同一个 `data-prz*` 前缀，是因为 `groupFans`
   * 要按源码顺序把它们排在一起；两者都算「这个组里的一个阶段图标」，顺序不能乱。
   */
  const ORIGINAL_MARK = "data-prz-src";

  const ORIGINAL_ICON_SELECTOR = `svg[${ORIGINAL_MARK}]`;

  /**
   * 我们注入的那个 SVG —— 负责显示，完全归我们所有。
   *
   * `data-prz` 的值是阶段名，顺带成了「已处理」的凭据。
   */
  const INJECTED_ICON_SELECTOR = "svg[data-prz]";

  /**
   * `typeof SVGElement` 那半句是给 Node 单测用的：脚本在没有 DOM 时也会被加载
   * （只暴露纯函数、跳过装配），此时直接写 `instanceof SVGElement` 会抛
   * ReferenceError，把「能在 Node 里安全加载」这条前提打掉。
   */
  function isUnpatchedIcon(node) {
    return typeof SVGElement === "function"
      && node instanceof SVGElement
      && node.getAttribute("viewBox") === "0 0 14 14"
      && !node.hasAttribute(ORIGINAL_MARK);
  }

  // ── 认出每个 SVG 是哪个阶段 ──────────────────────────────────────────────
  //
  // 12 个图标里有 **两组是重复的**，光看 SVG 内容分不出来：
  //
  //   Ready 与 PostCombatMain   用同一个菱形（源码里是两段一模一样的 JSX）
  //   BeginCombat 与 CombatDamage  都用交叉双剑，只差中心一个圆点
  //
  // 所以第一层用结构：图标 SVG 永远在 PhaseDot 的 button 里，而 button 在容器里
  // 的顺序是源码写死的（PhaseStopBar.tsx 的 LEFT_PHASES / RIGHT_PHASES /
  // COMBAT_PHASES / MobilePhaseChip 的 ALL_PHASES）。按「容器 + 组内序号」就能
  // 唯一确定，不需要读任何文案，也就不受语言和措辞改动影响。
  //
  // 第二层用文案做**交叉校验**：button 的 aria-label 就是 GameplayTooltip 的
  // 全文（`getPhaseTooltip` 的产物），末尾必然是该阶段的描述，例如「重置步骤。
  // 你的已横置永久物在此竖置。」文案表见下面 PHASE_TEXT。两层结论不一致时，以
  // 结构为准（它是源码顺序），但会打一条 console.warn——这正是上游改了文案或
  // 改了顺序时会暴露出来的地方。
  //
  // 为什么不直接用文案当主判据：phase.rs 是多语言的（`useTranslation("game")`），
  // 换到英文界面这套中文表就全失效了。结构判据不吃这一套。

  /**
   * 每个阶段的描述文案（`client/src/i18n/locales/zh/game.json` 的
   * `phaseStop.<key>Description`），用于交叉校验，不参与定位。
   */
  const PHASE_TEXT = {
    Untap: "你的已横置永久物在此竖置。",
    Upkeep: "维持触发式异能与周期性费用在此发生。",
    Draw: "你在此抓本回合的牌。",
    PreCombatMain: "在战斗前使用地并施放咒语。",
    BeginCombat: "选择攻击者之前的最后一个优先权窗口。",
    DeclareAttackers: "由攻击牌手选择攻击者。",
    DeclareBlockers: "由防御牌手选择阻挡者。",
    CombatDamage: "生物分配并造成战斗伤害。",
    EndCombat: "造成伤害后的最后一个战斗优先权窗口。",
    PostCombatMain: "在战斗后使用地或施放咒语。",
    End: "结束步骤的触发式异能与回合结束时的行动在此发生。",
    Cleanup: "伤害消失，并检查手牌上限。",
  };

  /**
   * 每个阶段的名字（`phaseName.<Phase>`）。**只给手机端 Chip 用**——它的
   * aria-label 是 `phaseStop.chipAria` 拼出来的「当前阶段：{{phase}}。…」，
   * 而 `{{phase}}` 填的正是这张表。
   */
  const PHASE_NAME = {
    Untap: "重置步骤",
    Upkeep: "维持步骤",
    Draw: "抓牌步骤",
    PreCombatMain: "战斗前主阶段",
    BeginCombat: "战斗开始步骤",
    DeclareAttackers: "宣告攻击者步骤",
    DeclareBlockers: "宣告阻挡者步骤",
    CombatDamage: "战斗伤害步骤",
    EndCombat: "战斗结束步骤",
    PostCombatMain: "战斗后主阶段",
    End: "结束步骤",
    Cleanup: "净化步骤",
  };

  /**
   * 容器识别表。`kind` 对应一条定位规则：
   *
   *   combat   战斗条（有 data-combat-phase-indicator）：源码顺序即 5 个战斗步骤
   *   hud      玩家 HUD 里的左右两条：3 个一组与 2 个一组，靠**组内数量**区分，
   *            因为它们的 class 完全相同、只差渲染顺序
   *   mobile   手机端 Chip 与其操作行合并后的祖先容器
   *   sheet    阶段停止抽屉（12 个一组）
   *
   * 每条规则回答「这个图标是本组第几个」→ 阶段名。返回 null 表示这个容器不认识，
   * 宁可放过也不猜错——猜错会把某个阶段的图标画到另一个阶段上。
   */
  /**
   * 这个组里所有阶段图标，**按源码顺序**。
   *
   * 只数**原版**节点，一个阶段恰好一个，所以序号与源码顺序一一对应。
   *
   * 曾经把注入节点也算进来，那是个 bug：一个 3 个阶段的容器会变成 6 个「扇区」，
   * 组识别（按组内数量区分左右两条 HUD）直接认不出来，自愈路径因此失效。
   * 旧实现里「已替换的也要算」是因为替换把 viewBox 改成了 24 网格、图标从
   * `ICON_SELECTOR` 里消失了；现在替换是旁挂的，原版**始终留在原地**，
   * 这个问题自然不存在了。
   */
  function groupFans(groupElement) {
    return Array.from(groupElement.querySelectorAll(`${ICON_SELECTOR}, ${ORIGINAL_ICON_SELECTOR}`));
  }

  /**
   * 从 button 往上找那个「装着整组阶段图标」的容器。
   *
   * 不能直接取 `button.parentElement`：阶段停止抽屉里 button 的父节点是 `<li>`
   * （`MobilePhaseChip.tsx` 的 PhaseStopRow 是 li > button > span > svg），一个
   * `<li>` 里只有一个图标，序号永远是 0，整组会认错。所以往上走到第一个含 ≥2 个
   * 阶段图标的祖先为止。
   *
   * **必须在 `<body>` 之前停下。** 一直往上走会走到 `<html>`，那里的图标来自整份
   * 文档——拿它当一组的话，任意一个不认识的容器都会被「全文档的第 N 个」认走，
   * 正是这个函数要避免的误判。走不到就返回 null，宁可放过。
   */
  function groupContainer(button) {
    let node = button.parentElement;
    while (node && node !== document.documentElement && node !== document.body) {
      if (groupFans(node).length >= 2) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 按「容器 + 组内序号」定阶段。
   *
   * 四种容器，四种判据。共同点是**都只用结构**，不读文案：
   *
   *   data-combat-phase-indicator   战斗条，5 个，顺序写死在 COMBAT_PHASES
   *   组内 3 个                      玩家 HUD 左条（Upkeep / Draw / Main1）
   *   组内 2 个                      玩家 HUD 右条（Main2 / End）
   *   12 个一组                      手机操作行与阶段抽屉，按 CR 500.1 全序列
   *
   * 除这四条之外**不加兜底规则**。组内数量是前两条仅有的区分依据，加一条「默认按
   * 全序列」的兜底就会让不认识的容器也有结论——实测过一个 4 个按钮的容器因此被
   * 认走了 3 个。认不出来就返回 null，让原版图标留着。
   */
  function phaseByGroup(groupElement, icon) {
    const fans = groupFans(groupElement);
    const index = fans.indexOf(icon);
    if (index < 0) return null;

    if (groupElement.hasAttribute("data-combat-phase-indicator")) {
      return ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"][index] ?? null;
    }

    // 手机端操作行：chip + 12 个停止按钮挤在同一个祖先里，所以这个容器会同时
    // 包含 chip 的图标和整行。组内第一个带 8 半径的圆时就是「重置」——整个界面
    // 只有它长这样，拿它当锚点比数「刚好 12 个」更不容易被上游改动带坏。
    if (index === 0 && icon.querySelector('circle[r="8"]')) return "Untap";

    // 12 个一组的剩下两种：阶段停止抽屉，以及手机操作行里那 12 个。
    // 不校验数量——抽屉开着的时候，行本身只会多不会少。
    if (index < PHASES.length && (groupElement.closest('[role="dialog"]') || fans.length === PHASES.length)) {
      return PHASES[index];
    }

    if (fans.length === 3) return ["Upkeep", "Draw", "PreCombatMain"][index] ?? null;
    if (fans.length === 2) return ["PostCombatMain", "End"][index] ?? null;
    return null;
  }

  /**
   * 从 button 的 aria-label 里认阶段：描述文案必须**完整**出现在标签里。
   *
   * 这里刻意不做「只看末尾 N 个字符」的截断。最初写成 `label.slice(-40)` 是个 bug：
   * 描述文案长短不一（`维持触发式异能与周期性费用在此发生。` 比 `你在此抓本回合的
   * 牌。` 长出不少），加上标签前缀之后短描述留在窗口内、长描述被截掉，于是只有
   * 一部分阶段能校验上——而且失败得毫无规律。
   *
   * 完整包含 + 唯一命中就够了：12 条描述互不包含，而 `getPhaseTooltip` 的产物里
   * 必然带完整描述。
   *
   * **只在 Chip 上用**，不当作结构判据失败时的兜底。理由是实测教训：把文案当兜底
   * 之后，一个「四个按钮、谁也不认识」的容器会被文案认走三个——而认错的代价是把
   * 某个阶段的图标画到另一个阶段上，比不换糟得多。结构判据认识才动手。
   */
  function phaseByText(button) {
    const label = button && button.getAttribute && button.getAttribute("aria-label");
    if (!label) return null;
    let found = null;
    for (const phase of PHASES) {
      if (!label.includes(PHASE_TEXT[phase])) continue;
      if (found !== null) return null; // 命中两条说明表本身有问题，放弃
      found = phase;
    }
    return found;
  }

  /**
   * 手机端 Chip（`MobilePhaseChip.tsx`）：它是**唯一**自己带 aria-label 的阶段图标。
   *
   * 它认自己靠的是 `aria-haspopup="dialog"` 这个结构特征，而不是「看看文案像不像」
   * ——没有这个特征就不认，所以不会误伤别的容器。认出来之后才用文案表定阶段，
   * 表的份额由 `phaseStop.chipAria`（`phaseName.<Phase>`）决定。
   */
  function phaseByChip(button) {
    if (button.getAttribute("aria-haspopup") !== "dialog") return null;
    const label = button.getAttribute("aria-label");
    if (!label) return null;
    for (const phase of PHASES) {
      if (label.startsWith(`当前阶段：${PHASE_NAME[phase]}`)) return phase;
    }
    return null;
  }

  /**
   * 对一个候选 SVG 判定阶段。返回阶段名或 null。
   *
   * 结构判据（容器 + 组内序号）是唯一会动手的依据；文案只在两种情况下参与：
   * Chip 自己认自己，以及结构判据有结论时做交叉校验。找不到就返回 null——
   * 阶段图标认错比不换更糟。
   */
  function identifyPhase(icon) {
    const button = icon.closest("button");
    if (!button) return null;

    const byChip = phaseByChip(button);
    if (byChip !== null) return byChip;

    const group = groupContainer(button);
    if (!group) return null;

    const byPlace = phaseByGroup(group, icon);
    if (byPlace === null) return null;

    // 有结论之后再拿文案校对一次：这里只报警不动手。上游改了措辞或改了阶段顺序
    // 时，这条警告就是最先冒出来的信号。
    const byText = phaseByText(button);
    if (byText !== null && byText !== byPlace && debug()) {
      console.warn(`[phase-rs-zh] 阶段图标的结构判据与文案判据不一致：位置=${byPlace} 文案=${byText}`);
    }
    return byPlace;
  }

  /** 这个阶段的名字（用于排障输出）。 */
  function phaseSource(phase) {
    return PHASE_ICON_SOURCE[phase] ?? "?";
  }

  /**
   * 给一批图标**先**定好阶段，返回 `Map<svg, phase>`。
   *
   * 必须先算完再动手，这是踩过的坑：`patchIcon` 会把 viewBox 改成 24 网格，于是
   * 刚换过的图标从 `svg[viewBox="0 0 14 14"]` 里消失。如果一边替换一边重新查询，
   * 同组里第二个图标的序号会从 1 变成 0、组的长度从 3 变成 2，整组认错——而且只
   * 错一部分，看起来像是「随机有几个没换」。
   *
   * 所以识别是**对当时的 DOM 快照**一次性完成的，替换只是照着结果执行。
   */
  function resolvePhases(candidates) {
    const planned = new Map();
    for (const icon of candidates) {
      if (!isUnpatchedIcon(icon)) continue; // 已处理的直接跳过，这个入口可能被单独调用
      try {
        const phase = identifyPhase(icon);
        if (phase !== null) planned.set(icon, phase);
      } catch (error) {
        // 一个图标认不出来不该影响别的。
        if (debug()) console.warn("[phase-rs-zh] 阶段图标识别失败", error);
      }
    }
    return planned;
  }

  function scanPhaseIcons() {
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(ICON_SELECTOR)).filter(isUnpatchedIcon);
    } catch (error) {
      // querySelectorAll 本身不该抛，但这里多一层兜底的成本是零。
      if (debug()) console.warn("[phase-rs-zh] 阶段图标候选收集失败", error);
      return;
    }
    const planned = resolvePhases(candidates);
    for (const [icon, phase] of planned) {
      try {
        if (!icon.isConnected) continue; // 识别到替换之间被卸载了
        // 标记由 patchIcon 负责打（它要先标记再注入，避免注入失败时被反复重试）。
        patchIcon(icon, phase);
      } catch (error) {
        if (debug()) console.warn("[phase-rs-zh] 阶段图标替换失败", error);
      }
    }
  }

  /**
   * 阶段图标的 MutationObserver。
   *
   * **刻意不和卡图的 observe() 合并。** 那个观察器挂的是 attributes + src/srcset，
   * 语义是「属性变了就重写 URL」；这边只需要 childList。两种语义混在一个回调里
   * 会让两边都变难读，而它们本来就是两件不相干的事。
   *
   * 只在 childList 上触发的原因：patchIcon 改的是属性，属性变化不会回调到这里，
   * 所以天然没有「自己触发自己」的路径。`data-prz` 标记是第二道闸，防的是同一
   * 节点被反复处理。
   */
  function observePhaseIcons() {
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      let relevant = false;
      for (const record of records) {
        // 路径 A：**原版图标节点被挂进来**（组件 remount）。
        //
        // 这里必须 `preventDefault()`：remount 时 React 生成的是**新的** React 元素，
        // 于是会老老实实插入一个新的 DOM 节点；但如果我们放它进来、由扫描去加标记，
        // 万一 React 之后复用/校验这个节点，我们加的那个属性就成了一份它不知道的
        // 差异。取消这次插入等于告诉 React「这次没插成」，它会去插入自己的下一个候选
        // ——正是我们想要的「把控制权交回 React」。
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof SVGElement && isUnpatchedIcon(node)) {
            record.preventDefault();
            relevant = true;
            break;
          }
          // 新挂进来的可能是一整棵子树（比如组件卸载重建、抽屉打开），
          // 里面照样可能有阶段图标。
          if (node instanceof Element
            && (node.querySelector(ICON_SELECTOR) || node.querySelector(ORIGINAL_ICON_SELECTOR))) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        // 路径 B：**我们注入的节点被删了**。原版还在（只是 visibility: hidden），
        // 重新注入一次就能自愈——比如 React 按子节点顺序做了一次重排。
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof SVGElement && node.hasAttribute("data-prz")) { relevant = true; break; }
        }
        if (relevant) break;
      }
      if (!relevant) return;
      // 走整轮扫描而不是只处理那一个节点：识别依赖「组里有几个图标」，而组里的
      // 其它成员可能刚好也在这一批记录里。整轮扫描一次批次只做一次。
      //
      // **整个回调都必须包在 try 里**：观察器回调抛出的异常没人接，会变成未捕获异常
      // ——而 phase.rs 有全局 `error` 监听把任何未捕获异常上报成 `js_error`
      // （`services/telemetryEvents.ts`），在界面上就表现为「游戏崩溃」。我们的代码
      // 不该有任何路径能把异常泄漏到那个层面。
      try {
        // 先把「已标记但注入节点已不在」的原版放开，让它们有机会被重新注入。
        // 正常情况下这一步什么也不做（标记与注入节点总是成对存在）。
        for (const original of document.querySelectorAll(ORIGINAL_ICON_SELECTOR)) {
          const injected = original.nextElementSibling;
          if (!injected || !injected.hasAttribute("data-prz")) {
            original.removeAttribute(ORIGINAL_MARK);
            original.style.visibility = "";
          }
        }
        scanPhaseIcons();
      } catch (error) {
        if (debug()) console.warn("[phase-rs-zh] 阶段图标扫描失败", error);
      }
    });
    observer.observe(root, { subtree: true, childList: true });
  }

  /**
   * 装配。必须在同一文档里幂等。
   *
   * 书签小工具载体下重复点击是常态（切换页面、手滑、忘了点过）。不加这道闸，
   * 第二次点击会再挂一个 window 上的 error 监听：一次加载失败会让两个监听各降
   * 一级，中文图直接跳过英文层掉到 Scryfall 兜底——正好破坏了阶梯存在的意义。
   * 扩展载体下浏览器只注入一次；但这条闸对两种载体都成立，没有理由不加。
   *
   * 重复进入时仍跑一次两套扫描：把上次点击之后新渲染出来的图和图标补上。
   *
   * **两套逻辑共用这一道幂等闸，但装配的东西互不相干：** 卡图挂的是原型补丁的
   * attributes 观察器与 window error 监听，阶段图标挂的是自己的 childList 观察器。
   * 共用闸门是对的——重复点击时两边都不该再挂第二份监听；而每次补扫描则对两边
   * 都成立。
   */
  function install() {
    if (globalThis.__phaseZhCardArtInstalled === true) {
      scanCardImages();
      scanPhaseIcons();
      return;
    }
    globalThis.__phaseZhCardArtInstalled = true;

    patchImageProperty("src", (value) => rewriteUrl(value));
    patchImageProperty("srcSet", (value, image) => mapSrcset(value, (url) => (
      isCorsOnly(image, url) ? url : rewriteUrl(url)
    )));
    patchImageProperty("srcset", (value, image) => mapSrcset(value, (url) => (
      isCorsOnly(image, url) ? url : rewriteUrl(url)
    )));
    patchSetAttribute();
    observe();
    observePhaseIcons();
    window.addEventListener("error", onResourceError, true);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        scanCardImages();
        scanPhaseIcons();
      }, { once: true });
    } else {
      scanCardImages();
      scanPhaseIcons();
    }
    // 从 bfcache 回来时页面可能被浏览器整体恢复过一遍，补一次扫描，
    // 代价只是一次 querySelectorAll 加一次图标扫描。
    window.addEventListener("pageshow", () => {
      scanCardImages();
      scanPhaseIcons();
    });
    console.info(`[phase-rs-zh] 已启用 v${VERSION}`);
  }

  // 测试与诊断入口。测试在 DOM 环境里加载本文件后从这里取纯函数断言。
  globalThis.__phaseZhCardArt = {
    version: VERSION,
    tiers: TIERS,
    origins: ORIGINS,
    relayPath: RELAY_PATH,
    splitHttpsUrl,
    parseArtUrl,
    urlFor: (tier, ref) => urlFor({ ref }, tier, tier === "scryfall" ? "direct" : "cdn"),
    urlForParsed: (parsed, tier, origin) => urlFor(parsed, tier, origin ?? parsed.origin),
    urlForRelay: (tier, ref) => urlFor({ ref }, tier, "relay"),
    rewriteUrl,
    nextTierUrl,
    retryUrl,
    probeArtUrl,
    mapSrcset,
    srcsetCandidates,
    stepUrl,
    advanceLadder,
    rewriteElement,
    givenUp,
    retryCounts,
    /** 探测结果有 30 秒缓存（真实使用里这是省请求的关键）。测试要换答案时必须
     *  先清掉它，否则用例之间会互相串味。 */
    clearProbeCache() {
      probeCache.clear();
      probePending.clear();
    },
  };

  // 阶段图标那一半的诊断入口。刻意与上面那个对象分开：两套逻辑除了共用幂等闸，
  // 没有任何共享状态，各自的测试入口也各归各。
  globalThis.__phaseZhPhaseIcons = {
    phases: PHASES,
    iconSource: PHASE_ICON_SOURCE,
    iconInner: PHASE_ICON_INNER,
    text: PHASE_TEXT,
    selector: ICON_SELECTOR,
    originalSelector: ORIGINAL_ICON_SELECTOR,
    injectedSelector: INJECTED_ICON_SELECTOR,
    originalMark: ORIGINAL_MARK,
    viewBox: ICON_VIEW_BOX,
    zoom: ICON_ZOOM,
    strokeWidth: ICON_STROKE_WIDTH,
    zoomTransform: ICON_ZOOM_TRANSFORM,
    patchIcon,
    originalMark: ORIGINAL_MARK,
    originalSvgAttrs,
    isUnpatchedIcon,
    groupFans,
    groupContainer,
    phaseByGroup,
    phaseByText,
    phaseByChip,
    phaseName: PHASE_NAME,
    identifyPhase,
    resolvePhases,
    scanPhaseIcons,
  };

  // 脱离 DOM 加载（Node 单测）时只暴露上面的纯函数，不装配。
  if (typeof window !== "undefined" && typeof document !== "undefined"
    && typeof HTMLImageElement === "function") {
    // 装配失败也不该把异常抛进页面：书签是「点一下就该生效」的东西，一个初始化异常
    // 会让整个功能不可用，还会被应用的遥测记成 js_error。
    try {
      install();
    } catch (error) {
      console.error("[phase-rs-zh] 装配失败", error);
    }
  }
})();
