#!/usr/bin/env node
/**
 * 量出 12 个阶段图标放大之后**真实的图形范围**，检查它们是不是还在画布（24×24）之内。
 *
 *     node tools/check-icon-fits.mjs
 *
 * ── 为什么要专门量一次 ──────────────────────────────────────────────────
 *
 * `ICON_ZOOM` 把内容绕画布中心放大 1.15 倍，图形可能顶出原本的 24×24 范围。
 * 试过用纯逻辑算：解析路径坐标、把每个点绕中心放大、判是否越界。做了三版都不可靠，
 * 而且不可靠的方向是**假绿**——把图形改到画布外，测试照样通过：
 *
 *   1. 只认大写 `M`/`L`：漏掉小写 `v`/`h`，把 flag-3 的竖杆拉到 y=30 也发现不了；
 *   2. 补上相对命令：`M8 6h.01` 这类相对小点会被当成绝对坐标，误报「抓牌跑到画布外」；
 *   3. 按时序追踪当前点：Lucide 齿轮图标里有**隐式重复**的圆弧命令
 *      （`a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915` 是两段），
 *      按「末两个数是终点」取会参数错位，又一次误报。
 *
 * 更根本的是：**圆弧与贝塞尔曲线会鼓到端点之外**，所以「端点都在画布内」推不出
 * 「图形在画布内」。这是方法论问题，不是解析器写得不够好。
 *
 * ── 另一个必须知道的坑：viewBox 不裁剪内容 ──────────────────────────────
 *
 * 实测：`<svg viewBox="0 0 24 24">` 里画一条 `M4 24V30`，笔画**照样画到元素底部**——
 * viewBox 只决定缩放与映射，**不裁剪**。所以「越界」不会表现为「被切掉」，而是表现为
 * **图形过大、重心偏移，可能盖到相邻的按钮上**。因此这里量的是「有没有超出画布」，
 * 而不是「有没有被裁」。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────
 *
 * 用 `getBBox()`——浏览器给的是**渲染后的真实包围盒**，把曲线、圆弧、线帽全部算进去，
 * 正好绕开上面所有解析难题。把结果写进 DOM 后用 `--dump-dom` 取回来，不需要额外的
 * 自动化依赖（本仓库零安装）。
 *
 * 需要本地 Chrome。退出码非 0 表示至少一个图标超出画布。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const HERE = new URL(".", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const SOURCE = readFileSync(join(HERE, "..", "src", "content.js"), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });
const icons = globalThis.__phaseZhPhaseIcons;

const [VB_W, VB_H] = icons.viewBox.split(" ").map(Number).slice(2);
/**
 * 容差。`getBoundingClientRect` 已经把描边算进去了，所以这里只留一点点浮点余量。
 */
const STROKE_SLACK = 0.1;

function buildPage() {
  // 每个阶段一个 svg，内容与真实运行时**逐字相同**（同一个 zoomTransform）。
  const svgs = icons.phases.map((phase) => {
    const body = `<g transform="${icons.zoomTransform}">${icons.iconInner[phase]}</g>`;
    return `<svg id="p-${phase}" viewBox="${icons.viewBox}" fill="none" stroke="currentColor"`
      + ` stroke-width="${icons.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`
      + ` width="24" height="24" data-phase="${phase}">${body}</svg>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8">${svgs}<pre id="out"></pre><script>
    const rows = [];
    for (const svg of document.querySelectorAll("svg[data-phase]")) {
      // **必须用 getBoundingClientRect，不能用 getBBox。**
      // getBBox 返回的是**未经变换的局部坐标**——实测把 ICON_ZOOM 从 1.15 改到 1.5，
      // 它给出的四个数一模一样，完全没算上我们加的那个 scale()。拿它判边界就是假绿。
      // getBoundingClientRect 是屏幕像素，包含祖先链上的所有变换，再换算回用户单位即可。
      const base = svg.getBoundingClientRect();
      const scale = base.width / 24; // svg 是 24×24 用户单位
      let box = null;
      for (const el of svg.querySelectorAll("path, circle, rect, line, polyline, polygon")) {
        // Tabler 的图标开头都有一条透明占位路径（stroke="none" 的 M0 0h24v24H0z），
        // 它撑满整个画布，算进去的话每个图标都「刚好占满」，什么都查不出来。
        if ((el.getAttribute("stroke") || "") === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const x0 = (r.left - base.left) / scale;
        const y0 = (r.top - base.top) / scale;
        const x1 = (r.right - base.left) / scale;
        const y1 = (r.bottom - base.top) / scale;
        if (!box) box = { x0, y0, x1, y1 };
        else {
          box.x0 = Math.min(box.x0, x0);
          box.y0 = Math.min(box.y0, y0);
          box.x1 = Math.max(box.x1, x1);
          box.y1 = Math.max(box.y1, y1);
        }
      }
      if (!box) { rows.push(svg.dataset.phase + " none"); continue; }
      rows.push(svg.dataset.phase + " " + [box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0]
        .map(v => v.toFixed(4)).join(" "));
    }
    document.getElementById("out").textContent = rows.join("\\n");
  <\/script>`;
}

/** 起 Chrome、轮询截图式的产物：这里等的是 dump 出来的 DOM 文本。 */
async function dumpDom(pagePath) {
  const profile = mkdtempSync(join(tmpdir(), "fitscheck-"));
  const child = spawn(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
    "--virtual-time-budget=4000", "--dump-dom", `file://${pagePath}`,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(); // dump 通常早就写完了，超时也把已有内容拿去看看
      }, 30_000);
      child.on("error", reject);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    child.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // 交给系统 Temp 清理
    }
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "fits-page-"));
let failures = 0;
try {
  const page = join(dir, "page.html");
  writeFileSync(page, buildPage());
  const dom = await dumpDom(page);
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) throw new Error("拿不到 getBBox 的结果——页面脚本可能没跑完");
  if (process.env.SHOW_RAW) console.log("RAW >>>" + JSON.stringify(match[1]) + "<<<");
  const lines = match[1].trim().split("\n").filter(Boolean);
  if (lines.length !== icons.phases.length) {
    throw new Error(`期望 ${icons.phases.length} 行，实际 ${lines.length} 行`);
  }

  console.log(`画布 ${VB_W}×${VB_H}，放大 ${icons.zoom} 倍，描边 ${icons.strokeWidth}（容差 ${STROKE_SLACK.toFixed(2)}）\n`);
  for (const line of lines) {
    const [phase, ...nums] = line.trim().split(/\s+/);
    const [x, y, w, h] = nums.map(Number);
    const left = x - STROKE_SLACK;
    const top = y - STROKE_SLACK;
    const right = x + w + STROKE_SLACK;
    const bottom = y + h + STROKE_SLACK;
    const over = Math.max(-left, -top, right - VB_W, bottom - VB_H);
    const box = `${left.toFixed(1)},${top.toFixed(1)} → ${right.toFixed(1)},${bottom.toFixed(1)}`;
    if (over > 0.05) {
      failures += 1;
      console.log(`✗ ${phase.padEnd(18)} ${box}   超出画布 ${over.toFixed(2)} 单位`);
    } else {
      const margin = Math.min(left, top, VB_W - right, VB_H - bottom);
      console.log(`✓ ${phase.padEnd(18)} ${box}   最小余量 ${margin.toFixed(2)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log();
if (failures > 0) {
  console.log(`${failures} 个图标的图形超出画布。调小 ICON_ZOOM（当前 ${icons.zoom}），或换图标。`);
  process.exit(1);
}
console.log(`12 个图标的图形都在画布内（ICON_ZOOM = ${icons.zoom}）。`);
