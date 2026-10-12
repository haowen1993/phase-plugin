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
  phases, iconSource, text, badge, selector, viewBox, zoom,
  badgeMarkup, monogramGlyph, patchIcon,
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

test("只有两个主阶段是 M1 / M2 字形，其余阶段照旧用图标库的图形", () => {
  assert.deepEqual(Object.keys(badge).sort(), ["PostCombatMain", "PreCombatMain"]);
  assert.equal(badge.PreCombatMain, "1");
  assert.equal(badge.PostCombatMain, "2");
});

test("M1/M2 字形：没有方框，占满画布、居中、端点不出画布", () => {
  const [vbW, vbH] = viewBox.split(" ").map(Number).slice(2);
  assert.equal(vbW, 24, "图标库统一 24 网格，字形坐标是按它算的");

  // 这是**整个图标**：不带方框，直接是两个字。前两版都不对——先是「圆 + 数字」，
  // 后是「target 同心圆 + 角上挂一个小标签」，后者既让两个主阶段看起来仍是同一个
  // 图案，也在 10px 里塞不下。现在没有别的图形要避让，字就该画大。
  assert.ok(!badgeMarkup("1").includes("<rect"), "不该再有方框");
  assert.ok(!badgeMarkup("1").includes("<circle"), "不该再有圆形");

  const bounds = { x1: 0, x2: vbW, y1: 0, y2: vbH };
  const inBox = (px, py) => px > bounds.x1 && px < bounds.x2 && py > bounds.y1 && py < bounds.y2;

  /** 把 path 拆成 [命令字母, 数字数组] 列表（处理紧贴小数的合并）。 */
  function tokenizePath(d) {
    const parts = d.match(/\s*([A-Za-z]|-?[0-9]*\.?[0-9]+)/g) ?? [];
    const merged = [];
    for (const part of parts) {
      const spaced = /^\s/.test(part);
      const token = part.trim();
      const previous = merged[merged.length - 1];
      const glues = !spaced && token.startsWith(".") && previous !== undefined
        && !previous.spaced && !/[A-Za-z]/.test(previous.token);
      if (glues) previous.token += token;
      else merged.push({ token, spaced });
    }
    const out = [];
    let command = null;
    let buffer = [];
    for (const { token } of merged) {
      if (/[A-Za-z]/.test(token)) {
        if (command !== null) out.push([command, buffer]);
        command = token;
        buffer = [];
      } else {
        buffer.push(Number(token));
      }
    }
    if (command !== null) out.push([command, buffer]);
    return out;
  }

  /** 按 SVG 语义走一遍路径，返回每段的 [起点, 终点]（绝对坐标）。 */
  function segments(d) {
    const result = [];
    let cx = 0;
    let cy = 0;
    for (const [rawCommand, n] of tokenizePath(d)) {
      const relative = rawCommand === rawCommand.toLowerCase();
      const command = rawCommand.toUpperCase();
      const move = (x, y) => {
        const ax = relative ? cx + x : x;
        const ay = relative ? cy + y : y;
        result.push([[cx, cy], [ax, ay]]);
        cx = ax;
        cy = ay;
      };
      if (command === "M" || command === "L") {
        for (let i = 0; i + 1 < n.length; i += 2) move(n[i], n[i + 1]);
      } else if (command === "A") {
        // 参数顺序：rx ry 旋转 large-arc sweep x y —— 只有末两个是终点
        move(n[n.length - 2], n[n.length - 1]);
      } else if (command === "C") {
        for (let i = 0; i + 5 < n.length; i += 6) move(n[i + 4], n[i + 5]);
      } else if (command === "H") {
        // 水平线只有 x 一个参数。**绝对**（大写 H）时 y 保持当前值，相对（小写 h）
        // 时才在原地叠加——写成 move(value, 0) 会让大写 H 把 y 拖回 0。
        for (const value of n) {
          if (relative) move(value, 0);
          else move(value, cy);
        }
      } else if (command === "V") {
        // 同上，垂直线只有 y 一个参数。
        for (const value of n) {
          if (relative) move(0, value);
          else move(cx, value);
        }
      }
    }
    return result;
  }

  for (const [name, d] of Object.entries(monogramGlyph)) {
    const list = segments(d);
    assert.ok(list.length > 0, `${name} 的路径解析不出任何线段`);
    for (const [[sx, sy], [ex, ey]] of list) {
      // 每条线段的**终点**都是真正的笔画端点，必须在框里。
      assert.ok(inBox(ex, ey), `${name}: 线段终点 (${ex}, ${ey}) 超出画布`);
      // 起点只有画出来的那部分才算数：路径开头那个 `M` 是「把笔挪过去」，它从
      // (0,0) 起跳，那不是笔画。
      if (!(sx === 0 && sy === 0)) {
        assert.ok(inBox(sx, sy), `${name}: 线段起点 (${sx}, ${sy}) 超出画布`);
      }
    }
  }
});

test("M1/M2 的字用描边画，不依赖字体，且不带任何外框", () => {
  for (const digit of ["1", "2"]) {
    const markup = badgeMarkup(digit);
    assert.ok(!markup.includes("<rect"), `${digit} 不该有方框`);
    assert.ok(!markup.includes("<circle"), `${digit} 不该有圆形`);
    assert.ok(markup.includes("<path"), `${digit} 的字应当是路径而不是 <text>`);
    assert.ok(!markup.includes("<text"), `${digit} 不应依赖字体渲染`);
    // 描边式而不是实心底：另外 10 个图标都是描边式，实心块会格格不入
    assert.ok(!markup.includes('fill="currentColor"'), `${digit} 不该是实心底`);
    assert.ok(markup.includes(monogramGlyph.M), `${digit} 缺少 M 的笔画`);
    assert.ok(markup.includes(monogramGlyph[digit]), `${digit} 缺少数字的笔画`);
  }
  assert.notEqual(badgeMarkup("1"), badgeMarkup("2"), "M1 和 M2 必须是两个不同的形状");
});

test("字形是三组笔画：M、1、2", () => {
  assert.ok(monogramGlyph.M.length > 0);
  // 单看一个「1」读者不知道它指什么；M1/M2 是万智牌玩家的通用说法
  assert.equal(Object.keys(monogramGlyph).sort().join(","), "1,2,M");
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

test("绘制指令：非主阶段图标放大 1.15 倍，且放大是绕画布中心做的", () => {
  const svg = fakeSvg({ viewBox: viewBox });
  patchIcon(svg, "Upkeep");
  assert.ok(zoom > 1 && zoom < 1.3, `放大系数应当在合理区间：${zoom}`);
  // 绕 (12,12) 缩放：图标库的内容本来就以这里为中心，不绕中心放大会把图形挤出画布
  assert.ok(
    svg.innerHTML.includes(`translate(12 12) scale(${zoom}) translate(-12 -12)`),
    "内容应当绕画布中心放大",
  );

  // 主阶段整块是字形，坐标已按 24 网格画满，不再需要放大
  const main = fakeSvg({ viewBox: viewBox });
  patchIcon(main, "PreCombatMain");
  assert.ok(!main.innerHTML.includes("scale("), "M1/M2 不该再套一层放大");

  // 画布尺寸没变——改的是内容，不是 viewBox。收窄 viewBox 会矩形裁切，
  // 把圆形图标的两端切掉（实测过），所以那条路走不通。
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
});

test("绘制指令：只有主阶段画角标", () => {
  const MARK = monogramGlyph.M; // M 的笔画，够独特
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
