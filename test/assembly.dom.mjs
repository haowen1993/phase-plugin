/**
 * 装配测试：把书签脚本本体（`src/content.js`）真的跑起来，验证它在 DOM 里确实
 * 拦得住、改得对、失败时降得下去。
 *
 * 为什么这层测试必须存在：脚本的核心假设不是 URL 拼接（那部分在 `test/content.test.mjs`
 * 里用零依赖的 Node 单测覆盖），而是
 *   1. 给 `Element.prototype.setAttribute` 打补丁能拦住 React 的写入；
 *   2. 在捕获阶段 `stopPropagation()` 能压住应用的 `onError`。
 * 这两条一旦不成立，脚本要么不生效，要么把卡牌打成文字占位，而纯函数测试完全看不出来。
 *
 * 直接加载真实文件而不是复制一份实现——复制出来的那份会随时间与本体脱节。
 *
 * 三个写法上的硬约束：
 *   1. 元素必须挂到 document 上。`error` 不冒泡，事件要靠捕获阶段从 window 下来；
 *      游离节点没有传播路径，window 上的监听根本不会触发（真实浏览器里游离的 img
 *      也压根不会发起加载）。
 *   2. 每张走完「降级到 Scryfall」的图都要用独立印刷 id。`givenUp` 是模块级状态，
 *      共用 id 会让后面的断言莫名失败。
 *   3. 用 `vm.runInThisContext` 而不是 import：脚本是 classic script，且每次注入都要
 *      走一遍它自己的装配逻辑（「重复装配幂等」这条用例正是靠这一点）。
 *
 * 还有一条 1.1.0 之后新增的前提：**加载失败的处理是异步的**。脚本要先探测这个 URL
 * 是不是真的 404（`fetch` + `Range: bytes=0-0`），再决定原地重试还是降级。所以断言
 * 之前必须 `await settle()`，并且用 `setProbe()` 决定探测怎么回答——否则测试会去戳
 * 真实的 images.mtgch.com，而那个 CDN 的抖动率会让断言随机红绿。
 *
 * 运行需要 vitest + happy-dom（见 package.json）：`npm install && npm run test:dom`。
 * 零依赖的那套用 `npm test`。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 不用 `new URL(..., import.meta.url)`：vitest 的 happy-dom 环境在某些运行方式下
// 会让 import.meta.url 不是 file: 协议，readFileSync 会直接抛「URL must be of
// scheme file」。import.meta.dirname 稳定给出真实目录（已实测）。
const SCRIPT_SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "content.js"), "utf8");

/** 真实印刷：2X2 #117 Lightning Bolt（大学院废墟有简体中文图）。 */
const ID = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
const SCRYFALL = `https://cards.scryfall.io/normal/front/f/2/${ID}.jpg?1783921885`;
const ZHS = `https://images.mtgch.com/zhs/normal/front/f/2/${ID}.webp`;
const SF = `https://images.mtgch.com/sf/normal/front/f/2/${ID}.webp`;
const SCRYFALL_ART = `https://cards.scryfall.io/art_crop/front/f/2/${ID}.jpg?1783921885`;
const SF_ART = `https://images.mtgch.com/sf/art_crop/front/f/2/${ID}.webp`;

/** 另两张印刷，给会走完降级阶梯的用例独占。 */
const LADDER_ID = "11bf83bb-c95b-4b4f-9a56-ce7a1816307a";
const LADDER_SF = `https://images.mtgch.com/sf/normal/front/1/1/${LADDER_ID}.webp`;
const LADDER_SCRYFALL = `https://cards.scryfall.io/normal/front/1/1/${LADDER_ID}.jpg`;

const LOOP_ID = "000d9280-a79a-4f9f-822c-7aaecbff3337";
const LOOP_SCRYFALL = `https://cards.scryfall.io/normal/front/0/0/${LOOP_ID}.jpg`;
const LOOP_SF = `https://images.mtgch.com/sf/normal/front/0/0/${LOOP_ID}.webp`;

/** 只给「重复装配」用例独占，避免与其它用例的放弃集合互相影响。 */
const TWICE_ID = "a471b306-4941-4e46-a0cb-d92895c16f8a";
const TWICE_ZHS = `https://images.mtgch.com/zhs/normal/front/a/4/${TWICE_ID}.webp`;
const TWICE_SF = `https://images.mtgch.com/sf/normal/front/a/4/${TWICE_ID}.webp`;

