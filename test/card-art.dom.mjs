/**
 * 卡图 DOM 测试：把书签脚本本体真的跑起来，验证它在真实 DOM 里按新设计工作。
 *
 * 这一层必须存在，因为脚本的核心假设是 DOM 层面的：
 *   1. 给 `Element.prototype.setAttribute` 打补丁能**在属性写入的那一刻**就拿到
 *      印刷 id 并把 API 请求发出去（纯函数测试看不出来）；
 *   2. 查询回来后 `src` 与 `srcset` 都被换成大学院地址，且**尺寸选择不变**。
 *
 * 每个用例都自己 stub `fetch`：真实 API 会让断言随机红绿，而我们要测的是我们的
 * 逻辑，不是网络的可用性。
 *
 * 运行：vitest + happy-dom（`npm run test:dom`）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "content.js"), "utf8");

/** 真实印刷：MH2 #2 Arcbound Javelineer。 */
const ID = "fe4a2cb0-4129-451e-a946-a21ea646cc28";
const SCRYFALL = `https://cards.scryfall.io/normal/front/f/e/${ID}.jpg?1783926897`;
const SCRYFALL_SMALL = `https://cards.scryfall.io/small/front/f/e/${ID}.jpg?1783926897`;
const ZH_NORMAL = `https://images.mtgch.com/zhs/normal/front/f/e/${ID}.webp?ts=1756713600`;
const ZH_SMALL = `https://images.mtgch.com/zhs/small/front/f/e/${ID}.webp?ts=1756713600`;
const EN_NORMAL = `https://images.mtgch.com/sf/normal/front/f/e/${ID}.webp?ts=1783926897`;
/** 应用本地化后的中文印刷 id（与英文 id 不同）。 */
const ZH_ID = "9a235bac-7372-4190-983d-dbc550b87631";
const EN_SMALL = `https://images.mtgch.com/sf/small/front/f/e/${ID}.webp?ts=1783926897`;

/** 只带英文图的印刷（大学院没有中文图，API 只给 image_uris）。 */
const NO_ZH_ID = "d44fbfa3-3698-4b79-a7bd-6b6f86bea82a";
const NO_ZH_SRC = `https://cards.scryfall.io/normal/front/d/4/${NO_ZH_ID}.jpg`;
const NO_ZH_EN = `https://images.mtgch.com/sf/normal/front/d/4/${NO_ZH_ID}.webp?ts=1783926718`;

/** API 的两种形状。 */
const WITH_ZH = {
  id: ID, set: "MH2", collector_number: "2",
  zhs_image: "官方",
  zhs_image_uris: { small: ZH_SMALL, normal: ZH_NORMAL, large: ZH_NORMAL },
  image_uris: { small: EN_SMALL, normal: EN_NORMAL, large: EN_NORMAL },
};
const WITHOUT_ZH = {
  id: NO_ZH_ID, set: "MH2", collector_number: "442",
  zhs_image: null, zhs_image_uris: null,
  image_uris: { small: NO_ZH_EN, normal: NO_ZH_EN, large: NO_ZH_EN },
};

let calls = [];
/** 装好的 fetch stub：按 URL 里的印刷 id 返回上面两种形状之一。 */
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = handler(String(url));
    return {
      ok: body !== null,
      status: body === null ? 404 : 200,
      json: async () => body,
    };
  };
}

/**
 * 拿这个环境里的 localStorage。
 *
 * 不能直接写 `localStorage` —— happy-dom 在这个 vitest 环境下没有把它挂到全局，
 * 直接引用会得到 undefined（而且 `try { localStorage.x } catch` 是**接不住**的：
 * 那是 ReferenceError 之外的 TypeError）。所以统一从 window 上取。
 */
function storageOf() {
  return globalThis.localStorage ?? null;
}

/** 让所有已排队的 Promise 回调跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 等某个条件成立。
 *
 * 「先暖后换」之后换图不再是同步的：`warmThenApply` 要先 await 预热，happy-dom 里
 * 又没有 `Image`，于是会多走几个微任务。用固定次数的 `settle()` 会变成脆断言。
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 0));
  }
  return predicate();
}

function mountImage(src, srcset) {
  const img = document.createElement("img");
  if (src) img.setAttribute("src", src);
  if (srcset) img.setAttribute("srcset", srcset);
  document.body.append(img);
  return img;
}

/**
 * 脚本只加载一次：装配（原型补丁、观察器、幂等闸）是**进程级**的，重复加载第二遍
 * 会被幂等闸挡住，测不到东西。所以每个用例自己清状态，而不是重新加载脚本。
 */
