#!/usr/bin/env node
/**
 * 生成书签小工具（bookmarklet）三件套：
 *
 *     node tools/build-bookmarklet.mjs
 *
 *   dist/phase-plugin.bookmarklet.js   压缩后的代码本体（供人审阅/比对）
 *   dist/phase-plugin.bookmarklet.txt  可直接粘贴为书签地址的 javascript: 一行
 *   dist/install.html           拖拽安装页（Safari 上最省事的安装方式）
 *
 * 为什么必须压缩，而不是直接把 src/content.js 塞进 javascript: URL：
 *
 *  1. 书签地址不能含真实换行，而源码里到处是 `//` 行注释——把换行换成空格，那些
 *     注释就会把它后面的代码整段吃掉。所以必须由真正的解析器去注释，不能用正则
 *     去猜（源码里有大量含 `//` 的 URL 字符串，正则一删就完蛋）。
 *  2. `--charset=ascii` 让 esbuild 把非 ASCII 转义成 \uXXXX，书签正文变成纯 ASCII，
 *     避免中文注释在不同浏览器里被百分号编码折腾出差异。
 *
 * esbuild 从仓库 `client/` 已经装好的依赖里找（pnpm 的 .pnpm 目录下按平台存放
 * 原生二进制）。找不到就明确失败——产物已提交在 dist/，日常并不需要重新生成。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = join(ROOT, "..");

const SOURCE_PATH = join(ROOT, "src", "content.js");
const OUT_DIR = join(ROOT, "dist");
const OUT_JS = join(OUT_DIR, "phase-plugin.bookmarklet.js");
const OUT_TXT = join(OUT_DIR, "phase-plugin.bookmarklet.txt");
const OUT_HTML = join(OUT_DIR, "install.html");

/**
 * GitHub Pages 的入口。
 *
 * GitHub **不会渲染** 仓库里的 .html 文件——点 `dist/install.html` 只会看到源码，
 * 所以「点开链接就能拖按钮」必须靠 Pages 提供真正的网页。Pages 只支持从分支根目录
 * 或 `/docs` 发布，这里用后者，于是安装页要有一份放在 `docs/index.html`。
 *
 * 这份副本由本脚本生成、与 `dist/install.html` 逐字节相同，并由测试守着不许漂移。
 */
const OUT_PAGES = join(ROOT, "docs", "index.html");

/**
 * 找到 esbuild 可执行文件，按优先级：
 *
 *   1. 环境变量 `ESBUILD_BIN`——想指定某个特定版本时用。
 *   2. **本目录自带的 `node_modules/.bin/esbuild`**（`npm install` 装的就是它）。
 *      这条是主路径：本仓库把自己的构建依赖带在身上，不依赖外部环境。
 *      直接 `node tools/build-bookmarklet.mjs` 时 PATH 上没有它，所以必须显式找。
 *   3. `PATH` 上任意一个 esbuild（`brew install esbuild` / `npm i -g esbuild`）。
 *   4. 万一本目录被放进某个 phase.rs 克隆里，用它 `client/` 下已装好的那份。
 *      pnpm 把平台包放在
 *      `.pnpm/@esbuild+<platform>@<version>/node_modules/@esbuild/<platform>/bin/esbuild`，
 *      而那个 `.bin/` 垫片在 macOS + pnpm 下实测是坏的（会被当成 JS 解析），
 *      所以直接按包目录找原生可执行文件。
 *
 * 找不到就明确失败——产物已提交在 dist/，日常并不需要重新生成。
 */
