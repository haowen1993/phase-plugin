/**
 * 阶段图标替换的纯逻辑单测：图标数据的完整性、角标几何、绘制指令。
 *
 * 直接加载 `src/content.js` 本体（不复制一份实现），在 Node 里跑：脚本在没有 DOM
 * 时会跳过装配，只把纯函数挂到 `globalThis.__phaseZhPhaseIcons`。
 *
 *     node --test test/phase-icons.test.mjs
 *
 * 「认哪个阶段」这件事在这里测不了也不需要测——它依赖真实的 DOM 结构，归
 * `test/phase-icons.dom.mjs` 管。这里管的是另一半：12 个图标的数据是不是齐全、
 * 有没有互相串位，以及 patchIcon 往 SVG 上写的绘制指令对不对。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });

const {
  phases, iconSource, text, selector, viewBox, zoom, patchIcon, iconInner,
  originalSvgAttrs, isUnpatchedIcon,
} = globalThis.__phaseZhPhaseIcons;

/**
 * 与 phase.rs 源码里的顺序逐字对应：
 *   PhaseStopBar.tsx 的 LEFT_PHASES / RIGHT_PHASES / COMBAT_PHASES
 *   MobilePhaseChip.tsx 的 ALL_PHASES
 * 这份顺序本身就是识别依据（按序号定阶段），所以它错了整套都会错。
 */
const EXPECTED_PHASES = [
  "Untap", "Upkeep", "Draw", "PreCombatMain",
  "BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat",
  "PostCombatMain", "End", "Cleanup",
];

/** 一个够用的 SVG 替身：只需要 attributes / setAttribute / innerHTML / querySelector。 */
function fakeSvg(attrs = {}) {
  const map = new Map(Object.entries(attrs));
  return {
    innerHTML: "",
    attributes: Array.from(map, ([name, value]) => ({ name, value })),
    getAttribute: (name) => (map.has(name) ? map.get(name) : null),
    hasAttribute: (name) => map.has(name),
    setAttribute(name, value) { map.set(name, String(value)); },
  };
}

test("阶段顺序与 phase.rs 源码一致", () => {
  assert.deepEqual(phases, EXPECTED_PHASES);
});

test("12 个阶段都有文案与描述（多一个少一个都会让交叉校验失准）", () => {
  for (const phase of EXPECTED_PHASES) {
    assert.equal(typeof text[phase], "string", `${phase} 缺少描述文案`);
    assert.ok(text[phase].length > 0, `${phase} 的描述文案是空的`);
    assert.ok(text[phase].endsWith("。"), `${phase} 的描述文案应以句号结尾：${text[phase]}`);
  }
  assert.equal(Object.keys(text).length, EXPECTED_PHASES.length);
});

test("12 个阶段都有图标出处，且只来自 Lucide 与 Tabler", () => {
  for (const phase of EXPECTED_PHASES) {
    const source = iconSource[phase];
    assert.ok(source, `${phase} 缺少图标出处`);
    assert.match(source, /^(lucide|tabler)\/.+/, `${phase} 的出处不是这两个库：${source}`);
  }
  assert.equal(Object.keys(iconSource).length, EXPECTED_PHASES.length);
});

test("两个主阶段不再共用图形——这正是这次要修的原版问题", () => {
  // 原版 phase.rs 里 PreCombatMain 与 PostCombatMain 是两段一模一样的 JSX（同一个
  // 菱形），玩家分不出哪个是哪个。现在是一对方框带数字的图标，出处也必须不同。
  assert.notEqual(
    iconSource.PreCombatMain,
    iconSource.PostCombatMain,
    "两个主阶段必须用不同的图标，否则又回到「两个阶段长得一样」",
  );
});