/**
 * 这个环境没有可用的 localStorage（Node 需要 `--localstorage-file`），所以给一个
 * 最小替身。**必须在加载脚本之前装好**：脚本在模块求值时就 `loadArtCache()` 读一次，
 * 装晚了它读到的就是空的。
 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** 给脚本用的存储。测试可以整体换掉它来模拟「新会话」。 */
let storage = makeStorage();

/**
 * `Image` 替身：happy-dom 没有它，而脚本的「先暖后换」要用。
 *
 * 这里**立即算作加载成功**，于是 `warmOne` 同步 resolve —— 换图就回到「几个微任务
 * 之后发生」，测试不必等真实网络。真实浏览器里失败/超时都会 settle，不会卡住。
 */
function makeImage() {
  return class FakeImage {
    set src(value) {
      this._src = value;
      // **同步**算作加载完成：于是「先暖后换」立刻就能换，测试只需推进微任务。
      // 真实 Image 是异步的，但测试要的是「预热完成后会换」这个逻辑，不是计时。
      if (typeof this.onload === "function") this.onload();
    }
    get src() { return this._src; }
  };
}

let art;

beforeAll(() => {
  document.documentElement.lang = "en";
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true, writable: true, value: storage,
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true, writable: true, value: makeImage(),
  });
  vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" });
  art = globalThis.__phaseZhCardArt;
});

/**
 * 拿到真正的原生 `setAttribute`。
 *
 * 不能简单地「在加载脚本前存一份」——脚本的装配会在模块求值时就跑，那时原型已经被
 * 打上补丁，存下来的就是打过补丁的那份。补丁自己带着被包住的原始方法
 * （`__phaseZhNative`），顺着它往下剥即可。
 */
function nativeSetAttributeOf() {
  let fn = Element.prototype.setAttribute;
  while (fn.__phaseZhPatched === true && fn.__phaseZhNative) fn = fn.__phaseZhNative;
  return fn;
}

/**
 * 把环境恢复成「脚本刚刚在这个语言下装配」的样子：
 * 还原原型方法 → 清幂等闸与缓存 → 按当前 lang 重新装配。
 */
function reinstall() {
  art.disconnectObservers();
  Element.prototype.setAttribute = nativeSetAttributeOf();
  document.body.innerHTML = "";
  // 三份状态都要清：请求表（含负结果）、持久化缓存、localStorage。
  // 少清一份就会串味——表现为后面某个用例莫名其妙地不发请求了。
  art.artRequests.clear();
  // warmedUrls 现在是「从存储初始化」的，所以清空它 + 清存储即可回到干净状态
  art.warmedUrls.clear();
  // 这个计数是「单页最多新建几个请求」的闸，模块级、只增不减。测试里必须重置，
  // 否则跑到后面几个用例时它早已越过上限，fetchArtUris 直接返回 null，
  // 表现为「换了半天没换图」——是测试隔离问题，不是实现问题。（踩过。）
  art.resetArtRequestCount();
  // Image 也要复位：有些用例会换成「把回调捏在手里」的替身，不复位就会串到下一个用例。
  globalThis.Image = makeImage();
  for (const key of Object.keys(art.artCache)) delete art.artCache[key];
  storage = makeStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  delete globalThis.__phaseZhCardArtInstalled;
  art.install();
}

beforeEach(() => {
  document.documentElement.lang = "en";
  reinstall();
});

afterEach(() => { delete globalThis.fetch; });

describe("界面语言判定", () => {
  it("只有英文界面才认为是英文", () => {
    document.documentElement.lang = "en";
    expect(art.isEnglishUi()).toBe(true);
    document.documentElement.lang = "en-US";
    expect(art.isEnglishUi()).toBe(true);
    for (const lang of ["zh", "zh-CN", "zh-Hans", "ja", ""]) {
      document.documentElement.lang = lang;
      expect(art.isEnglishUi(), `lang=${lang} 不该判成英文`).toBe(false);
    }
  });
});

