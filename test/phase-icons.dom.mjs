/**
 * 阶段图标替换的装配测试：把 `src/content.js` 真的跑起来，验证它在真实形状的
 * DOM 上认得出阶段、换得对图标，并且在 React 重渲染的两种行为下都活下来。
 *
 * 为什么这层测试必须存在：图标识别靠的是**容器结构**（源码里写死的阶段顺序），
 * 而结构判据在纯函数单测里没法验证——它要真的有一棵 button / 容器 / svg 组成的
 * 树。而最容易出错的一处（两个主阶段共用同一个菱形）恰恰只有结构判据能分辨。
 *
 * 三个写法上的硬约束：
 *   1. 元素必须挂到 document 上。MutationObserver 观察的是 documentElement 子树，
 *      游离节点不会被观察到。
 *   2. 用 vm.runInThisContext 而不是 import：脚本是 classic script，且每次注入都要
 *      走一遍它自己的装配逻辑。
 *   3. 这里的 DOM 形状必须与 phase.rs 的 PhaseStopBar.tsx / MobilePhaseChip.tsx
 *      保持一致（button 的 aria-label、容器的 data-* 属性、每组几个图标）。上游
 *      改了形状，这套测试就该跟着红——那是它存在的意义。
 *
 * 运行需要 vitest + happy-dom：`npm install && npm run test:dom`。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "content.js"), "utf8");

/** 十二个阶段，顺序与 phase.rs 源码一致。 */
const PHASES = [
  "Untap", "Upkeep", "Draw", "PreCombatMain",
  "BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat",
  "PostCombatMain", "End", "Cleanup",
];

/** 与原版一致的最小图标：14×14、填充式。各组形状不同是为了让结构判据真的被考验。 */
const ORIGINAL_ICON = {
  // 重置：一个 8 半径的圆——手机端操作行靠它认出「组内第一个是重置」
  Untap: '<circle cx="7" cy="7" r="8"/>',
  // 两个主阶段共用同一个菱形，这正是只靠内容分不开的那一组
  PreCombatMain: '<path d="M7 1L12 7L7 13L2 7Z"/>',
  PostCombatMain: '<path d="M7 1L12 7L7 13L2 7Z"/>',
  // 战斗伤害带一个 circle，交叉双剑不带——这是 `:has(circle)` 之外的另一条线索
  CombatDamage: '<path d="M3 2l8 8" stroke="currentColor" fill="none"/><circle cx="7" cy="7" r="1.5"/>',
  BeginCombat: '<path d="M3 2l8 8" stroke="currentColor" fill="none"/>',
};

function originalIconMarkup(phase) {
  return ORIGINAL_ICON[phase] ?? '<rect x="3" y="2" width="8" height="10" rx="1"/>';
}

/** i18n 里每个阶段的描述文案，用来拼出与真实 aria-label 相同的尾巴。 */
const PHASE_DESCRIPTION = {
  Untap: "你的已横置永久物在此竖置。",
  Upkeep: "维持触发式异能与周期性费用在此发生。",
  Draw: "你在此抓本回合的牌。",
  PreCombatMain: "在战斗前使用地并施放咒语。",
  BeginCombat: "选择攻击者之前的最后一个优先权窗口。",
  DeclareAttackers: "由攻击牌手选择攻击者。",
  DeclareBlockers: "由防御牌手选择阻挡者。",
  CombatDamage: "生物分配并造成战斗伤害。",
  EndCombat: "造成伤害后的最后一个优先权窗口。",
  PostCombatMain: "在战斗后使用地或施放咒语。",
  End: "结束步骤的触发式异能与回合结束时的行动在此发生。",
  Cleanup: "伤害消失，并检查手牌上限。",
};

/**
 * 建一个 PhaseDot：结构与 PhaseStopBar.tsx 一致。
 * `active` 时多一个激活条 span——它必须在替换后仍然存在。
 */