/** 给「抖动 → 重试」用例独占：它需要连吃两次失败才降级。 */
const FLUTTER_ID = "66f993bb-c95b-4b4f-9a56-ce7a1816307f";
const FLUTTER_ZHS = `https://images.mtgch.com/zhs/normal/front/6/6/${FLUTTER_ID}.webp`;
const FLUTTER_SF = `https://images.mtgch.com/sf/normal/front/6/6/${FLUTTER_ID}.webp`;

/** 给「带 crossOrigin 的动画元素」用例独占。 */
const CORS_ID = "77a993bb-c95b-4b4f-9a56-ce7a18163080";
const CORS_SCRYFALL = `https://cards.scryfall.io/normal/front/7/7/${CORS_ID}.jpg`;
const CORS_RELAY_ZHS = `/card-art/zhs/normal/front/7/7/${CORS_ID}.webp`;

/** 给「中继地址」用例独占。 */
const RELAY_ID = "88b993bb-c95b-4b4f-9a56-ce7a18163081";
const RELAY_ZHS = `/card-art/zhs/normal/front/8/8/${RELAY_ID}.webp`;
const RELAY_SF = `/card-art/sf/normal/front/8/8/${RELAY_ID}.webp`;

/**
 * 探测替身：脚本会在每个失败的图片上先问「这个 URL 真的不存在吗」，这里决定答案。
 *
 *   "present"  → 2xx（图存在，刚才只是抖动）→ 脚本应原地重试
 *   "missing"  → 404（这张印刷确实没有中文图）→ 脚本应降级
 *   "unknown"  → 5xx（读不懂）→ 按存在处理，重试一次
 *
 * 默认 "missing"：绝大多数用例关心的是阶梯本身，而不是探测。
 */
let probeAnswer = "missing";
let probeCalls = 0;

function setProbe(answer) {
  probeAnswer = answer;
  probeCalls = 0;
  // 探测结果有 30 秒缓存——不清的话，换个答案也还是读到上一个用例的结论。
  globalThis.__phaseZhCardArt.clearProbeCache();
}

/** 等脚本那条异步的失败处理跑完（探测 → 改写属性）。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  // 必须挡住真 fetch：脚本读的是全局 fetch，不挡的话这层测试会去打真实的
  // images.mtgch.com——它的抖动率会让断言随机红绿。
  globalThis.fetch = async () => {
    probeCalls += 1;
    if (probeAnswer === "present") return { status: 206 };
    if (probeAnswer === "unknown") return { status: 502 };
    return { status: 404 };
  };
  vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" });
});

afterAll(() => {
  delete globalThis.fetch;
});

/** 建一个已挂到文档上的 img——游离节点的事件到不了 window。 */
function attachedImage(src) {
  const element = document.createElement("img");
  if (src !== undefined) element.setAttribute("src", src);
  document.body.append(element);
  return element;
}

describe("装配：属性写入时改写", () => {
  it("setAttribute 写 src 被同步改写成中文图", () => {
    const element = attachedImage();
    element.setAttribute("src", SCRYFALL);
    expect(element.getAttribute("src")).toBe(ZHS);
  });

  it("React 用的 src 属性赋值同样被改写", () => {
    const element = attachedImage();
    element.src = SCRYFALL;
    expect(element.getAttribute("src")).toBe(ZHS);
  });

  it("srcset 的每个候选与描述符都被改写", () => {
    const element = attachedImage();
    const small = `https://cards.scryfall.io/small/front/f/2/${ID}.jpg?1783921885`;
    element.setAttribute("srcset", `${small} 146w, ${SCRYFALL} 488w`);
    expect(element.getAttribute("srcset")).toBe(
      `https://images.mtgch.com/zhs/small/front/f/2/${ID}.webp 146w, ${ZHS} 488w`,
    );
  });

  it("art_crop 走大学院废墟英文层（无中文裁切图）", () => {
    const element = attachedImage(SCRYFALL_ART);
    expect(element.getAttribute("src")).toBe(SF_ART);
  });

  it("牌背与其他域名的图片原样放过", () => {
    const back = "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";
    const element = attachedImage(back);
    expect(element.getAttribute("src")).toBe(back);
  });
});

