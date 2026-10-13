import React, { useState } from "react";
import { createRoot } from "react-dom/client";

// 书签正文由构建脚本作为 __CONTENT_SOURCE__ 常量注入（浏览器里没有 fs）
// eslint-disable-next-line no-new-func
new Function(__CONTENT_SOURCE__).call(globalThis);
const I = globalThis.__phaseZhPhaseIcons;

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
    log("5) window 捕获到的异常数 = " + window.__errors.length);
    window.__errors.slice(0, 2).forEach((e) => log("   " + e.split("\n").slice(0, 3).join(" | ")));
    log("6) 最终 标记=" + document.querySelectorAll("svg[data-prz]").length);
  }, 50);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