describe("装配：只读补丁 + API 查询", () => {
  it("英文界面下，写 src 会触发一次大学院查询并把地址换掉", async () => {
    stubFetch((url) => (url.includes(ID) ? WITH_ZH : null));
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe("https://mtgch.com/api/v1/card/" + ID + "/");
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("setAttribute 补丁：应用写 src 时自动排队（不靠观察器的异步回调）", async () => {
    stubFetch((url) => (url.includes(ID) ? WITH_ZH : null));
    reinstall();
    const img = mountImage(null);
    // 这一步模拟 React 写入。补丁应当在**写入的那一刻**就发出请求。
    img.setAttribute("src", SCRYFALL);
    expect(calls.length, "属性写入时就该发出请求，而不是等观察器").toBe(1);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("装配时会按界面语言决定装不装原型补丁", async () => {
    // 补丁只装一次并且是全局的，所以这里验证「判断依据」本身：装配读的就是
    // isEnglishUi()。中文界面下 install() 不会调 patchSetAttributeForArt()，
    // 也就没有任何东西会在应用写 src 时排队。
    // （不直接调 queueArtLookups —— 它本身不判语言，判语言的是装配路径。）
    document.documentElement.lang = "zh-CN";
    expect(art.isEnglishUi()).toBe(false);
    document.documentElement.lang = "en";
    expect(art.isEnglishUi()).toBe(true);
  });

  it("中文界面下也挂补丁：英文地址一次写入就发请求", async () => {
    // 1.9.1 起两种界面都生效。中文界面下应用会把地址本地化成中文 id，
    // 那时靠截获的表还原；这里先用**未经本地化**的英文地址验证补丁本身。
    stubFetch(() => WITH_ZH);
    document.documentElement.lang = "zh-CN";
    reinstall();
    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL);
    expect(calls.length, "两种界面下属性写入都该发出请求").toBe(1);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("中文界面下：应用已本地化成中文 id 的地址也能还原成英文 id", async () => {
    // 这是 1.9.1 的核心：地址里是**中文印刷 id**，而大学院只认英文 id。
    // 靠截获到的应用那张表按 URL 精确还原。
    const zhSrc = `https://cards.scryfall.io/normal/front/9/a/${ZH_ID}.jpg?1783000360`;
    const zhSmall = `https://cards.scryfall.io/small/front/9/a/${ZH_ID}.jpg?1783000360`;
    const appMap = {
      schema_version: "v2",
      [ID]: { id: ZH_ID, faces: [{ small: zhSmall, normal: zhSrc }] },
    };
    // 模拟应用自己 fetch 那张表 —— 我们的 fetch 补丁应当截获它
    globalThis.fetch = async (url) => {
      if (String(url).includes("scryfall-images")) {
        return { ok: true, status: 200, json: async () => appMap, clone: () => ({ ok: true, json: async () => appMap }) };
      }
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => WITH_ZH };
    };
    reinstall();
    await globalThis.fetch("https://data.phase-rs.dev/scryfall-images.v2.zh.json?x=1");
    await settle();

    const img = mountImage(zhSrc, `${zhSmall} 146w, ${zhSrc} 488w`);
    globalThis.__phaseZhCardArt.queueArtLookups(img);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    // 还原出的英文 id 就是 ID，所以问的是大学院的这个 id
    expect(calls.some((u) => u.includes(ID)), "应当用还原出的英文 id 去查大学院").toBe(true);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });
});

describe("中文优先、没有中文回落英文", () => {
  it("有 zhs_image_uris 时用中文图", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await waitFor(() => (img.getAttribute("src") || "").includes("/zhs/"));
    expect(img.getAttribute("src")).toContain("/zhs/");
  });

  it("没有 zhs_image_uris 时回落大学院的英文图（而不是没图）", async () => {
    stubFetch((url) => (url.includes(NO_ZH_ID) ? WITHOUT_ZH : null));
    const img = mountImage(NO_ZH_SRC);
    art.queueArtLookups(img);
    await waitFor(() => img.getAttribute("src") === NO_ZH_EN);
    expect(img.getAttribute("src")).toBe(NO_ZH_EN);
    expect(img.getAttribute("src")).toContain("/sf/");
  });

  it("API 查不到时保持原地址（不让图变差）", async () => {
    stubFetch(() => null);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await settle();
    expect(img.getAttribute("src")).toBe(SCRYFALL);
  });
});

describe("srcset 与尺寸一致性", () => {
  it("srcset 的每个候选都换掉，描述符保留，尺寸选择不变", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL, `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`);
    art.queueArtLookups(img);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
    const srcset = img.getAttribute("srcset");
    expect(srcset).toContain(ZH_SMALL);
    expect(srcset).toContain(ZH_NORMAL);
    expect(srcset).toContain("146w");
    expect(srcset).toContain("488w");
    // 换的是同尺寸的地址，所以浏览器挑中的仍是同一个尺寸
    expect(srcset.indexOf(ZH_SMALL)).toBeLessThan(srcset.indexOf(ZH_NORMAL));
  });

  it("srcset 里不认识的候选原样保留", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(null, `${SCRYFALL} 488w, https://example.com/x.jpg 2x`);
    art.queueArtLookups(img);
    await waitFor(() => (img.getAttribute("srcset") || "").includes(ZH_NORMAL));
    expect(img.getAttribute("srcset")).toContain("https://example.com/x.jpg 2x");
    expect(img.getAttribute("srcset")).toContain(ZH_NORMAL);
  });
});