describe("装配：加载失败的降级阶梯", () => {
  it("中文图确认缺失（404）→ 降到大学院废墟英文图，且不给应用 onError 机会", async () => {
    setProbe("missing");
    const element = attachedImage(ZHS);
    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(SF);
    // 关键：应用自己的 onError 一旦跑到，就会把整张卡换成文字占位。
    expect(appNotified).toBe(false);
  });

  it("中文图只是抖动（探测到 206）→ 原地重试，不降级", async () => {
    // 这是 1.1.0 的核心修复。以前这里会直接降到英文：一张**有**中文图的牌只要碰
    // 上一次网络抖动就被永久打成英文，而 givenUp 记下之后本次加载再也不重试。
    setProbe("present");
    const element = attachedImage(FLUTTER_ZHS);

    element.dispatchEvent(new Event("error"));
    await settle();

    const afterFirst = element.getAttribute("src");
    expect(afterFirst).not.toBe(FLUTTER_SF);
    expect(afterFirst.startsWith(FLUTTER_ZHS)).toBe(true);
    expect(afterFirst).not.toBe(FLUTTER_ZHS);

    // 再失败一次：额度（2 次）还没用完，仍然重试。
    element.dispatchEvent(new Event("error"));
    await settle();
    expect(element.getAttribute("src").startsWith(FLUTTER_ZHS)).toBe(true);

    // 第三次：额度用尽，老老实实降级——一个永远取不到的资源不能把页面拖在
    // 重试循环里。
    element.dispatchEvent(new Event("error"));
    await settle();
    expect(element.getAttribute("src")).toBe(FLUTTER_SF);
  });

  it("探测读不懂（5xx）时退一步重试，而不是凭状态码降级", async () => {
    setProbe("unknown");
    const element = attachedImage(TWICE_ZHS);

    element.dispatchEvent(new Event("error"));
    await settle();

    // 502 是这类边缘最常见的「上游挂了」，它绝不能等同于「这张牌没中文图」。
    expect(element.getAttribute("src").startsWith(TWICE_ZHS)).toBe(true);
  });

  it("srcset 与 src 一起降级，保持两级一致", async () => {
    setProbe("missing");
    const element = attachedImage();
    element.setAttribute(
      "srcset",
      `https://images.mtgch.com/zhs/small/front/f/2/${ID}.webp 146w, ${ZHS} 488w`,
    );
    element.setAttribute("src", ZHS);

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(SF);
    expect(element.getAttribute("srcset")).toBe(
      `https://images.mtgch.com/sf/small/front/f/2/${ID}.webp 146w, ${SF} 488w`,
    );
  });

  it("英文图再失败 → 退到 Scryfall 兜底，仍不给应用 onError 机会", async () => {
    setProbe("missing");
    const element = attachedImage(LADDER_SF);
    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(LADDER_SCRYFALL);
    expect(appNotified).toBe(false);
  });

  it("中继地址：只换层级，不换寻址方式", async () => {
    // 应用的 WebGL/动画路径靠同源中继绕开那个重复的 CORS 头。把相对路径降级成
    // 绝对地址会把 CORS 又拉回来，本来能显示的图会变成没图。
    setProbe("missing");
    const element = attachedImage(RELAY_ZHS);

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(RELAY_SF);
  });

  it("Scryfall 兜底层再失败 → 放手交回应用，且不会被打回中文层", async () => {
    setProbe("missing");
    const element = attachedImage(LOOP_SF);
    element.dispatchEvent(new Event("error"));
    await settle();
    expect(element.getAttribute("src")).toBe(LOOP_SCRYFALL);

    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });
    element.dispatchEvent(new Event("error"));
    await settle();

    // 交回应用：它自己的降级链会接手（例如换成文字占位）。
    expect(appNotified).toBe(true);
    // 并且不能被打回中文层——那会变成 404 → 改写 → 404 的死循环。
    expect(element.getAttribute("src")).toBe(LOOP_SCRYFALL);
  });

  it("跨源图直接退到 Scryfall，寻址方式随之改变", async () => {
    // 兜底层永远是应用的原始形状（绝对地址、Scryfall 主机），因为「绝不比原版更差」
    // 指的就是「还回它原本要的那个 URL」。
    setProbe("missing");
    const element = attachedImage(
      `https://images.mtgch.com/sf/normal/front/a/4/${TWICE_ID}.webp`,
    );

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(
      `https://cards.scryfall.io/normal/front/a/4/${TWICE_ID}.jpg`,
    );
  });

  it("非图片元素上的 error 不受影响", () => {
    const element = document.createElement("div");
    document.body.append(element);
    let observed = false;
    element.addEventListener("error", () => {
      observed = true;
    });

    expect(() => element.dispatchEvent(new Event("error"))).not.toThrow();
    expect(observed).toBe(true);
  });

  it("重复装配被幂等闸挡下：一次加载失败只降一级", async () => {
    // 重复点击书签是常态。若装配不幂等，第二次会再挂一个 window 上的 error 监听
    // ——一次 404 被两个监听各降一级，中文图会直接跳过英文层掉到 Scryfall 兜底。
    // 这里把脚本再注入一次，验证阶梯仍然只走一步。
    setProbe("missing");
    vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js (第二次)" });

    const element = attachedImage(
      `https://images.mtgch.com/zhs/normal/front/a/4/${TWICE_ID}.webp`,
    );
    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(
      `https://images.mtgch.com/sf/normal/front/a/4/${TWICE_ID}.webp`,
    );
  });
});

