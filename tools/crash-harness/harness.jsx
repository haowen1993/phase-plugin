import React, { useState } from "react";
import { createRoot } from "react-dom/client";

// 书签正文由构建脚本作为 __CONTENT_SOURCE__ 常量注入（浏览器里没有 fs）
// eslint-disable-next-line no-new-func
new Function(__CONTENT_SOURCE__).call(globalThis);
const I = globalThis.__phaseZhPhaseIcons;

// 这个页面**没有 Tailwind**，而我们要验证的正是「注入的图标与原版同位同尺寸」——
// 没有 CSS 就无从验证。所以在这里补上我们用到的那些工具类的最小模拟。
// 另外：行内 <svg> 若没有 width/height 属性，在浏览器里是 **0×0**（与 <img> 那种
// 替换元素不同），平时能显示全靠这些类撑着——所以这段 CSS 不是可选项。
// 用属性选择器而不是类选择器：Tailwind 的类名里有 `.` 和 `/`，在 CSS 里要转义成
// `\\.` 和 `\\/`，再嵌进 JS 模板字符串还要再转义一层——很容易写错又难发现。
// `[class~="h-2.5"]` 完全避开转义，语义也直白。
const HARNESS_CSS = [
  '[class~="h-2.5"]{height:10px}', '[class~="w-2.5"]{width:10px}',
  '[class~="lg:h-3.5"]{height:14px}', '[class~="lg:w-3.5"]{width:14px}',
  '[class~="h-3"]{height:12px}', '[class~="w-3"]{width:12px}',
  '[class~="h-4"]{height:16px}', '[class~="w-4"]{width:16px}',
  '[class~="h-6"]{height:24px}', '[class~="w-6"]{width:24px}',
  '.hidden{display:none}', '.relative{position:relative}', '.flex{display:flex}',
  // 按钮在真实 phase.rs 里是固定的 24px 方框（`h-6 w-6` + flex 居中）。
  // 这个宽度必须补上：否则按钮会被 flex-shrink 压窄，原版 SVG（参与收缩）变得
  // 比注入节点（绝对定位、不参与收缩）更窄，量出来是假的「尺寸差」。
  '[class~="h-6"][class~="w-6"]{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}',
  '[class~="h-6"][class~="w-6"]>svg{flex:0 0 auto}',
].join('');
if (!document.getElementById("harness-css")) {
  const style = document.createElement("style");
  style.id = "harness-css";
  style.textContent = HARNESS_CSS;
  document.head.append(style);
}

const OUT = [];
const log = (s) => { OUT.push(s); const el = document.getElementById("out"); if (el) el.textContent = OUT.join("\n"); };