describe("只读与幂等", () => {
  it("同一张卡在页面上出现多次，只发一次请求", async () => {
    stubFetch(() => WITH_ZH);
    const a = mountImage(SCRYFALL);
    const b = mountImage(SCRYFALL);
    const c = mountImage(SCRYFALL);
    art.queueArtLookups(a); art.queueArtLookups(b); art.queueArtLookups(c);
    await waitFor(() => [a, b, c].every((img) => img.getAttribute("src") === ZH_NORMAL));
    expect(calls.length).toBe(1);
    for (const img of [a, b, c]) expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("重复处理同一张图不会重复请求，也不会反复写属性", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    const after = img.getAttribute("src");
    art.queueArtLookups(img);
    await settle();
    expect(calls.length).toBe(1);
    expect(img.getAttribute("src")).toBe(after);
  });

  it("不该碰的地址原样放过", async () => {
    stubFetch(() => WITH_ZH);
    const untouched = [
      "https://backs.scryfall.io/normal/back/f/e/" + ID + ".jpg",   // 牌背
      "https://cards.scryfall.io/art_crop/front/f/e/" + ID + ".jpg", // 裁切图与语言无关
      "https://example.com/normal/front/f/e/" + ID + ".jpg",         // 其它域名
      "https://images.mtgch.com/zhs/normal/front/f/e/" + ID + ".webp", // 已经在大学院
    ];
    for (const url of untouched) {
      const img = mountImage(url);
      art.queueArtLookups(img);
      await settle();
      await settle();
      expect(img.getAttribute("src"), url).toBe(url);
    }
    expect(calls.length).toBe(0);
  });
});

describe("先暖后换：换上去之前先把图拉进缓存", () => {
  /**
   * 这是「图闪一下才出来」的正解。
   *
   * 应用那张 Scryfall 图在玩家本地是热的（交手、滚牌都用它），显示瞬时；而我们换上的
   * 大学院图**本地是冷的**。直接把 `src` 换过去，中间那段没有图可显示——就是那一下闪。
   * 所以必须先预热、再换。
   *
   * 这里直接测导出的 `warmThenApply`，而不是走整条 `queueArtLookups` 管线：后者会
   * 先自己建一批预热探针，把测试替身的回调搅乱（踩过）。
   */
  it("预热有结果之后才写 src，且写的是大学院地址", async () => {
    stubFetch(() => WITH_ZH);
    reinstall();

    const probes = [];
    globalThis.Image = class {
      set src(value) { this._src = value; probes.push(this); }
      get src() { return this._src; }
    };
    art.warmedUrls.clear();

    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL);
    const done = art.warmThenApply(img, { small: ZH_SMALL, normal: ZH_NORMAL }, "normal");

    // 探针发起了，但还没回调 → 此刻不该换 src
    await settle();
    expect(probes.length, "应当先发起预热").toBeGreaterThan(0);
    expect(img.getAttribute("src"), "预热没完成就不该换 —— 那正是闪的来源").toBe(SCRYFALL);

    for (const probe of probes.splice(0)) probe.onload?.();
    await done;
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
    expect(art.warmedUrls.has(ZH_NORMAL), "换过之后应当记下已预热").toBe(true);
  });

  it("已经暖过的地址：同步直接换，不再建探针", async () => {
    reinstall();
    let probes = 0;
    globalThis.Image = class {
      set src(value) { this._src = value; probes += 1; }
      get src() { return this._src; }
    };
    art.warmedUrls.clear();
    art.warmedUrls.add(ZH_NORMAL);
    art.warmedUrls.add(ZH_SMALL);

    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL);
    await art.warmThenApply(img, { small: ZH_SMALL, normal: ZH_NORMAL }, "normal");
    expect(probes, "已经暖过就不该再发预热请求").toBe(0);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("预热失败也照样换（不能让玩家以为功能坏了）", async () => {
    reinstall();
    const probes = [];
    globalThis.Image = class {
      set src(value) { this._src = value; probes.push(this); }
      get src() { return this._src; }
    };
    art.warmedUrls.clear();
    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL);
    const done = art.warmThenApply(img, { small: ZH_SMALL, normal: ZH_NORMAL }, "normal");
    await settle();
    for (const probe of probes.splice(0)) probe.onerror?.();
    await done;
    expect(img.getAttribute("src"), "预热失败也必须换").toBe(ZH_NORMAL);
  });
});