describe("装配：crossOrigin 元素不做跨源改写", () => {
  it("跨源 Scryfall 地址原样放过（大学院废墟的重复 CORS 头会把它变成没图）", () => {
    const element = attachedImage();
    element.setAttribute("crossorigin", "anonymous");
    element.setAttribute("src", CORS_SCRYFALL);

    expect(element.getAttribute("src")).toBe(CORS_SCRYFALL);
  });

  it("同源中继地址照常改写（相对路径没有 CORS 检查）", () => {
    const element = attachedImage();
    element.setAttribute("crossorigin", "anonymous");
    element.setAttribute("src", CORS_RELAY_ZHS);

    // 中继层已经是中文层，所以这里断言的是「没有被动过」——关键是它不被当成
    // 跨源地址而放弃处理。真正要证明的是下面这条：中继地址在 crossOrigin 元素上
    // 仍然走完整的阶梯。
    expect(element.getAttribute("src")).toBe(CORS_RELAY_ZHS);
  });

  it("crossOrigin 元素上的中继地址仍然会降级", async () => {
    setProbe("missing");
    const element = attachedImage();
    element.setAttribute("crossorigin", "anonymous");
    element.setAttribute("src", CORS_RELAY_ZHS);

    element.dispatchEvent(new Event("error"));
    await settle();

    expect(element.getAttribute("src")).toBe(`/card-art/sf/normal/front/7/7/${CORS_ID}.webp`);
  });
});

describe("装配：异常绝不泄漏给页面", () => {
  /**
   * 为什么这组用例重要：phase.rs 在 `services/telemetryEvents.ts` 里监听了
   * `window` 的 `error` 与 `unhandledrejection`，把任何未捕获异常上报成 `js_error`。
   * 也就是说**我们代码里任何一处未接住的异常，在用户那里都表现为「游戏崩溃」**。
   * 所以「入口处全部接住」不是防御性编程的洁癖，是这个功能的正确性条件。
   */
  it("图片加载失败路径：拦截回调不把异常抛出去", async () => {
    const element = attachedImage(ZHS);
    setProbe("missing");
    let leaked = null;
    const onWindowError = (event) => { leaked = event.error ?? event.message; };
    window.addEventListener("error", onWindowError);
    try {
      element.dispatchEvent(new Event("error"));
      await settle();
    } catch (error) {
      leaked = error;
    } finally {
      window.removeEventListener("error", onWindowError);
    }
    expect(leaked).toBeNull();
  });

  it("非图片元素上的 error 事件：直接放过，不抛错", () => {
    const div = document.createElement("div");
    document.body.append(div);
    expect(() => div.dispatchEvent(new Event("error"))).not.toThrow();
  });

  it("阶段图标扫描在文档被清空时也不抛错", () => {
    document.body.innerHTML = "";
    expect(() => globalThis.__phaseZhPhaseIcons.scanPhaseIcons()).not.toThrow();
  });

  it("重复装配时的补扫描是安全的", () => {
    document.body.innerHTML = "";
    expect(() => vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" })).not.toThrow();
  });
});