test("两个主阶段用 Tabler 现成的「方框带数字」图标，不再是特例", () => {
  // 这两条是这次改动的核心：主阶段**不再**手绘字形，而是图标库里现成的一对。
  assert.equal(iconSource.PreCombatMain, "tabler/square-number-1");
  assert.equal(iconSource.PostCombatMain, "tabler/square-number-2");
  // 出处必须与第二个库（Tabler）一致，且都不是 target 了
  for (const phase of ["PreCombatMain", "PostCombatMain"]) {
    assert.match(iconSource[phase], /^tabler\//, `${phase} 应当来自 Tabler`);
    assert.ok(!iconSource[phase].includes("target"), `${phase} 不该再用 target`);
  }
});

test("两个主阶段的图形不同，且都带方框与数字笔画", () => {
  const pre = fakeSvg({ viewBox: viewBox });
  const post = fakeSvg({ viewBox: viewBox });
  patchIcon(pre, "PreCombatMain");
  patchIcon(post, "PostCombatMain");
  assert.notEqual(pre.innerHTML, post.innerHTML, "M1 与 M2 必须是两个不同的图形");
  for (const [name, svg] of [["M1", pre], ["M2", post]]) {
    // 方框那一笔是两者共有的
    assert.ok(svg.innerHTML.includes("M3 5a2 2 0 0 1 2 -2h14"), `${name} 缺少方框`);
    // 数字笔画：1 是一竖带撇，2 是两段圆弧
    assert.ok(svg.innerHTML.includes(name === "M1" ? "M10 10l2 -2v8" : "M10 8h3a1 1 0 0 1 1 1v2"), `${name} 缺少数字`);
  }
});

test("主阶段和其他图标一样套 1.15 倍放大（不是特例）", () => {
  for (const phase of ["PreCombatMain", "PostCombatMain", "Draw", "Upkeep"]) {
    const svg = fakeSvg({ viewBox: viewBox });
    patchIcon(svg, phase);
    assert.ok(svg.innerHTML.includes(`translate(12 12) scale(${zoom}) translate(-12 -12)`),
      `${phase} 应当套同一层放大`);
  }
});

test("方框放到 1.15 倍之后仍落在画布内", () => {
  // 方框的原始范围是 3..21；放大 1.15 绕 (12,12) 之后是 1.8..22.2。
  const lo = 12 - (12 - 3) * zoom;
  const hi = 12 + (21 - 12) * zoom;
  assert.ok(lo > 0 && hi < 24, `方框放大后超出画布：${lo.toFixed(1)}..${hi.toFixed(1)}`);
});

test("绘制指令：viewBox 换成 24 网格、走描边式、保留尺寸类", () => {
  const svg = fakeSvg({ viewBox: viewBox, class: "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5", fill: "currentColor" });
  patchIcon(svg, "Draw");
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(svg.getAttribute("fill"), "none");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  assert.equal(svg.getAttribute("stroke-width"), "2");
  assert.equal(svg.getAttribute("stroke-linecap"), "round");
  assert.equal(svg.getAttribute("stroke-linejoin"), "round");
  // 尺寸类一个字都不能动：响应式断点与「激活变白」都靠它
  assert.equal(svg.getAttribute("class"), "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5");
});

test("绘制指令：12 个阶段一视同仁地放大 1.15 倍，绕画布中心", () => {
  for (const phase of phases) {
    const svg = fakeSvg({ viewBox: viewBox });
    patchIcon(svg, phase);
    // 绕 (12,12) 缩放：图标库的内容本来就以这里为中心，不绕中心放大会把图形挤出画布
    assert.ok(
      svg.innerHTML.includes(`translate(12 12) scale(${zoom}) translate(-12 -12)`),
      `${phase} 应当套同一层放大`,
    );
  }

  // 画布尺寸没变——改的是内容，不是 viewBox。收窄 viewBox 会矩形裁切，
  // 把贴到裁切线上的图形切掉（实测过），所以那条路走不通。
  const svg = fakeSvg({ viewBox: viewBox });
  patchIcon(svg, "Draw");
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
});

// 说明：「放大后会不会被裁」这条**不在这里测**。
//
// 试过用纯逻辑测：解析路径坐标、把每个点绕中心放大、再判是否越界。做了三版都不可靠，
// 而且不可靠的方向是「假绿」——把图形改到画布外，测试照样通过：
//   1. 只认大写 M/L：漏掉小写 v/h，flag-3 的竖杆拉到 y=30 也发现不了；
//   2. 补上相对命令：`M8 6h.01` 这类相对小点会被当成绝对坐标，误报「抓牌跑到画布外」；
//   3. 按时序追踪当前点：Lucide 的齿轮图标里有**隐式重复**的圆弧命令
//      （`a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915` 是两段），
//      按「末两个数是终点」取会参数错位，又误报一次。
//
// 更根本的是：**圆弧与贝塞尔曲线会鼓到端点之外**，所以「端点都在画布内」根本推不出
// 「图形没被裁」。这是方法论问题，不是解析器写得不够好。
//
// 真值只能靠实际渲染。见 `tools/check-icon-clipping.mjs`：它把 12 个图标按真实变换画在
// 放大的画布上，直接看有没有笔画触到边缘。

test("每个阶段的绘制结果都非空，且确实来自图标库", () => {
  for (const phase of EXPECTED_PHASES) {
    const svg = fakeSvg({ viewBox: viewBox });
    patchIcon(svg, phase);
    assert.ok(svg.innerHTML.length > 20, `${phase} 画出来是空的`);
    // 图标库的图元都是 path / circle / rect，不该出现别的形状
    assert.match(svg.innerHTML, /<(path|circle|rect|line|polyline|polygon|g)\b/, `${phase} 没有可用图元`);
  }
});

test("属性快照只保留 class 与 viewBox", () => {
  // 这里必须写死 14×14：`viewBox` 常量是**替换后**的目标值（24 网格），
  // 拿它去造「原版图标」会造出一个本来就不该被识别的元素。
  const svg = fakeSvg({
    class: "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5",
    viewBox: "0 0 14 14",
    fill: "currentColor",
    stroke: "currentColor",
    "stroke-width": "1.2",
    "aria-hidden": "true",
  });
  // 快照要在 patchIcon **之前**取：它读的是当时那棵树上的属性，patchIcon 会改掉
  // 同一个对象（也正因如此，测试里不能拿 patchIcon 的结果去反推原属性）。
  assert.deepEqual(originalSvgAttrs(svg), {
    class: "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5",
    viewBox: "0 0 14 14",
  });
  assert.equal(svg.getAttribute("fill"), "currentColor", "取快照不该改动元素");
});

test("定位选择器就是原版图标的唯一特征", () => {
  assert.equal(selector, 'svg[viewBox="0 0 14 14"]');
  // 实测：这个 viewBox 在 phase.rs 全代码库里只出现在 PhaseStopBar.tsx，共 12 处
  assert.equal(viewBox, "0 0 24 24", "替换后的 viewBox 是图标库的 24 网格");
});

test("未处理的判据：viewBox 与原版一致且没有自己的标记", () => {
  // 这里只测纯逻辑分支，所以用替身；真实 DOM 上的行为归 DOM 装配测试管。
  const likeOriginal = { getAttribute: (n) => (n === "viewBox" ? "0 0 14 14" : null), hasAttribute: () => false };
  const alreadyDone = { getAttribute: (n) => (n === "viewBox" ? "0 0 14 14" : null), hasAttribute: (n) => n === "data-prz" };
  const wrongBox = { getAttribute: (n) => (n === "viewBox" ? "0 0 24 24" : null), hasAttribute: () => false };

  // 这三个都过不了 `node instanceof SVGElement`——在 Node 里没有 SVGElement，
  // 所以 isUnpatchedIcon 应当一律返回 false，而不是抛错。这正是它能在
  // 无 DOM 环境里被安全加载的原因。
  assert.equal(isUnpatchedIcon(likeOriginal), false);
  assert.equal(isUnpatchedIcon(alreadyDone), false);
  assert.equal(isUnpatchedIcon(wrongBox), false);
  assert.equal(isUnpatchedIcon(null), false);
  assert.equal(isUnpatchedIcon(undefined), false);
});
