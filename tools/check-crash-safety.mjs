#!/usr/bin/env node
/**
 * 在**真实 Chrome + 真实 React** 里跑一遍「注入图标 → 反复切换阶段」，检查会不会把
 * 应用搞崩。
 *
 *     node tools/check-crash-safety.mjs
 *
 * 为什么需要它：用户报过一次「用了之后游戏崩溃」，界面是 phase.rs 的 ErrorBoundary
 * 兜底页。而 phase.rs 在 `services/telemetryEvents.ts` 里监听了 window 的 `error` 与
 * `unhandledrejection`，把任何未捕获异常上报成 `js_error` —— 也就是说**我们代码里任何
 * 一处没接住的异常，在用户那里都表现为「游戏崩溃」**。
 *
 * 试过用 happy-dom 复现，压不出来：happy-dom 的 DOM 语义和真浏览器有差异，而且
 * React 19 的 render 不包 `act()` 时根本不会落到 DOM 上，用例会**假绿**。
 * 所以这个检查用真浏览器：esbuild 把 React + 书签正文 + 复刻的 PhaseDot 打包成
 * 一个页面，headless Chrome 跑完把结果 dump 出来。
 *
 * 它验证两件事：
 *   1. 注入后反复重渲染（改 active、改 stop），React 不抛错、不出现兜底界面；
 *   2. 全程 window 捕不到任何未捕获异常与未处理的 Promise 拒绝。
 *
 * 需要本地 Chrome，以及一个 phase.rs 克隆（用它的 React 与 ReactDOM）。
 * 路径按 $PHASE_RS_DIR → ../phase → ../phase.rs → ~/phase 的顺序找。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const require = createRequire(import.meta.url);

function findPhaseRs() {
  const candidates = [
    process.env.PHASE_RS_DIR,
    join(ROOT, "..", "phase"),
    join(ROOT, "..", "phase.rs"),
    join(process.env.HOME ?? "", "phase"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "client", "node_modules", "react", "package.json"))) return dir;
  }
  throw new Error(
    "找不到 phase.rs 的克隆（需要它的 React）。用环境变量指定：\n"
    + "    PHASE_RS_DIR=/path/to/phase node tools/check-crash-safety.mjs",
  );
}

const PHASE = findPhaseRs();
const reactDir = join(PHASE, "client", "node_modules");

// esbuild 用本仓库自己的（devDependency）
const esbuild = require(join(ROOT, "node_modules", "esbuild", "lib", "main.js"));

const content = readFileSync(join(ROOT, "src", "content.js"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "crash-safety-"));

/** Chrome 跑页面：headless 模式下它不会自己退出，用 virtual-time-budget 给它干活的时间。 */
async function dumpDom(pagePath) {
  const profile = mkdtempSync(join(tmpdir(), "crash-profile-"));
  const child = spawn(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--virtual-time-budget=8000", "--dump-dom", `file://${pagePath}`,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 40_000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    child.kill("SIGKILL");
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* 交给系统 Temp 清理 */ }
  }
  return out;
}

let failed = false;
try {
  const bundle = join(dir, "harness.js");
  await esbuild.build({
    entryPoints: [join(HERE, "crash-harness", "harness.jsx")],
    bundle: true, format: "iife", platform: "browser", outfile: bundle,
    loader: { ".jsx": "jsx" },
    // 用 phase.rs 那份 React，保证和线上同一个版本、同一种构建
    alias: { react: join(reactDir, "react"), "react-dom/client": join(reactDir, "react-dom", "client.js") },
    define: {
      "process.env.NODE_ENV": '"development"',
      __CONTENT_SOURCE__: JSON.stringify(content),
    },
    logLevel: "warning",
  });

  const page = join(dir, "index.html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#0b1220;color:#e2e8f0;font:13px monospace">
<div id="root" style="padding:12px"></div>
<pre id="out" style="padding:12px;color:#7dd3fc;white-space:pre-wrap"></pre>
<script src="./harness.js"></script>`);

  const dom = await dumpDom(page);
  const match = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  const report = match
    ? match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim()
    : "(拿不到输出)";
  console.log(report);

  const marked = /注入完成，已标记 = (\d+)/.exec(report);
  const injected = marked ? Number(marked[1]) : 0;
  const leaked = /window 捕获到的异常数 = (\d+)/.exec(report);
  const errorCount = leaked ? Number(leaked[1]) : -1;

  console.log();
  if (injected < 10) {
    failed = true;
    console.log(`✗ 注入的图标数偏少（${injected}，期望 10）——识别或替换出了问题`);
  } else {
    console.log(`✓ 注入 ${injected} 个图标，反复重渲染后仍在位`);
  }
  if (errorCount !== 0) {
    failed = true;
    console.log(`✗ 有 ${errorCount} 个未捕获异常/未处理拒绝——这在用户那里会表现为「游戏崩溃」`);
  } else {
    console.log("✓ 全程没有未捕获异常，也没有未处理的 Promise 拒绝");
  }
  if (/出错了/.test(dom)) {
    failed = true;
    console.log("✗ 页面出现了 phase.rs 的 ErrorBoundary 兜底界面");
  } else {
    console.log("✓ 没有触发 phase.rs 的 ErrorBoundary");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log();
if (failed) {
  console.log("检查未通过。");
  process.exit(1);
}
console.log(`检查通过（React 取自 ${PHASE}）。`);
