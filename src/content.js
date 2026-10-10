/**
 * Phase 中文卡图 — 书签小工具正文（bookmarklet，在页面自己的世界里执行）。
 *
 * 作用：把 phase.rs 网页版渲染的卡图，全部改走大学院废墟（mtgch.com）的图床：
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
  const VERSION = "1.1.0";

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

  function scan() {
    // 用 querySelectorAll 而不是 document.images：语义相同（都是文档里的 img
    // 元素），但 document.images 并非所有 DOM 实现都提供，测试环境就会缺。
    for (const image of Array.from(document.querySelectorAll("img"))) rewriteElement(image);
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
    void resolveTierFailure(image, onLadder);
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
      for (const record of records) {
        if (record.type !== "attributes") continue;
        const target = record.target;
        if (target instanceof HTMLImageElement) rewriteElement(target);
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
  }

  /**
   * 装配。必须在同一文档里幂等。
   *
   * 书签小工具载体下重复点击是常态（切换页面、手滑、忘了点过）。不加这道闸，
   * 第二次点击会再挂一个 window 上的 error 监听：一次加载失败会让两个监听各降
   * 一级，中文图直接跳过英文层掉到 Scryfall 兜底——正好破坏了阶梯存在的意义。
   * 扩展载体下浏览器只注入一次；但这条闸对两种载体都成立，没有理由不加。
   *
   * 重复进入时仍跑一次 `scan()`：把上次点击之后新渲染出来的图补上。
   */
  function install() {
    if (globalThis.__phaseZhCardArtInstalled === true) {
      scan();
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
    window.addEventListener("error", onResourceError, true);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scan, { once: true });
    } else {
      scan();
    }
    // 从 bfcache 回来时页面可能被浏览器整体恢复过一遍，补一次扫描，
    // 代价只是一次 querySelectorAll。
    window.addEventListener("pageshow", scan);
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

  // 脱离 DOM 加载（Node 单测）时只暴露上面的纯函数，不装配。
  if (typeof window !== "undefined" && typeof document !== "undefined"
    && typeof HTMLImageElement === "function") {
    install();
  }
})();
