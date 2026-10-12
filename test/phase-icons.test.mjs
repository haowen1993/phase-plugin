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
  phases, iconSource, text, badge, selector, viewBox, scale,
  badgeMarkup, badgeBox, badgeLabel, badgeRadius, patchIcon,
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

test("共用同一个图形的阶段，出处也必须一致", () => {
  // 两个主阶段共用 target，只靠角标区分；出处不一致说明数据串位了。
  assert.equal(iconSource.PreCombatMain, iconSource.PostCombatMain);
  assert.equal(iconSource.PreCombatMain, "tabler/target");
});

test("两个主阶段都带角标，其余阶段一个都不带", () => {
  assert.deepEqual(Object.keys(badge).sort(), ["PostCombatMain", "PreCombatMain"]);
  assert.equal(badge.PreCombatMain, "1");
  assert.equal(badge.PostCombatMain, "2");
});

test("角标几何：贴在右上角，且足够宽写下两个字符", () => {
  const { x, y, w, h } = badgeBox;
  const [vbW] = viewBox.split(" ").map(Number).slice(2);
  assert.equal(vbW, 24, "图标库统一 24 网格，角标坐标是按它算的");
  // 角标允许溢出 viewBox（SVG 默认不裁剪），但必须落在右上角
  assert.ok(x > vbW / 2, "角标必须在画布右半部");
  assert.ok(y + h / 2 < vbW / 2, "角标必须在画布上半部");
  // 最早是圆 + 单个数字，圆里塞不下「M1」两个字符，才改成圆角矩形。
  // 这条断言守住那个结论：宽度必须够两个字符站。
  assert.ok(w >= 8, `角标太窄，写不下两个字符：${w}`);
  assert.ok(h >= 5, `角标太矮：${h}`);
  assert.ok(badgeRadius < h / 2, "圆角半径不该把矩形变成胶囊");
});

test("角标的文字用描边画，不依赖字体", () => {
  for (const digit of ["1", "2"]) {
    const markup = badgeMarkup(digit);
    assert.ok(markup.includes("<rect"), `${digit} 缺少底色矩形`);
    assert.ok(markup.includes('fill="currentColor"'), `${digit} 的底色应跟随主题色`);
    assert.ok(markup.includes("<path"), `${digit} 的文字应当是路径而不是 <text>`);
    assert.ok(!markup.includes("<text"), `${digit} 不应依赖字体渲染`);
    assert.ok(markup.includes('stroke="#0f172a"'), `${digit} 的文字应当是反色`);
    // 两个字符：M 加一个数字
    assert.ok(markup.includes(badgeLabel.M), `${digit} 缺少 M 的笔画`);
    assert.ok(markup.includes(badgeLabel[digit]), `${digit} 缺少数字的笔画`);
  }
  assert.notEqual(badgeMarkup("1"), badgeMarkup("2"), "M1 和 M2 必须是两个不同的形状");
});

test("角标文字是 M1 / M2，不是光秃秃的数字", () => {
  assert.equal(badgeLabel.M.length > 0, true);
  // 单看一个「1」读者不知道它指什么；M1/M2 是万智牌玩家的通用说法
  assert.equal(Object.keys(badgeLabel).sort().join(","), "1,2,M");
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

test("绘制指令：图标内容整体缩放，角标占据右上角", () => {
  const svg = fakeSvg({ viewBox: viewBox });
  patchIcon(svg, "Upkeep");
  assert.ok(scale > 0.7 && scale < 1.3, `缩放系数应当在合理区间：${scale}`);
  assert.ok(svg.innerHTML.includes(`scale(${scale})`), "内容应当被包在缩放组里");
  assert.ok(svg.innerHTML.includes('transform-origin="12 12"'), "缩放应当以画布中心为原点");

  // 角标与圆形图案有一小块重叠是**设计如此、也是无奈**：图标本身只有 10px，要在
  // 右上角写下「M1」两个字符，24 网格里放不下「两者不碰」。实测这个重叠视觉上可接受
  // ——角标压在 target 外圈的外侧一小块，同心圆仍认得出。所以这里不加「不许重叠」
  // 的断言（那是几何上做不到的），只守真正的约束：
  //   1. 不出画布上方与右侧      → 否则会被按钮裁掉
  //   2. 确实在右上角            → 右上角才能和正上方的激活条、正下方的停止点错开
  const [vbW, vbH] = viewBox.split(" ").map(Number).slice(2);
  assert.ok(badgeBox.y >= 0, `角标上边缘出画布：${badgeBox.y}`);
  assert.ok(badgeBox.x + badgeBox.w <= vbW + 1, `角标右侧超出太多：${badgeBox.x + badgeBox.w}`);
  assert.ok(badgeBox.x > vbW / 2 && badgeBox.y + badgeBox.h < vbH / 2, "角标必须在右上角");
});

test("绘制指令：只有主阶段画角标", () => {
  const MARK = `x="${badgeBox.x}"`; // 角标底矩形的起点，够独特
  const main = fakeSvg({ viewBox: viewBox });
  patchIcon(main, "PreCombatMain");
  assert.ok(main.innerHTML.includes(MARK), "主阶段应当带角标");

  const other = fakeSvg({ viewBox: viewBox });
  patchIcon(other, "Draw");
  assert.ok(!other.innerHTML.includes(MARK), "非主阶段不该带角标");
});

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