function phaseDot(phase, { active = false, stop = false, label } = {}) {
  const button = document.createElement("button");
  button.setAttribute("type", "button");
  button.setAttribute("aria-label", label ?? `阶段停止：${phase}步骤。${PHASE_DESCRIPTION[phase]} 未设置停止：点击可在此暂停自动让过。`);
  button.setAttribute("aria-describedby", `tip-${phase}`);
  if (active) {
    const bar = document.createElement("span");
    bar.className = "active-bar";
    button.append(bar);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("class", "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5");
  svg.setAttribute("fill", "currentColor");
  svg.innerHTML = originalIconMarkup(phase);
  button.append(svg);
  if (stop) {
    const dot = document.createElement("span");
    dot.className = "stop-dot";
    button.append(dot);
  }
  return button;
}

/** 装一个「一排按钮」的容器（PhaseIndicatorLeft / Right / CombatPhaseIndicator）。 */
function strip(phases, options = {}) {
  const container = document.createElement("div");
  if (options.combat) container.setAttribute("data-combat-phase-indicator", "");
  for (const phase of phases) container.append(phaseDot(phase, options));
  return container;
}

/** 玩家 HUD：左右两组都在 [data-player-hud] 里。 */
function playerHud() {
  const hud = document.createElement("div");
  hud.setAttribute("data-player-hud", "p1");
  hud.append(strip(["Upkeep", "Draw", "PreCombatMain"]));
  hud.append(strip(["PostCombatMain", "End"]));
  return hud;
}

/** 手机端操作行：chip + 12 个按钮行，两者在同一个祖先容器里。 */
function mobileActions() {
  const host = document.createElement("div");
  const chip = document.createElement("button");
  chip.setAttribute("aria-label", "当前阶段：重置步骤。打开阶段停止设置。");
  const chipSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chipSvg.setAttribute("viewBox", "0 0 14 14");
  chipSvg.innerHTML = originalIconMarkup("Untap");
  chip.append(chipSvg);
  host.append(chip);

  const row = document.createElement("div");
  row.setAttribute("data-mobile-action-right", "");
  for (const phase of PHASES) row.append(phaseDot(phase));
  host.append(row);
  return host;
}

/** 阶段停止抽屉：role="dialog" 里 12 个按钮。 */
function phaseSheet() {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const list = document.createElement("ul");
  for (const phase of PHASES) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.setAttribute("type", "button");
    const span = document.createElement("span");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.innerHTML = originalIconMarkup(phase);
    span.append(svg);
    button.append(span);
    li.append(button);
    list.append(li);
  }
  dialog.append(list);
  return dialog;
}

const icons = () => globalThis.__phaseZhPhaseIcons;

/**
 * 清空并装入一棵新树。
 *
 * 清理必须覆盖 documentElement 而不只是 body：识别依赖「容器里有几个图标」，
 * 而 `groupContainer` 是从 button 往上找的。上一个用例遗留在 body 之外的标记节点
 * 会让「往上找」找到一整份文档的图标，把一个不认识的容器误认成某一组。
 */
function mount(...nodes) {
  for (const child of Array.from(document.body.children)) child.remove();
  document.body.innerHTML = "";
  for (const node of nodes) document.body.append(node);
  return document.body;
}

/** 该阶段当前的标记（未替换则为 null）。 */
function markOf(phase) {
  return document.querySelector(`svg[data-prz="${phase}"]`);
}

/** 某个阶段对应 button 里的 svg。 */
function iconOf(phase) {
  return markOf(phase);
}

beforeAll(() => {
  vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" });
});

/** 每个用例前彻底清场：图标识别依赖组内数量，残留节点会串味。 */
beforeEach(() => {
  document.body.innerHTML = "";
});

