/**
 * phase.rs 增强 — 书签小工具正文（bookmarklet，在页面自己的世界里执行）。
 *
 * 做两件事：
 *
 *   1. **卡图**：英文界面下，把 phase.rs 渲染的卡图改走大学院废墟（mtgch.com）——
 *      有中文图就用中文图，没有就用大学院自己的英文图。
 *   2. **阶段图标**：把回合阶段栏的 12 个内联 SVG 换成公开图标库（Tabler Icons）的图形。
 *
 * 两件事互不相干，各自独立装配。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 卡图：只在英文界面生效
 * ────────────────────────────────────────────────────────────────────────
 *
 * **中文界面下本脚本完全不碰卡图。** 这是刻意的设计，不是遗漏：
 *
 * phase.rs 在中文界面会给「中文印刷 id」（它自己那张 `scryfall-images.v2.zh.json`
 * 映射表的产物），而大学院图床用的是「英文印刷 id」——两套 id **完全不相交**
 * （实测 84393 条映射里交集只有 4 个）。要换算就得：
 *
 *   - 下载那张 33.9 MB 的映射表（线上 4 MB），而且
 *   - 它本身是**多对一**的：一个中文 id 平均被 2.07 个英文 id 指向，31% 的卡有歧义。
 *     实测「寇族验装兵」的中文版同时被 zen#21 与 gn3#14 指向，而那是**两张不同的整卡**
 *     （基本地更糟：不同系列的插画整个不一样）。
 *
 * 也就是说反查会**指到别的整卡**。这条路的收益（中文卡图）phase.rs 自己已经提供了，
 * 所以直接放弃，只在英文界面下工作。
 *
 * ── 英文界面下的流程 ────────────────────────────────────────────────────
 *
 *   1. 认出应用写的 Scryfall 地址，从文件名取出**英文印刷 id**
 *   2. `GET https://mtgch.com/api/v1/card/{英文印刷id}/`   （实测 52~132ms，CORS 全放行）
 *   3. `zhs_image_uris` 存在就用它（中文图），否则用 `image_uris`（大学院英文图）
 *   4. 把 `src` 与 `srcset` 换成对应尺寸的大学院地址
 *
 * 第 3 步的回落意味着**永远不会没图**：跨 12 个系列实测 3409 张有中文、1329 张回落到
 * 大学院英文图、0 张无图。
 *
 * **已知取舍：会有一次闪烁。** 地址是应用先写进 DOM 的，浏览器立刻就发请求了，API
 * 回来（约 76ms）之前那张英文图可能已经显示出来。先显示（哪怕短暂是英文）比先空白
 * 一段时间更好——这是刻意的选择。要改成不闪，就在换好之前把 img 置为
 * `visibility: hidden`（`hidden` 不影响布局，不会跑位）。
 *
 * ── 为什么用原型补丁而不是只靠观察器 ────────────────────────────────────
 *
 * `MutationObserver` 的回调是异步的（一个微任务之后），而原型补丁在属性写入的那一刻
 * 就能拿到 id 并把请求发出去，让 API 的往返与浏览器加载原图**并行**——省下的正是那
 * 几十毫秒。补丁是**只读**的：它不改 `value`（地址要等 API 回来才知道，同步改不了），
 * 真正的写入发生在 Promise 回调里，所以不会递归触发自己。
 *
 * 书签天然满足「在页面自己的世界里执行」这个前提（`javascript:` 地址本来就在页面
 * 世界里），所以改得动 `Element.prototype`——浏览器扩展的隔离世界改不了。
 *
 * ── 刻意不处理的东西 ───────────────────────────────────────────────────
 *
 * - `backs.scryfall.io`（牌背）与语言无关，不碰。
 * - `art_crop`（插画裁切）与语言无关，不碰。
 * - 已安装的「图像包」：URL 不在 scryfall.io 下，天然不碰。
 * - 桌面版（Tauri 套壳）：书签在 WebView 里用不了。
 *
 * ── 隐私与缓存 ─────────────────────────────────────────────────────────
 *
 * 只把「印刷 id → 三个尺寸的大学院地址」存进 localStorage（键 `phaseZhMtgchArtV1`），
 * 用于跨刷新复用。不写 cookie，不记录任何与玩家身份相关的信息。同一张卡在页面上
 * 出现多次只发一次请求；单页最多新建 400 个请求。
 */