function OriginalIcon({ shape }) {
  if (shape === "sun") {
    return (
      <svg viewBox="0 0 14 14" className="h-2.5 w-2.5 lg:h-3.5 lg:w-3.5" fill="currentColor">
        <circle cx="7" cy="7" r="3" />
        <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    );
  }
  if (shape === "swords") {
    return (
      <svg viewBox="0 0 14 14" className="h-2.5 w-2.5 lg:h-3.5 lg:w-3.5" fill="currentColor">
        <path d="M3 2l8 8M11 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 14 14" className="h-2.5 w-2.5 lg:h-3.5 lg:w-3.5" fill="currentColor">
      <path d="M7 1L12 7L7 13L2 7Z" />
    </svg>
  );
}
const SHAPES = { Upkeep: "sun", Draw: "gem", PreCombatMain: "gem", BeginCombat: "swords",
  DeclareAttackers: "gem", DeclareBlockers: "gem", CombatDamage: "swords", EndCombat: "gem",
  PostCombatMain: "gem", End: "gem" };
const LABELS = {
  Upkeep: "维持步骤。维持触发式异能与周期性费用在此发生。",
  Draw: "抓牌步骤。你在此抓本回合的牌。",
  PreCombatMain: "战斗前主阶段。在战斗前使用地并施放咒语。",
  BeginCombat: "战斗开始步骤。选择攻击者之前的最后一个优先权窗口。",
  DeclareAttackers: "宣告攻击者步骤。由攻击牌手选择攻击者。",
  DeclareBlockers: "宣告阻挡者步骤。由防御牌手选择阻挡者。",
  CombatDamage: "战斗伤害步骤。生物分配并造成战斗伤害。",
  EndCombat: "战斗结束步骤。造成伤害后的最后一个战斗优先权窗口。",
  PostCombatMain: "战斗后主阶段。在战斗后使用地或施放咒语。",
  End: "结束步骤。结束步骤的触发式异能与回合结束时的行动在此发生。",
};

function PhaseDot({ phase, active, stop }) {
  return (
    <button type="button" aria-label={"阶段停止：" + LABELS[phase] + " 未设置停止。"}
      className={"group relative flex h-6 w-6 items-center justify-center rounded-[7px] border " + (active ? "border-cyan-300/45 text-white" : "text-slate-500")}>
      {active ? <span className="absolute -top-1 left-1/2 h-1 w-3 -translate-x-1/2 bg-amber-300" /> : null}
      <OriginalIcon shape={SHAPES[phase]} />
      {stop ? <span className="absolute -bottom-0.5 left-1/2 h-1 w-1 rounded-full bg-amber-400" /> : null}
      <span className="hidden" aria-hidden />
    </button>
  );
}
// 按真实结构分容器：HUD 左条 3 个、战斗条 5 个 —— 识别靠「组内数量」，混在一起认不出
const LEFT = ["Upkeep", "Draw", "PreCombatMain"];
const COMBAT = ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"];
const RIGHT = ["PostCombatMain", "End"];

function App() {
  const [i, setI] = useState(0);
  const [stopOn, setStopOn] = useState(false);
  const active = LEFT[i % LEFT.length];
  return (
    <div data-player-hud="p1">
      {/* 一张会加载失败的卡图：把卡图的 error 捕获 → 探测 → 降级那条链也压上。
          下面的循环会反复改它的 src，让 error 路径反复触发。 */}
      <img id="card" alt="" style={{ width: 40, height: 56 }}
        src="https://images.mtgch.com/zhs/normal/front/a/b/00000000-0000-0000-0000-000000000000.webp" />
      <div style={{ display: "flex", gap: 2 }}>
        {LEFT.map((p) => <PhaseDot key={p} phase={p} active={p === active} stop={stopOn && p === active} />)}
      </div>
      <div data-combat-phase-indicator="" style={{ display: "flex", gap: 2, marginTop: 8 }}>
        {COMBAT.map((p) => <PhaseDot key={p} phase={p} active={false} stop={false} />)}
      </div>
      <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
        {RIGHT.map((p) => <PhaseDot key={p} phase={p} active={false} stop={false} />)}
      </div>
      <div style={{ marginTop: 16 }}>
        <button id="bump" onClick={() => setI((n) => n + 1)}>bump</button>
        <button id="stop" onClick={() => setStopOn((v) => !v)}>stop</button>
      </div>
    </div>
  );
}

window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push("error: " + ((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + e.reason));

function main() {
  const root = createRoot(document.getElementById("root"));
  try {
    root.render(<App />);
    log("1) 首次渲染完成");
  } catch (e) {
    log("1) 首次渲染抛错: " + e.stack);
    return;
  }

  setTimeout(() => {
    log("2) 注入前 14x14 数 = " + document.querySelectorAll('svg[viewBox="0 0 14 14"]').length);
    try {
      I.scanPhaseIcons();
      log("3) 注入完成，已标记 = " + document.querySelectorAll("svg[data-prz]").length);
    } catch (e) {
      log("3) 注入抛错: " + e.stack);
    }

    for (let n = 0; n < 15; n += 1) {
      try {
        document.getElementById("bump").click();
        document.getElementById("stop").click();
        // 反复重挂失败的卡图，压 error 捕获 → 探测 → 降级那条链
        const img = document.getElementById("card");
        img.setAttribute("src", "https://images.mtgch.com/zhs/normal/front/a/b/00000000-0000-0000-0000-00000000000" + (n % 10) + ".webp");
      } catch (e) {
        log("4." + n + ") 切换时抛错: " + e.stack);
        break;
      }
      if (n < 3 || n === 14) {
        log("4." + n + ") 切换后 标记=" + document.querySelectorAll("svg[data-prz]").length
          + " / 14x14=" + document.querySelectorAll('svg[viewBox="0 0 14 14"]').length
          + " / 24x24=" + document.querySelectorAll('svg[viewBox="0 0 24 24"]').length
          + " / 按钮=" + document.querySelectorAll("button").length);
      }
    }
    // 视觉验证：注入的图标必须与原版**同位同尺寸**。
    //
    // 这一条是靠真浏览器才查得出来的：无头测试环境不做布局，量什么都是 0。
    // 它抓到过两个真问题——(1) 先隐藏再量尺寸，导致量到 0（图标整个消失）；
    // (2) 绝对定位的静态位置与 flex 居中的原版不重合，出现横向偏移。
    {
      const originals = Array.from(document.querySelectorAll("svg[data-prz-src]"));
      const problems = [];
      for (const original of originals) {
        const injected = original.nextElementSibling;
        const name = original.getAttribute("data-prz-src");
        if (!injected || !injected.hasAttribute("data-prz")) {
          problems.push(name + " 缺注入节点");
          continue;
        }
        const a = original.getBoundingClientRect();
        const b = injected.getBoundingClientRect();
        const dx = Math.abs(a.left - b.left);
        const dy = Math.abs(a.top - b.top);
        const dw = Math.abs(a.width - b.width);
        const dh = Math.abs(a.height - b.height);
        if (dx > 0.5 || dy > 0.5 || dw > 0.5 || dh > 0.5) {
          problems.push(name + " 偏移 " + dx.toFixed(1) + "," + dy.toFixed(1)
            + " 尺寸差 " + dw.toFixed(1) + "," + dh.toFixed(1)
            + " | 原版(" + a.left.toFixed(1) + "," + a.top.toFixed(1) + ") 注入("
            + b.left.toFixed(1) + "," + b.top.toFixed(1) + ")");
        }
      }
      log("4.5) 视觉核对：原版 " + originals.length + " 个，错位/缺注入 " + problems.length + " 个");
      problems.slice(0, 5).forEach((p) => log("     " + p));
    }
    log("5) window 捕获到的异常数 = " + window.__errors.length);
    window.__errors.slice(0, 2).forEach((e) => log("   " + e.split("\n").slice(0, 3).join(" | ")));
    log("6) 最终 标记=" + document.querySelectorAll("svg[data-prz]").length);
  }, 50);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
