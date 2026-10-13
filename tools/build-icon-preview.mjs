#!/usr/bin/env node
/**
 * 生成阶段图标的**原版 vs 现在**对照表，输出两张：
 *
 *     node tools/build-icon-preview.mjs
 *
 *   preview/current-icons.html   交互页：12 个图标逐条对比 + 按真实阶段栏排列
 *   docs/icon-comparison.png     README 内联用的精简版（GitHub 会直接渲染图片）
 *
 * ── 原版图标从哪来 ──────────────────────────────────────────────────────
 *
 * 从 phase.rs 源码里**解析**出来，不手抄：
 *
 *     <phase.rs>/client/src/components/controls/PhaseStopBar.tsx 的 PHASE_ICONS
 *
 * 所以需要一个 phase.rs 的克隆，路径按下面的顺序找（也可用环境变量 PHASE_RS_DIR 指定）。
 * 找不到就明确失败——手抄一份原版图标放进本仓库会随着上游改动悄悄过时。
 *
 * 两件必须注意的事：
 *
 *   1. **JSX 属性名要转成 SVG 属性名**。源码里写的是 `strokeWidth` / `strokeLinecap`，
 *      而真 SVG 用的是 `stroke-width` / `stroke-linecap`。不转的话塞进 HTML 后描边
 *      宽度完全不生效——原版图标会全部画成细线。
 *   2. 原版是 **14×14 的填充式**，新版是 **24×24 的描边式 + 1.15 倍放大**。两边必须用
 *      各自正确的 viewBox 与 fill/stroke，否则对照图会失真。
 *
 * 需要本地 Chrome（渲染 PNG）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 中文阶段名与「出现在哪条栏」——前者取自 phase.rs 的 i18n `phaseName.<Phase>`。 */
const ZH = {
  Untap: "重置步骤", Upkeep: "维持步骤", Draw: "抓牌步骤", PreCombatMain: "战斗前主阶段",
  BeginCombat: "战斗开始步骤", DeclareAttackers: "宣告攻击者步骤", DeclareBlockers: "宣告阻挡者步骤",
  CombatDamage: "战斗伤害步骤", EndCombat: "战斗结束步骤", PostCombatMain: "战斗后主阶段",
  End: "结束步骤", Cleanup: "净化步骤",
};
const WHERE = {
  Untap: "手机操作行", Upkeep: "HUD 左条", Draw: "HUD 左条", PreCombatMain: "HUD 左条",
  BeginCombat: "战斗条", DeclareAttackers: "战斗条", DeclareBlockers: "战斗条",
  CombatDamage: "战斗条", EndCombat: "战斗条", PostCombatMain: "HUD 右条",
  End: "HUD 右条", Cleanup: "手机操作行",
};
const NOTE = {
  PreCombatMain: "原版与「战斗后主阶段」是同一个菱形",
  PostCombatMain: "原版与「战斗前主阶段」是同一个菱形",
  BeginCombat: "原版与「战斗伤害」都是交叉双剑",
  CombatDamage: "原版与「战斗开始」都是交叉双剑，只差中心一个圆点",
  Cleanup: "Tabler 没有 broom，用 brush（刷子）",
};
const BARS = [
  ["HUD 左条", ["Upkeep", "Draw", "PreCombatMain"]],
  ["战斗条", ["BeginCombat", "DeclareAttackers", "DeclareBlockers", "CombatDamage", "EndCombat"]],
  ["HUD 右条", ["PostCombatMain", "End"]],
  ["手机操作行", ["Untap", "Upkeep", "Draw", "PreCombatMain", "BeginCombat", "DeclareAttackers",
    "DeclareBlockers", "CombatDamage", "EndCombat", "PostCombatMain", "End", "Cleanup"]],
];