(() => {
  "use strict";

  /**
   * 必须与 package.json 的 `version` 一致——它是用户在控制台确认「装的是哪一版」
   * 的唯一依据，而控制台那行日志是排障的第一步。test/content.test.mjs 里有断言
   * 防止两者漂移。
   */
  const VERSION = "1.9.0";
  // ────────────────────────────────────────────────────────────────────────
  // 卡图：英文界面下改走大学院废墟
  // ────────────────────────────────────────────────────────────────────────
  //
  // ## 只在英文界面生效（刻意的设计，不是遗漏）
  //
  // 中文界面下**完全不碰卡图**。原因是 phase.rs 中文界面会给「中文印刷 id」，而那个
  // id 与大学院图床用的「英文印刷 id」是两套不相交的空间；要换算就得引入一张
  // 33.9 MB 的映射表（而且实测那张表本身是**多对一**的错误聚合，31% 的卡会指到
  // 别的整卡）。绕这一大圈换来的东西，phase.rs 自己已经提供了 —— 所以这里直接放弃。
  //
  // ## 流程（英文界面）
  //
  //   1. 认出应用写的 Scryfall 地址，从文件名里取出英文印刷 id（UUID）
  //   2. `GET https://mtgch.com/api/v1/card/{id}/`  —— 实测 52~132ms，CORS 全放行
  //   3. 有 `zhs_image_uris` 就用它（中文图），否则用 `image_uris`（大学院的英文图）
  //   4. 把 `src` 与 `srcset` 换成对应尺寸的大学院地址
  //
  // **第三步的回落意味着永远不会没图**：跨 12 个系列实测 3409 张有中文、1329 张
  // 回落到大学院英文图、0 张无图。
  //
  // ## 为什么可以先按 Scryfall 加载、再换掉（会有一次闪烁）
  //
  // 地址是应用先写进 DOM 的，浏览器立刻就发请求了；API 回来之前那张英文图可能已经
  // 显示出来。这是**刻意的取舍**：先把图显示出来（哪怕短暂是英文），比先空白一段
  // 时间更好。要改成不闪，就在换好之前把 img 置为 `visibility: hidden`（`hidden`
  // 不影响布局，所以不会跑位）—— 留作以后的可选项。
  //
  // ## 不做的两件事
  //
  // - 不查那张 33.9 MB 的映射表，不做任何「中文印刷 id → 英文印刷 id」的换算。
  // - 不做存在性探测与降级阶梯。大学院图床本身很稳（实测 `/zhs/` 与 `/sf/` 对正确
  //   的 id 都是 4/4、30/30 命中），换上去的地址失败时交给应用自己的降级链处理。
  const MTGCH_API = "https://mtgch.com/api/v1/card/";
  const SCRYFALL_IMAGE_HOST = "cards.scryfall.io";
  const MTGCH_IMAGE_HOST = "images.mtgch.com";

  /** 文件名里就是印刷 id，形状固定。 */
  const ART_FILENAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/;
  /** 应用只用这几种尺寸；`art_crop` 与语言无关，不处理。 */
  const FACE_SIZES = new Set(["small", "normal", "large"]);

  function isEnglishUi() {
    try {
      return /^en\b/i.test(document.documentElement?.getAttribute("lang") ?? "");
    } catch {
      return false;
    }
  }

  /**
   * 从应用写的 Scryfall 地址里取出「尺寸 / front|back / 印刷 id」。
   *
   * 认不出来就返回 null，调用方原样放过——**绝不猜**。已经指向大学院的地址也返回
   * null（不必重复处理），所以本函数天然幂等。
   */
  function parseScryfallImageUrl(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    if (!value.startsWith(`https://${SCRYFALL_IMAGE_HOST}/`)) return null;
    const path = value.slice(`https://${SCRYFALL_IMAGE_HOST}/`.length).split("?")[0].split("#")[0];
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length !== 5) return null;
    const [size, face, shardA, shardB, rawFilename] = segments;
    if (!FACE_SIZES.has(size)) return null;
    if (face !== "front" && face !== "back") return null;
    const match = ART_FILENAME.exec(rawFilename);
    if (!match) return null;
    const printingId = match[1];
    // 分片目录必须是 id 的前两个字符，否则不是我们认识的形状。
    if (printingId[0] !== shardA || printingId[1] !== shardB) return null;
    return { size, face, printingId };
  }

  // ── 查 API 并缓存 ───────────────────────────────────────────────────────

  /**
   * 印刷 id → 三个尺寸的大学院地址（或 null 表示没查到）。
   *
   * 三层缓存，缺一不可：
   *   - `artRequests`：同一张卡在手牌/战场/坟场同时出现时，**只发一次**请求。
   *   - `localStorage`：跨刷新复用。大学院的图很少变，值得持久化。
   *   - 负结果也缓存（内存里），避免对查不到的 id 反复打 API。
   */
  const artRequests = new Map();
  const ART_CACHE_KEY = "phaseZhMtgchArtV1";
  /** 单页最多新建几个请求，防止一次铺满整个牌库时把接口打爆。 */
  const MAX_ART_REQUESTS = 400;
  let artRequestCount = 0;

  function readArtCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(ART_CACHE_KEY) ?? "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  function writeArtCache(printingId, uris) {
    try {
      const all = readArtCache();
      all[printingId] = uris;
      localStorage.setItem(ART_CACHE_KEY, JSON.stringify(all));
    } catch { /* 写不进去就算了，内存缓存仍然有效 */ }
  }

  /**
   * 查一张印刷的大学院地址。返回 `{small, normal, large}` 或 null。
   *
   * 选哪个字段就是「默认中文、没有中文回落到大学院英文图」这条规则的实现：
   * `zhs_image_uris` 存在就用它，否则用 `image_uris`。
   */
  function fetchArtUris(printingId) {
    const cached = artRequests.get(printingId);
    if (cached) return cached;

    const stored = readArtCache()[printingId];
    if (stored) {
      const done = Promise.resolve(stored);
      artRequests.set(printingId, done);
      return done;
    }

    if (artRequestCount >= MAX_ART_REQUESTS) return Promise.resolve(null);
    artRequestCount += 1;

    const task = (async () => {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
      try {
        const response = await fetch(MTGCH_API + encodeURIComponent(printingId) + "/", {
          signal: controller ? controller.signal : undefined,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        const card = await response.json();
        // 双面牌把图放在 faces[] 里，单面牌放顶层；两处都看一下。
        const face = Array.isArray(card?.faces) ? card.faces[0] : null;
        const uris = face?.zhs_image_uris ?? card?.zhs_image_uris
          ?? face?.image_uris ?? card?.image_uris ?? null;
        if (!uris) return null;
        const picked = {};
        for (const size of FACE_SIZES) if (typeof uris[size] === "string") picked[size] = uris[size];
        if (!picked.normal) return null;
        writeArtCache(printingId, picked);
        return picked;
      } catch {
        // 网络失败不写缓存：下次还有机会。
        artRequests.delete(printingId);
        return null;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    })();

    artRequests.set(printingId, task);
    return task;
  }

  // ── 换地址 ──────────────────────────────────────────────────────────────

  /** 用大学院地址重写一条 URL；尺寸对不上或查不到就返回原值。 */
  function swapOneUrl(value, uris) {
    const parsed = parseScryfallImageUrl(value);
    if (!parsed) return null;
    const replacement = uris[parsed.size];
    return replacement ?? null;
  }

  /**
   * 把一个 `<img>` 换成大学院的地址。**这是本区块唯一的写入点。**
   *
   * `src` 与 `srcset` 都要换：浏览器在有 `srcset` 时按 `sizes` 挑候选，只换 `src`
   * 会在挑中 `srcset` 候选时前功尽弃。两个属性用同一个「尺寸 → 地址」映射，所以
   * 挑中的仍是同一个尺寸，取景不变。
   */
  function applyArt(element, uris) {
    const src = element.getAttribute("src");
    if (src) {
      const next = swapOneUrl(src, uris);
      if (next && next !== src) element.setAttribute("src", next);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      const next = mapSrcset(srcset, (url) => swapOneUrl(url, uris) ?? url);
      if (next !== srcset) element.setAttribute("srcset", next);
    }
  }

  /**
   * 看过元素上现有的地址，找出还没有大学院地址的印刷 id 并发起查询；
   * 回来后立刻应用。
   *
   * 同步部分**不写任何属性**：所以它可以安全地待在 `setAttribute` 补丁里，不会
   * 递归、也不会让应用的写入拿到一个被改过的值。
   */
  function queueArtLookups(element) {
    for (const attribute of ["src", "srcset"]) {
      const raw = element.getAttribute(attribute);
      if (!raw) continue;
      const urls = attribute === "src" ? [raw] : srcsetCandidates(raw);
      for (const url of urls) {
        const parsed = parseScryfallImageUrl(url);
        if (!parsed) continue;
        const pending = artRequests.get(parsed.printingId);
        if (pending) {
          // 已经在查（或已缓存）：直接应用，不用再排一次微任务。
          pending.then((uris) => {
            if (uris && element.isConnected) applyArt(element, uris);
          });
          continue;
        }
        fetchArtUris(parsed.printingId).then((uris) => {
          if (uris && element.isConnected) applyArt(element, uris);
        });
      }
    }
  }

  /** 兜底：内联 HTML、SSR 或任何绕开 setAttribute 的写入。 */
  /** 已挂上的观察器。留着是为了能断开——测试要重装，真实使用里重复点击也不该累积。 */
  const liveObservers = [];

  function observeCardImages() {
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      try {
        for (const record of records) {
          const target = record.target;
          if (target instanceof HTMLImageElement) queueArtLookups(target);
        }
      } catch (error) {
        if (debug()) console.warn("[phase-rs-zh] 卡图处理出错", error);
      }
    });
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
    liveObservers.push(observer);
  }

  /** 首屏：所有已经在文档里的 `<img>`。 */
  function scanCardImages() {
    for (const image of document.querySelectorAll("img")) {
      try {
        queueArtLookups(image);
      } catch (error) {
        if (debug()) console.warn("[phase-rs-zh] 卡图处理失败", error);
      }
    }
  }

  /**
   * 排障开关。控制台里执行 `__phaseZhCardArtDebug = true` 之后再点书签，脚本会把
   * 「为什么这张卡没换」之类的判断过程打到控制台。
   */
  function debug() {
    return globalThis.__phaseZhCardArtDebug === true;
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
    return character !== undefined && SRCSET_WHITESPACE.has(character.codePointAt(0));
  }

  /**
   * 按 `srcset` 的语法切成「候选」，对每个候选的 URL 调一次 `map`，再原样拼回去。
   *
   * 自己解析而不是用 `URL`/正则：候选形如 `url 146w` / `url 2x` / 只有 `url`，
   * 逗号既可能是分隔符也可能是 URL 的一部分（`?a=1,b=2`），正规做法是按规范状态机
   * 走。这里只实现改写需要的部分：**候选之间用逗号分隔，但逗号出现在 URL 中间时属于
   * URL**。所以逐字符扫描，遇到空白才开始解析描述符，遇到逗号且不在描述符里就切分。
   */
  function mapSrcset(value, map) {
    if (typeof value !== "string" || value.length === 0) return value;
    let result = "";
    let index = 0;
    const length = value.length;

    while (index < length) {
      // 跳过前导空白与逗号
      while (index < length && (isSrcsetWhitespace(value[index]) || value[index] === ",")) index += 1;
      if (index >= length) break;

      // URL：读到空白或逗号为止
      const urlStart = index;
      while (index < length && !isSrcsetWhitespace(value[index]) && value[index] !== ",") index += 1;
      let url = value.slice(urlStart, index);
      // URL 末尾的逗号属于分隔符，不属于 URL
      let trailingComma = false;
      if (url.endsWith(",")) {
        let trimmed = url;
        while (trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1);
        index -= url.length - trimmed.length;
        url = trimmed;
        trailingComma = true;
      }

      const mapped = map(url) ?? url;

      // 描述符（`146w` / `2x` 等）：读到下一个逗号
      const descriptorStart = index;
      while (index < length && value[index] !== ",") index += 1;
      const descriptor = value.slice(descriptorStart, index).trim();

      if (result.length > 0) result += ", ";
      result += mapped;
      if (descriptor.length > 0) result += " " + descriptor;

      // 吃掉分隔逗号
      if (index < length && value[index] === ",") index += 1;
      else if (trailingComma) { /* 已经消费过 */ }
    }
    return result;
  }

  /** `srcset` 里的所有 URL，顺序不变。 */
  function srcsetCandidates(value) {
    const urls = [];
    mapSrcset(value, (url) => { urls.push(url); return url; });
    return urls;
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
    liveObservers.push(observer);
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
  /**
   * 装配。重复点击时只补扫描，不重复挂监听。
   *
   * 幂等闸对两种载体都成立：书签重复点击会让脚本跑第二遍，而第二次挂的
   * `MutationObserver` 与原型补丁会让同一张卡被处理多次。扩展载体下浏览器只注入
   * 一次，但这条闸没有理由不加。
   *
   * **两套逻辑共用一个闸，但装配的东西互不相干：**
   *   - 卡图：`setAttribute` 补丁 + 一个只盯 `src`/`srcset` 的 attributes 观察器
   *   - 阶段图标：自己的 childList 观察器
   * 共用闸门是对的——重复点击时两边都不该再挂第二份。
   */
  function install() {
    if (globalThis.__phaseZhCardArtInstalled === true) {
      scanCardImages();
      scanPhaseIcons();
      return;
    }
    globalThis.__phaseZhCardArtInstalled = true;

    // 卡图只在英文界面下动。中文界面交给 phase.rs 自己（它已经有中文卡图），
    // 理由见上面「卡图」区块的说明。
    if (isEnglishUi()) {
      patchSetAttributeForArt();
      observeCardImages();
    }
    observePhaseIcons();

    const scan = () => {
      // 用 isEnglishUi() 现判而不是记一个常量：phase.rs 允许在不刷新页面的情况下切
      // 语言，切到英文后新渲染出来的图也应该被处理。
      if (isEnglishUi()) scanCardImages();
      scanPhaseIcons();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scan, { once: true });
    } else {
      scan();
    }
    // 从 bfcache 回来时页面可能被浏览器整体恢复过一遍，补一次扫描。
    window.addEventListener("pageshow", scan);
    console.info(`[phase-rs-zh] 已启用 v${VERSION}`
      + (isEnglishUi() ? "（卡图 + 阶段图标）" : "（仅阶段图标：卡图功能只在英文界面生效）"));
  }

  /**
   * 给 `Element.prototype.setAttribute` 打补丁，让应用写 `src`/`srcset` 时顺手排队
   * 一次大学院查询。
   *
   * **只读不写**：补丁本身不改 `value`，因为地址要等 API 回来才知道，同步改不了。
   * 排队是同步的（`queueArtLookups` 只读属性、发起 fetch），真正的写入在 Promise
   * 回调里，所以不会递归触发自己。
   *
   * 为什么需要原型补丁而不是只靠观察器：`MutationObserver` 的回调是**异步**的
   * （一个微任务之后），而原型补丁在属性写入的那一刻就能拿到 id 并把请求发出去，
   * 让 API 的往返与浏览器加载原图**并行**。省下的就是那几十毫秒。
   */
  function patchSetAttributeForArt() {
    const nativeSetAttribute = Element.prototype.setAttribute;
    if (nativeSetAttribute.__phaseZhPatched === true) return;
    const patched = function setAttribute(name, value) {
      // 记下被包住的原生方法。这样**不需要额外保存全局引用**就能还原：
      // 测试要换环境、或将来要卸载本脚本时，读 `__phaseZhNative` 即可。
      // （踩过：不做这件事的话，测试里存下来的「原生方法」其实已经是打过补丁的，
      // 还原就还原不掉，表现为「中文界面下仍然会发请求」这种假失败。）
      patched.__phaseZhNative = nativeSetAttribute;
      const result = nativeSetAttribute.call(this, name, value);
      if (this instanceof HTMLImageElement) {
        const attribute = String(name).toLowerCase();
        if (attribute === "src" || attribute === "srcset") {
          try {
            queueArtLookups(this);
          } catch (error) {
            if (debug()) console.warn("[phase-rs-zh] 卡图排队失败", error);
          }
        }
      }
      return result;
    };
    patched.__phaseZhPatched = true;
    Element.prototype.setAttribute = patched;
  }

  // 测试与诊断入口。测试在 DOM 环境里加载本文件后从这里取纯函数断言。
  globalThis.__phaseZhCardArt = {
    version: VERSION,
    apiBase: MTGCH_API,
    parseScryfallImageUrl,
    mapSrcset,
    srcsetCandidates,
    swapOneUrl,
    applyArt,
    queueArtLookups,
    fetchArtUris,
    isEnglishUi,
    artRequests,
    install,
    /** 断开本脚本挂上的全部观察器。测试要重装环境时用；生产里重复点击也不会走到这。 */
    disconnectObservers: () => {
      while (liveObservers.length > 0) {
        try { liveObservers.pop().disconnect(); } catch { /* 已经断了 */ }
      }
    },
    /**
     * 现场诊断：控制台执行 `__phaseZhCardArt.report()` 得到一份快照。
     * 排查「哪张卡为什么没换」时先看它。
     */
    report: () => {
      const images = [...document.querySelectorAll("img")].filter((i) => {
        const v = i.getAttribute("src") ?? "";
        return v.includes("scryfall") || v.includes("mtgch");
      });
      const tierOf = (v) => (v.includes("/zhs/") ? "大学院中文"
        : v.includes("/sf/") ? "大学院英文"
          : v.includes("scryfall") ? "Scryfall（未处理或处理中）" : "其它");
      const byTier = {};
      for (const i of images) {
        const t = tierOf(i.getAttribute("src") ?? "");
        byTier[t] = (byTier[t] ?? 0) + 1;
      }
      return {
        界面语言: document.documentElement.getAttribute("lang"),
        卡图功能生效: isEnglishUi(),
        已查询过的印刷: artRequests.size,
        缓存条数: Object.keys(readArtCache()).length,
        卡图总数: images.length,
        按来源: byTier,
        已加载失败: images.filter((i) => i.complete && i.naturalWidth === 0).length,
        仍在加载: images.filter((i) => !i.complete).length,
      };
    },
  };

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