function findEsbuild() {
  const override = process.env.ESBUILD_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`ESBUILD_BIN 指向的文件不存在：${override}`);
    }
    return override;
  }

  const local = join(ROOT, "node_modules", ".bin", "esbuild");
  if (existsSync(local)) return local;

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "esbuild");
    if (existsSync(candidate)) return candidate;
  }

  const pnpm = join(REPO, "client", "node_modules", ".pnpm");
  if (!existsSync(pnpm)) return null;
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith("@esbuild+")) continue;
    const platformRoot = join(pnpm, entry, "node_modules", "@esbuild");
    if (!existsSync(platformRoot)) continue;
    for (const platform of readdirSync(platformRoot)) {
      const binary = join(platformRoot, platform, "bin", "esbuild");
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

function minify(source) {
  const esbuild = findEsbuild();
  if (!esbuild) {
    throw new Error(
      "找不到 esbuild。产物已提交在 dist/，通常不需要重新生成；"
      + "确实要重新生成的话，先在 client/ 里跑 `pnpm install`。",
    );
  }
  return execFileSync(
    esbuild,
    ["--minify", "--target=es2020", "--charset=ascii", "--log-level=warning"],
    { input: source, encoding: "utf8" },
  ).trim();
}

/** 书签地址 = `javascript:` + 百分号编码后的正文。 */
function toBookmarkletUrl(code) {
  return `javascript:${encodeURIComponent(code)}`;
}

function installPage(bookmarkletUrl, codeHash, codeBytes) {
  // 正文已由 encodeURIComponent 编码，不含引号/尖括号/&，可安全放进 HTML 属性。
  //
  // 页面刻意很短：安装步骤本身就是全部内容。功能说明留给 README，排障留给 NOTES——
  // 装的时候不需要读那些。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安装 phase-plugin</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.7 -apple-system, "PingFang SC", system-ui, sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; }
  .drag { display: inline-block; margin: .5rem 0; padding: .8rem 1.6rem;
          border-radius: .6rem; background: #c8102e; color: #ffd400; font-weight: 700;
          font-size: 1.1rem; text-decoration: none; border: 2px solid #8f0b20; }
  ol { padding-left: 1.4rem; }
  li { margin: .5rem 0; }
  code { background: rgba(127,127,127,.16); padding: .1rem .35rem; border-radius: .25rem; }
  .note { color: #b45309; }
  details { margin-top: 2rem; font-size: .9rem; }
  textarea { width: 100%; height: 5rem; margin-top: .5rem;
             font: 12px/1.5 ui-monospace, monospace; }
  footer { margin-top: 2.5rem; font-size: .8rem; opacity: .55; }
</style>
</head>
<body>
<h1>安装 phase-plugin</h1>

<p>把下面这个按钮 <strong>拖到书签栏</strong>（拖不动就右键它，选「添加到书签」）：</p>

<p><a class="drag" href="${bookmarkletUrl}">中文卡图</a></p>

<ol>
  <li>打开 <a href="https://phase-rs.dev">phase-rs.dev</a></li>
  <li><strong>点一下书签栏里的「中文卡图」</strong></li>
</ol>

<p class="note">⚠️ 每次刷新或重开页面都要再点一次。页面内的跳转不用。</p>

<details>
  <summary>拖不动？手动粘贴地址</summary>
  <p>新建一个书签，把它的<strong>地址</strong>整段替换成下面这行：</p>
  <textarea readonly onclick="this.select()">${bookmarkletUrl}</textarea>
</details>

<footer>
  phase-plugin · 正文 ${codeBytes} 字节 ·
  由 <code>src/content.js</code> 压缩生成 · sha256 <code>${codeHash}</code>
</footer>
</body>
</html>
`;
}

const source = readFileSync(SOURCE_PATH, "utf8");
const code = minify(source);
const bookmarkletUrl = toBookmarkletUrl(code);
const codeHash = createHash("sha256").update(source).digest("hex").slice(0, 12);

// 纯 ASCII 且不含任何控制字符，是书签能安全放进一个 URL 的硬前提。生成时就断言，
// 别等用户装完才发现。`src/content.js` 里刻意用码点表而不是 "\t"/"\n" 字面量做空白
// 比较，就是为了守住这条：压缩器会把转义字面量改写成真实控制字符。
if (!/^[\x20-\x7e]*$/.test(code)) throw new Error("压缩后的正文含非 ASCII 或控制字符");
if (code.includes("\n")) throw new Error("压缩后的正文含换行");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_JS,
  `${code}\n// source: src/content.js\n// source sha256 (前 12 位): ${codeHash}\n`,
  "utf8",
);
writeFileSync(OUT_TXT, bookmarkletUrl, "utf8");

const page = installPage(bookmarkletUrl, codeHash, Buffer.byteLength(code, "utf8"));
writeFileSync(OUT_HTML, page, "utf8");

// Pages 入口：与 dist/install.html 逐字节相同的副本，外加载一个 .nojekyll。
// .nojekyll 让 Pages 完全跳过 Jekyll 处理，避免它改动我们这份静态页。
mkdirSync(dirname(OUT_PAGES), { recursive: true });
writeFileSync(OUT_PAGES, page, "utf8");
writeFileSync(join(dirname(OUT_PAGES), ".nojekyll"), "", "utf8");

console.log(`正文 ${Buffer.byteLength(code, "utf8")} 字节 → 书签地址 ${bookmarkletUrl.length} 字节`);
console.log(`内容 sha256 前 12 位: ${codeHash}`);
for (const path of [OUT_JS, OUT_TXT, OUT_HTML, OUT_PAGES]) {
  console.log(`  已生成 ${path.replace(`${REPO}/`, "")}`);
}