describe("阶段图标：识别每一个阶段", () => {
  it("玩家 HUD 的左右两条：3 个一组与 2 个一组，靠组内数量区分", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    for (const phase of ["Upkeep", "Draw", "PreCombatMain", "PostCombatMain", "End"]) {
      expect(iconOf(phase), phase).not.toBeNull();
    }
  });

  it("两个主阶段用同一个菱形，仍然各自认对（这是只靠内容做不到的一步）", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const pre = iconOf("PreCombatMain");
    const post = iconOf("PostCombatMain");
    expect(pre).not.toBeNull();
    expect(post).not.toBeNull();
    // 原版两段 JSX 一模一样，所以替换前的 innerHTML 必须相同——否则这个用例
    // 就没有在考验结构判据。
    expect(pre.dataset.prz).not.toBe(post.dataset.prz);
    // 第一主阶段在左组，第二主阶段在右组
    expect(pre.closest("[data-player-hud]")).not.toBeNull();
    expect(post.closest("[data-player-hud]")).not.toBeNull();
  });

  it("战斗条：源码顺序写死，5 个步骤依次认对", () => {
    mount(strip(["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"], { combat: true }));
    icons().scanPhaseIcons();
    for (const phase of ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"]) {
      expect(iconOf(phase), phase).not.toBeNull();
    }
  });

  it("战斗伤害与战斗开始的原版图形不同，但仍按位置认对", () => {
    mount(strip(["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"], { combat: true }));
    icons().scanPhaseIcons();
    expect(iconOf("CombatDamage")).not.toBeNull();
    expect(iconOf("BeginCombat")).not.toBeNull();
  });

  it("手机端操作行：chip 与 12 个按钮行在同一个容器里，靠 8 半径的圆认出重置", () => {
    mount(mobileActions());
    icons().scanPhaseIcons();
    for (const phase of PHASES) {
      expect(iconOf(phase), phase).not.toBeNull();
    }
  });

  it("阶段停止抽屉：role=dialog 里的 12 个按钮按顺序认对", () => {
    mount(phaseSheet());
    icons().scanPhaseIcons();
    for (const phase of PHASES) {
      expect(iconOf(phase), phase).not.toBeNull();
    }
  });

  it("五种容器同时存在时互不串味", () => {
    mount(playerHud(), strip(["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"], { combat: true }), mobileActions());
    icons().scanPhaseIcons();
    for (const phase of PHASES) {
      expect(iconOf(phase), phase).not.toBeNull();
    }
    // 每个阶段只应有一个标记（chip 与重置按钮会各有一个 Untap 图标）
    expect(document.querySelectorAll('svg[data-prz="Untap"]').length).toBeGreaterThanOrEqual(1);
  });
});

describe("阶段图标：替换本身", () => {
  it("替换后 viewBox 变成 24 网格，并带上描边式图标的属性", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const svg = iconOf("Draw");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
  });

  it("尺寸类被保留——响应式与激活变色都靠它", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    expect(iconOf("Draw").getAttribute("class")).toBe("h-2.5 w-2.5 lg:h-3.5 lg:w-3.5");
  });

  it("主阶段带角标，其余阶段不带", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    // 主阶段整块就是字形：圆角矩形 + 「M1 / M2」，没有 target
    const { x } = icons().monogramBox;
    expect(iconOf("PreCombatMain").innerHTML).toContain(`<rect x="${x}"`);
    expect(iconOf("PostCombatMain").innerHTML).toContain(`<rect x="${x}"`);
    expect(iconOf("Draw").innerHTML).not.toContain(`<rect x="${x}"`);
    // 两个字符的写法：M1 与 M2 必须不同
    expect(iconOf("PreCombatMain").innerHTML).not.toBe(iconOf("PostCombatMain").innerHTML);
  });

  it("十个非主阶段图标走缩放，M1/M2 不套缩放", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    expect(iconOf("Draw").innerHTML).toContain(`scale(${icons().scale})`);
    // 主阶段整块就是字形，坐标本来就按 24 网格算，不需要再缩放
    expect(iconOf("PreCombatMain").innerHTML).not.toContain("scale(");
  });

  it("兄弟节点没被动过：激活条与停止点都还在", () => {
    const hud = document.createElement("div");
    hud.setAttribute("data-player-hud", "p1");
    hud.append(strip(["Upkeep", "Draw", "PreCombatMain"], { active: true, stop: true }));
    const right = strip(["PostCombatMain"], {});
    hud.append(right);
    mount(hud);
    icons().scanPhaseIcons();
    expect(document.querySelectorAll("span.active-bar").length).toBe(3);
    expect(document.querySelectorAll("span.stop-dot").length).toBe(3);
  });
});