/** 在常见的几个位置找 phase.rs 的克隆。 */
function findPhaseRs() {
  const candidates = [
    process.env.PHASE_RS_DIR,
    join(ROOT, "..", "phase"),
    join(ROOT, "..", "phase.rs"),
    join(process.env.HOME ?? "", "phase"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const file = join(dir, "client", "src", "components", "controls", "PhaseStopBar.tsx");
    if (existsSync(file)) return file;
  }
  throw new Error(
    "找不到 phase.rs 源码。把 phase.rs 克隆到仓库同级目录，或用环境变量指定：\n"
    + "    PHASE_RS_DIR=/path/to/phase node tools/build-icon-preview.mjs",
  );
}

function readOriginals() {
  const source = readFileSync(findPhaseRs(), "utf8");
  const block = source.slice(source.indexOf("export const PHASE_ICONS"), source.indexOf("const LEFT_PHASES"));
  const out = {};
  for (const match of block.matchAll(/(\w+):\s*\(\s*<svg[^>]*>([\s\S]*?)<\/svg>\s*\)/g)) {
    out[match[1]] = jsxToSvgAttributes(match[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

/** JSX 驼峰属性名 → SVG 连字符属性名。不转的话 strokeWidth 在 HTML 里不生效。 */
function jsxToSvgAttributes(inner) {
  let result = inner;
  for (const [jsx, svg] of [
    ["strokeWidth", "stroke-width"], ["strokeLinecap", "stroke-linecap"],
    ["strokeLinejoin", "stroke-linejoin"], ["fillRule", "fill-rule"],
    ["clipRule", "clip-rule"], ["strokeDasharray", "stroke-dasharray"],
  ]) {
    result = result.split(`${jsx}=`).join(`${svg}=`);
  }
  if (/stroke[A-Z]|fillRule|clipRule/.test(result)) {
    throw new Error(`JSX 属性没转干净，SVG 里不会生效：\n${result}`);
  }
  return result;
}

const SOURCE = readFileSync(join(ROOT, "src", "content.js"), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });
const icons = globalThis.__phaseZhPhaseIcons;
const ORIG = readOriginals();

/** 新版：24×24 描边式，内容绕中心放大。 */
const svNew = (inner, px) =>
  `<svg viewBox="${icons.viewBox}" fill="none" stroke="currentColor" stroke-width="${icons.strokeWidth}"`
  + ` stroke-linecap="round" stroke-linejoin="round" width="${px}" height="${px}">`
  + `<g transform="${icons.zoomTransform}">${inner}</g></svg>`;
/** 原版：14×14 填充式。 */
const svOld = (inner, px) => `<svg viewBox="0 0 14 14" fill="currentColor" width="${px}" height="${px}">${inner}</svg>`;

const rows = icons.phases.map((phase, index) => ({
  i: index + 1, phase, zh: ZH[phase], where: WHERE[phase],
  note: NOTE[phase] ?? "", src: icons.iconSource[phase],
  inner: icons.iconInner[phase], orig: ORIG[phase],
}));

const CSS = `body{margin:0;padding:22px;background:#060b16;color:#e2e8f0;
  font:13px/1.65 -apple-system,"PingFang SC",sans-serif}
h1{font-size:17px;margin:0 0 4px}
.sub{color:#64748b;font-size:12px;margin-bottom:6px}.sub b{color:#7dd3fc}
.badge{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;
  background:#064e3b;color:#6ee7b7;border:1px solid #047857}
table{border-collapse:collapse;width:100%}
th,td{border-top:1px solid #1e293b;padding:9px 10px;text-align:left;vertical-align:middle}
th{color:#64748b;font-size:10px;font-weight:600;font-family:ui-monospace,monospace;border-top:1px solid #334155}
td.n{color:#475569;font-family:ui-monospace,monospace;font-size:11px;width:26px}
td.zh{font-weight:600;white-space:nowrap}
td.en{color:#475569;font-family:ui-monospace,monospace;font-size:11px;white-space:nowrap}
td.src{font-family:ui-monospace,monospace;font-size:11px;color:#7dd3fc;white-space:nowrap}
td.where{color:#64748b;font-size:11px}
.icons{display:flex;align-items:flex-end;gap:14px}
.bar{display:flex;gap:2px;background:#020617cc;border:1px solid #ffffff1a;border-radius:10px;padding:4px 6px;width:max-content}
.btn{display:flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid transparent;color:#64748b}
.btn.on{border-color:#67e8f977;background:#083344d1;color:#fff}
.cap{font-size:9px;color:#475569;font-family:ui-monospace,monospace;text-align:center;margin-top:4px}
.cap.l{text-align:left;margin:0 0 6px}
.old td{opacity:.86}
.note{margin-top:26px;padding:12px 14px;border-left:2px solid #0e7490;background:#0b1626;
  font-size:12px;color:#94a3b8;border-radius:0 6px 6px 0}
.note b{color:#e2e8f0}.note ul{margin:8px 0 0;padding-left:18px}.note li{margin:3px 0}`;

/**
 * 每个阶段的三态标记（10px / 14px / 激活）与两栏标记，**全部在 Node 侧拼好**。
 *
 * 为什么不在浏览器里拼：早先试过把 `svNew` 函数的源码塞进页面，而它的函数体引用了
 * `icons.viewBox`——`icons` 只存在于 Node 侧，浏览器里是 `ReferenceError`，整段脚本
 * 直接挂掉，页面渲染出来只有表头、正文全空。预生成标记就没有这个跨环境引用问题。
 */
function markerSet(inner, original) {
  const cell = (px, on) => ({ px, on, newSvg: svNew(inner, px), oldSvg: svOld(original, px) });
  return [cell(10, false), cell(14, false), cell(14, true)];
}

const PAGES = rows.map((r) => ({
  ...r,
  newSet: markerSet(r.inner, r.orig),
  oldSet: markerSet(r.inner, r.orig),
}));

const BAR_DATA = BARS.map(([label, list]) => ({
  label,
  count: list.length,
  now: list.map((p) => {
    const row = rows.find((r) => r.phase === p);
    return svNew(row.inner, 14);
  }),
  before: list.map((p) => {
    const row = rows.find((r) => r.phase === p);
    return svOld(row.orig, 14);
  }),
}));

function buildPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>阶段图标 · 原版 vs 现在</title><style>${CSS}
.badge{margin-bottom:20px}
h2{font-size:12px;color:#7dd3fc;margin:26px 0 8px;font-weight:600}
</style></head><body>
<h1>阶段图标 · 原版 vs 现在</h1>
<div class="sub">新图标全部来自 <b>Tabler Icons</b>（MIT 许可）· 内容放大 <b>${icons.zoom}×</b> · 手机端 <b>10px</b>、桌面端 <b>14px</b></div>
<div class="badge">单一图标库 · 只需遵守一份许可</div>
<h2>逐条对比</h2>
<table><thead><tr><th>#</th><th>阶段</th><th>图标（10px / 14px / 激活）</th><th>出处</th><th>出现在</th></tr></thead>
<tbody id="tb"></tbody></table>
<h2>按真实阶段栏排列</h2>
<div id="bars"></div>
<div class="note"><b>原版的三处问题</b>（换图标的主要动机）：
<ul>
<li><b>两个主阶段用的是同一个菱形</b>——原版 <code>PreCombatMain</code> 与 <code>PostCombatMain</code> 是两段一模一样的 JSX。</li>
<li><b>战斗开始与战斗伤害都是交叉双剑</b>——只差中心一个圆点。</li>
<li>整体偏细：14×14 填充式图形在 10px 下细节容易糊。</li>
</ul><br>原版图标是 <b>phase.rs 的资产</b>，这里仅作对照；新图标来自
<a href="https://tabler.io/icons" style="color:#7dd3fc">Tabler Icons</a>（MIT），
版权声明见仓库根的 <code>THIRD-PARTY-NOTICES.md</code>。
「出现在」只列主要位置——手机端打开<b>阶段停止抽屉</b>时 12 个会全部出现。</div>
<script>
const R=${JSON.stringify(PAGES)}, BARS=${JSON.stringify(BAR_DATA)};
const btn=(svg,px,on)=>'<div class="btn'+(on?' on':'')+'" style="width:'+(px>10?32:24)+'px;height:'+(px>10?32:24)+'px">'+svg+'</div>';
const set=(cells,cls)=>'<div class="icons">'+cells.map(c=>
  '<div><div class="bar">'+btn(c[cls],c.px,c.on)+'</div><div class="cap">'+(c.on?'激活':c.px+'px')+'</div></div>').join('')+'</div>';
document.getElementById('tb').innerHTML=R.map(r=>
  '<tr class="old"><td class="n">'+r.i+'</td><td class="zh">'+r.zh+'<div class="en">'+r.phase+'</div></td>'
  +'<td colspan="2">'+set(r.oldSet,'oldSvg')+'<div class="src" style="color:#94a3b8;margin-top:6px">原版（phase.rs · 14×14 填充式）</div></td>'
  +'<td class="where">'+r.where+'</td></tr>'
  +'<tr><td class="n"></td><td class="zh" style="color:#64748b">↑ 现在</td>'
  +'<td>'+set(r.newSet,'newSvg')+'<div class="src" style="margin-top:6px">'+r.src+'</div></td>'
  +'<td class="where">'+r.where+(r.note?'<div class="en">'+r.note+'</div>':'')+'</td></tr>').join('');
document.getElementById('bars').innerHTML=BARS.map(b=>
  '<div style="margin-bottom:16px"><div class="cap l">'+b.label+'（'+b.count+' 个）</div>'
  +'<div class="bar">'+b.now.map(sv=>btn(sv,14,false)).join('')+'</div>'
  +'<div class="bar" style="margin-top:4px;opacity:.8">'+b.before.map(sv=>btn(sv,14,false)).join('')+'</div>'
  +'<div class="cap l" style="margin:4px 0 0">上＝现在　下＝原版</div></div>').join('');
</script></body></html>`;
}

/** README 内联用的精简版：只有「阶段名 / 原版 / 现在」三列。 */
function buildTableImagePage() {
  const tableRows = rows.map((r) => ({
    zh: r.zh, en: r.phase, oldSvg: svOld(r.orig, 14), newSvg: svNew(r.inner, 14),
  }));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#0b1220;color:#e2e8f0;font:14px/1.5 -apple-system,"PingFang SC",sans-serif}
table{border-collapse:collapse}
th{color:#94a3b8;font-size:13px;font-weight:600;text-align:left;padding:0 18px 10px 0;white-space:nowrap}
th.o{color:#cbd5e1}th.n{color:#7dd3fc}
td{border-top:1px solid #1e293b;padding:9px 18px 9px 0;vertical-align:middle}
td.ph{font-weight:600;white-space:nowrap;padding-right:26px}
td.ph small{display:block;color:#64748b;font-weight:400;font-size:11px;font-family:ui-monospace,monospace}
td.ic{width:52px}
.box{width:36px;height:36px;display:flex;align-items:center;justify-content:center;
  border-radius:9px;background:#020617;border:1px solid #1e293b;color:#94a3b8}
.box.new{color:#e2e8f0;border-color:#334155}
.arrow{color:#475569;font-size:18px;padding:0 4px}
</style></head><body>
<table><thead><tr><th style="width:170px">回合阶段</th><th class="o">原版（phase.rs）</th><th></th>
<th class="n">现在（Tabler Icons）</th></tr></thead><tbody id="tb"></tbody></table>
<script>
const R=${JSON.stringify(tableRows)};
document.getElementById('tb').innerHTML=R.map(r=>
  '<tr><td class="ph">'+r.zh+'<small>'+r.en+'</small></td>'
  +'<td class="ic"><div class="box">'+r.oldSvg+'</div></td>'
  +'<td class="ic arrow">→</td>'
  +'<td class="ic"><div class="box new">'+r.newSvg+'</div></td></tr>').join('');
// 量出内容实际尺寸，交给构建脚本按尺寸截图——这样不用外部图像库去裁空白边。
if (location.search.includes("measure")) {
  const r = document.body.getBoundingClientRect();
  const pre = document.createElement("pre");
  pre.id = "measure";
  pre.textContent = Math.ceil(r.width + 2) + " " + Math.ceil(r.height + 2);
  document.body.append(pre);
}
</script></body></html>`;
}

/**
 * 用 `--dump-dom` 量出页面实际尺寸。
 *
 * 先量再截，是为了不引入图像处理依赖（本仓库零安装）。`--screenshot` 只会截到窗口大小，
 * 窗口给大了就留一片空白、给小了会裁掉内容——实测两种都踩过。
 */
async function measure(pagePath) {
  const profile = mkdtempSync(join(tmpdir(), "icon-measure-"));
  const child = spawn(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--virtual-time-budget=4000", "--dump-dom",
    `file://${pagePath}?measure`,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 30_000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    child.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* 交给系统 Temp 清理 */ }
  }
  const match = /<pre id="measure">(\d+) (\d+)<\/pre>/.exec(out);
  if (!match) throw new Error("量不到页面尺寸——页面的 measure 探针没跑起来");
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** 起 Chrome 截图；headless Chrome 截完不退出，所以轮询产物文件。 */
async function screenshot(pagePath, outPath, width, height, scale) {
  const profile = mkdtempSync(join(tmpdir(), "icon-preview-"));
  const child = spawn(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--virtual-time-budget=4000",
    // 没有这一条，Chrome 会在 SVG 画完之前就截图——实测截出来只有标题、正文全空。
    // 它让 Chrome 等合成器的各个阶段都跑完再落盘。
    "--run-all-compositor-stages-before-draw",
    `--screenshot=${outPath}`, `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`, `file://${pagePath}`,
  ], { stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        if (readFileSync(outPath).length > 0) return;
      } catch { /* 还没写出来 */ }
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Chrome 提前退出，退出码 ${child.exitCode}`);
      }
    }
    throw new Error("等待截图超时（30 秒）");
  } finally {
    child.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* 交给系统 Temp 清理 */ }
  }
}

const dir = mkdtempSync(join(tmpdir(), "icon-pages-"));
try {
  mkdirSync(join(ROOT, "preview"), { recursive: true });
  mkdirSync(join(ROOT, "docs"), { recursive: true });

  const pagePath = join(dir, "page.html");
  writeFileSync(pagePath, buildPage());
  writeFileSync(join(ROOT, "preview", "current-icons.html"), buildPage());
  console.log("已生成 preview/current-icons.html");

  const tablePath = join(dir, "table.html");
  writeFileSync(tablePath, buildTableImagePage());
  // 排障用：把中间页面留一份到工作区，便于手工核对参数（正常构建不依赖它）
  if (process.env.KEEP_PAGE) writeFileSync(join(ROOT, "preview", ".table-debug.html"), buildTableImagePage());
  const png = join(ROOT, "docs", "icon-comparison.png");
  rmSync(png, { force: true });
  const size = await measure(tablePath);
  await screenshot(tablePath, png, size.width, size.height, 2);
  console.log(`已生成 docs/icon-comparison.png（${readFileSync(png).length} 字节）`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n原版图标解析自：${findPhaseRs()}`);
console.log(`对照表用的是 14px（桌面端尺寸）；交互页里还有 10px 与激活态。`);