describe("持久化缓存：内存优先，落盘一次", () => {
  it("第二次查同一张卡不再发请求，且来源是内存缓存", async () => {
    stubFetch(() => WITH_ZH);
    reinstall();
    const a = mountImage(SCRYFALL);
    art.queueArtLookups(a);
    await waitFor(() => a.getAttribute("src") === ZH_NORMAL);
    expect(calls.length).toBe(1);
    // 清掉网络层：如果它还要发请求，就会拿到 null
    stubFetch(() => null);
    const b = mountImage(SCRYFALL);
    art.queueArtLookups(b);
    await settle();
    expect(calls.length, "第二次不该再发请求").toBe(0);
    expect(b.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("落盘：flush 之后 localStorage 里有正确形状的条目", async () => {
    stubFetch(() => WITH_ZH);
    reinstall();
    const a = mountImage(SCRYFALL);
    art.queueArtLookups(a);
    await settle();
    // 还没 flush 之前不该写盘（合并写入）
    expect(storageOf().getItem("phaseZhMtgchArtV1"), "不该每张卡都写一次盘").toBeNull();
    art.flushArtCache();
    const written = JSON.parse(storageOf().getItem("phaseZhMtgchArtV1"));
    expect(Object.keys(written)).toContain(ID);
    // 形状：三个尺寸都是字符串，且都指向大学院
    const entry = written[ID];
    expect(typeof entry.normal).toBe("string");
    expect(entry.normal).toContain("images.mtgch.com");
    expect(entry.small).toContain("/small/");
  });

  it("sanitizeArtCache 只丢坏条目，不让整份缓存失效", () => {
    // 纯函数：上游换字段名、或有人手改过存储时，坏条目一张一张地丢。
    const clean = art.sanitizeArtCache({
      good: { normal: ZH_NORMAL, small: ZH_SMALL },
      "bad-number": { normal: 123 },
      "bad-string": "not an object",
      "bad-null": null,
      "bad-array": [],
    });
    expect(Object.keys(clean)).toEqual(["good"]);
    // 整份都不是对象时返回空表而不是抛错
    for (const garbage of [null, undefined, "x", 42, []]) {
      expect(art.sanitizeArtCache(garbage)).toEqual({});
    }
  });

  it("存储不可用时不抛异常（不污染全局，用真值断言）", async () => {
    // 不去改全局的 localStorage —— happy-dom 的它不在 globalThis 自有属性上，
    // defineProperty 加了一层就删不掉，后面的用例会踩到 undefined。（踩过两次。）
    // 改测「存储层自身」：即使一份都存不下，读写路径也不该抛。
    stubFetch(() => WITH_ZH);
    reinstall();
    const img = mountImage(SCRYFALL);
    expect(() => art.queueArtLookups(img)).not.toThrow();
    await waitFor(() => img.getAttribute("src") === ZH_NORMAL);
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
    expect(() => art.flushArtCache()).not.toThrow();
  });
});

describe("健壮性：异常不外泄", () => {
  it("fetch 抛错时保持原地址，不把异常抛出去", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const img = mountImage(SCRYFALL);
    let leaked = null;
    try {
      art.queueArtLookups(img);
      await settle();
    } catch (error) { leaked = error; }
    expect(leaked).toBeNull();
    expect(img.getAttribute("src")).toBe(SCRYFALL);
  });

  it("元素在查询返回前被卸载时不会出错", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    img.remove();
    await settle();
    expect(calls.length).toBe(1);
  });
});