describe("阶段图标：幂等与重渲染", () => {
  it("重复扫描不会重复处理：标记就是闸门", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const before = iconOf("Draw").innerHTML;
    icons().scanPhaseIcons();
    icons().scanPhaseIcons();
    expect(iconOf("Draw").innerHTML).toBe(before);
  });

  it("已被标记的图标不会再被认第二次", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const svg = iconOf("Draw");
    expect(icons().isUnpatchedIcon(svg)).toBe(false);
    // 再跑一次整轮扫描，已标记的不该进入候选
    expect(icons().resolvePhases([svg]).size).toBe(0);
  });

  it("React 只改 button 的 class 时，替换结果不受影响", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const button = iconOf("Draw").closest("button");
    const before = iconOf("Draw").innerHTML;
    // React 更新 button 的 className 时写的是 class 属性，不碰子节点
    button.setAttribute("class", "group relative flex h-6 w-6 border-cyan-300/45 bg-cyan-950/82 text-white");
    expect(iconOf("Draw").innerHTML).toBe(before);
    expect(iconOf("Draw").getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("React 换掉整个 svg 节点时，MutationObserver 会补上", async () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const old = iconOf("Draw");
    const button = old.closest("button");
    // 模拟组件卸载重建：原节点被移除，新的原版图标进来
    const fresh = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    fresh.setAttribute("viewBox", "0 0 14 14");
    fresh.setAttribute("class", "h-2.5 w-2.5 lg:h-3.5 lg:w-3.5");
    fresh.innerHTML = originalIconMarkup("Draw");
    old.replaceWith(fresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fresh.getAttribute("data-prz")).toBe("Draw");
    expect(fresh.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("新挂进来的容器整棵消失再回来，图标仍会被补上", async () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    const right = document.querySelector('svg[data-prz="PostCombatMain"]').closest("div");
    right.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('svg[data-prz="PostCombatMain"]')).toBeNull();
    document.body.append(strip(["PostCombatMain", "End"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iconOf("PostCombatMain")).not.toBeNull();
  });

  it("重复装配被幂等闸挡下，但补扫描照常生效", () => {
    mount(playerHud());
    icons().scanPhaseIcons();
    // 再跑一次脚本本体：install() 会走「已装配」分支，只补扫描
    vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" });
    expect(iconOf("Draw")).not.toBeNull();
  });
});

describe("阶段图标：认不出来时的行为", () => {
  it("不认识的容器一律放过，不猜", () => {
    // 刻意用 4 个**平凡**图标：既不是 2 个一组、也不是 3 个或 12 个，任何一条结构
    // 判据都不该命中。这里不能用 originalIconMarkup——它给「重置」放的是真实的
    // 8 半径圆，而那正是手机操作行用来认第一个图标的锚点，会（正确地）被认出来，
    // 于是这个用例就不再是在考验「不认识的容器」了。
    const host = document.createElement("div");
    for (let i = 0; i < 4; i += 1) {
      const button = document.createElement("button");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 14 14");
      svg.innerHTML = '<rect x="3" y="2" width="8" height="10" rx="1"/>';
      button.append(svg);
      host.append(button);
    }
    mount(host);
    icons().scanPhaseIcons();
    expect(document.querySelectorAll("svg[data-prz]").length).toBe(0);
    expect(document.querySelector('svg[viewBox="0 0 14 14"]')).not.toBeNull();
  });

  it("没有 button 包裹的孤立 svg 不被处理", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 14");
    mount(svg);
    icons().scanPhaseIcons();
    expect(svg.hasAttribute("data-prz")).toBe(false);
  });

  it("文案判据与结构判据不一致时，以结构为准", () => {
    // 人为把「维持」的文案贴到第一主阶段的按钮上
    const hud = document.createElement("div");
    hud.setAttribute("data-player-hud", "p1");
    hud.append(strip(["Upkeep", "Draw", "PreCombatMain"], {}));
    hud.querySelectorAll("button")[2].setAttribute(
      "aria-label", `阶段停止：维持步骤。${PHASE_DESCRIPTION.Upkeep}`,
    );
    mount(hud);
    icons().scanPhaseIcons();
    // PreCombatMain 是左组第 3 个，结构说了算
    expect(iconOf("PreCombatMain")).not.toBeNull();
  });

  it("文案表失配（换语言）时，结构判据仍然工作", () => {
    const hud = document.createElement("div");
    hud.setAttribute("data-player-hud", "p1");
    const group = document.createElement("div");
    for (const phase of ["Upkeep", "Draw", "PreCombatMain"]) {
      group.append(phaseDot(phase, { label: `${phase} step. Phase stop: no stop set.` }));
    }
    hud.append(group);
    mount(hud);
    icons().scanPhaseIcons();
    expect(iconOf("Upkeep")).not.toBeNull();
    expect(iconOf("Draw")).not.toBeNull();
    expect(iconOf("PreCombatMain")).not.toBeNull();
  });
});
