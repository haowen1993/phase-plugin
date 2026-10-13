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

/** 让所有已排队的 Promise 回调跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
let art;

beforeAll(() => {
  document.documentElement.lang = "en";
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
  art.artRequests.clear();
  try { localStorage.clear(); } catch { /* happy-dom 可能没实现 */ }
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
    await settle();
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
    await settle();
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

  it("中文界面下装配不挂补丁：应用写 src 不发出任何请求", async () => {
    stubFetch(() => WITH_ZH);
    document.documentElement.lang = "zh-CN";
    reinstall();                       // 在中文界面下重新装配
    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL); // 模拟 React 写入
    await settle();
    expect(calls.length, "中文界面下不该发出 API 请求").toBe(0);
    expect(img.getAttribute("src")).toBe(SCRYFALL);
  });

  it("英文界面下装配会挂补丁：同样一次写入就会发请求", async () => {
    stubFetch(() => WITH_ZH);
    document.documentElement.lang = "en";
    reinstall();
    const img = mountImage(null);
    img.setAttribute("src", SCRYFALL);
    expect(calls.length, "英文界面下属性写入就该发出请求").toBe(1);
    await settle();
    expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });
});

describe("中文优先、没有中文回落英文", () => {
  it("有 zhs_image_uris 时用中文图", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await settle();
    expect(img.getAttribute("src")).toContain("/zhs/");
  });

  it("没有 zhs_image_uris 时回落大学院的英文图（而不是没图）", async () => {
    stubFetch((url) => (url.includes(NO_ZH_ID) ? WITHOUT_ZH : null));
    const img = mountImage(NO_ZH_SRC);
    art.queueArtLookups(img);
    await settle();
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
    await settle();
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
    await settle();
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
    await settle();
    expect(calls.length).toBe(1);
    for (const img of [a, b, c]) expect(img.getAttribute("src")).toBe(ZH_NORMAL);
  });

  it("重复处理同一张图不会重复请求，也不会反复写属性", async () => {
    stubFetch(() => WITH_ZH);
    const img = mountImage(SCRYFALL);
    art.queueArtLookups(img);
    await settle();
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
      expect(img.getAttribute("src"), url).toBe(url);
    }
    expect(calls.length).toBe(0);
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
