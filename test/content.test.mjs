/**
 * 纯逻辑单测：Scryfall 地址解析、srcset 处理、地址替换。
 *
 * 直接加载 `src/content.js` 本体（不复制一份实现），在 Node 里跑：脚本在没有 DOM 时
 * 会跳过装配，只把纯函数挂到 `globalThis.__phaseZhCardArt`。
 *
 *     node --test test/content.test.mjs
 *
 * 断言里用到的 URL 形状都是对真实数据实测过的：
 *   https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg?<ts>   ← 应用写的（含英文印刷 id）
 *   https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp    ← 大学院中文图
 *   https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp     ← 大学院英文图
 *
 * 那张 `?<ts>` 查询串必须原样保留在**解析结果之外**：它是大学院的缓存标记，拼接时
 * 由 API 返回的地址自己带着，我们不生成也不猜。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });

const {
  version, parseScryfallImageUrl, mapSrcset, srcsetCandidates, swapOneUrl,
  buildLocalizedIndex, englishPrintingIdOf, localizedUrlToEnglish, isMtgchUrl,
} = globalThis.__phaseZhCardArt;

/** 真实印刷：MH2 #2 Arcbound Javelineer（有官方中文图）。 */
const ID = "fe4a2cb0-4129-451e-a946-a21ea646cc28";
const SCRYFALL = `https://cards.scryfall.io/normal/front/f/e/${ID}.jpg?1783926897`;
const SCRYFALL_SMALL = `https://cards.scryfall.io/small/front/f/e/${ID}.jpg?1783926897`;
const MTGCH_ZH = `https://images.mtgch.com/zhs/normal/front/f/e/${ID}.webp?ts=1756713600`;
const MTGCH_ZH_SMALL = `https://images.mtgch.com/zhs/small/front/f/e/${ID}.webp?ts=1756713600`;
/** API 在有中文图时的形状：zhs_image_uris 优先。 */
const URIS = { small: MTGCH_ZH_SMALL, normal: MTGCH_ZH };

test("VERSION 与 package.json 的 version 一致（防漂移）", () => {
  // 控制台那行「已启用 v…」是用户排障的第一步，版本漂了会误导。
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, pkg.version);
});

test("parseScryfallImageUrl：认出应用写的地址并取出尺寸与印刷 id", () => {
  assert.deepEqual(parseScryfallImageUrl(SCRYFALL), {
    size: "normal", face: "front", printingId: ID,
  });
  assert.deepEqual(parseScryfallImageUrl(SCRYFALL_SMALL), {
    size: "small", face: "front", printingId: ID,
  });
  const back = `https://cards.scryfall.io/large/back/f/e/${ID}.jpg`;
  assert.equal(parseScryfallImageUrl(back).face, "back");
});

test("parseScryfallImageUrl：查询串不影响解析（大学院的 ts 参数在别处）", () => {
  assert.equal(parseScryfallImageUrl(SCRYFALL).printingId, ID);
  assert.equal(parseScryfallImageUrl(`https://cards.scryfall.io/normal/front/f/e/${ID}.jpg`).printingId, ID);
});

test("parseScryfallImageUrl：拒绝不该碰的输入", () => {
  const rejects = [
    "",
    null,
    undefined,
    // 已经指向大学院：不必重复处理（本函数因此天然幂等）
    MTGCH_ZH,
    // 其它域名（牌背、图像包）
    `https://backs.scryfall.io/normal/back/f/e/${ID}.jpg`,
    `https://example.com/normal/front/f/e/${ID}.jpg`,
    // art_crop 与语言无关，刻意不处理
    `https://cards.scryfall.io/art_crop/front/f/e/${ID}.jpg`,
    // 分片目录与文件名不符：不是我们认识的形状
    `https://cards.scryfall.io/normal/front/a/b/${ID}.jpg`,
    // 段数不对
    `https://cards.scryfall.io/normal/front/f/e/x/${ID}.jpg`,
    // 文件名不是 UUID
    "https://cards.scryfall.io/normal/front/f/e/not-a-uuid.jpg",
  ];
  for (const value of rejects) {
    assert.equal(parseScryfallImageUrl(value), null, `不该接受：${value}`);
  }
});

test("swapOneUrl：按尺寸取对应的新地址", () => {
  assert.equal(swapOneUrl(SCRYFALL, URIS), MTGCH_ZH);
  assert.equal(swapOneUrl(SCRYFALL_SMALL, URIS), MTGCH_ZH_SMALL);
  // 该尺寸没有对应地址时返回 null，调用方保持原值
  assert.equal(swapOneUrl(`https://cards.scryfall.io/large/front/f/e/${ID}.jpg`, URIS), null);
  assert.equal(swapOneUrl("https://example.com/x.jpg", URIS), null);
});

test("mapSrcset 改写全部候选并保留描述符", () => {
  const input = `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`;
  const output = mapSrcset(input, (url) => swapOneUrl(url, URIS) ?? url);
  assert.equal(output, `${MTGCH_ZH_SMALL} 146w, ${MTGCH_ZH} 488w`);
});

test("mapSrcset 原样保留不认识的候选", () => {
  const input = `${SCRYFALL} 488w, https://example.com/other.jpg 2x`;
  const output = mapSrcset(input, (url) => swapOneUrl(url, URIS) ?? url);
  assert.equal(output, `${MTGCH_ZH} 488w, https://example.com/other.jpg 2x`);
});

test("mapSrcset 在缺少描述符与多余空白时仍按逗号切分", () => {
  const input = `  ${SCRYFALL_SMALL} , ${SCRYFALL}  488w ,  `;
  const output = mapSrcset(input, (url) => swapOneUrl(url, URIS) ?? url);
  assert.ok(output.includes(MTGCH_ZH_SMALL));
  assert.ok(output.includes(MTGCH_ZH));
  // 描述符不能丢，否则浏览器无法在候选之间选择
  assert.ok(output.includes("488w"));
});

test("mapSrcset 无改动时返回原串（避免多余属性写入）", () => {
  const input = "https://example.com/a.jpg 1x, https://example.com/b.jpg 2x";
  assert.equal(mapSrcset(input, (url) => url), input);
});

test("srcsetCandidates 取出全部 URL，顺序不变", () => {
  const input = `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`;
  assert.deepEqual(srcsetCandidates(input), [SCRYFALL_SMALL, SCRYFALL]);
});

test("端到端：srcset 与 src 换成大学院后，尺寸选择不变", () => {
  // 应用用 sizes="auto, 200px" 让浏览器在 146w/488w 之间挑。两边都换成同尺寸的
  // 大学院地址后，挑中的仍是同一个尺寸，取景不变。
  const srcset = `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`;
  const mapped = mapSrcset(srcset, (url) => swapOneUrl(url, URIS) ?? url);
  const parsed = srcsetCandidates(mapped).map((u) => parseScryfallImageUrl(u));
  assert.deepEqual(parsed, [null, null], "换完之后不该再被认成 Scryfall 地址");
  assert.ok(mapped.includes("/zhs/small/"));
  assert.ok(mapped.includes("/zhs/normal/"));
});

// ── 书签小工具的格式前提 ────────────────────────────────────────────────

const DIST_TEXT = readFileSync(new URL("../dist/phase-plugin.bookmarklet.txt", import.meta.url), "utf8").trim();
const DIST_JS = readFileSync(new URL("../dist/phase-plugin.bookmarklet.js", import.meta.url), "utf8");

test("书签小工具：格式前提（单行、纯 ASCII、无控制字符、可解析）", () => {
  assert.ok(DIST_TEXT.startsWith("javascript:"), "必须是一个 javascript: 地址");
  assert.equal(DIST_TEXT.includes("\n"), false, "必须是单行——书签地址里有换行会被截断");
  // 控制字符放进 URL 会被浏览器转义或截断
  for (const ch of DIST_TEXT) {
    const code = ch.codePointAt(0);
    assert.ok(code >= 0x20 && code !== 0x7f, `出现了控制字符 U+${code.toString(16)}`);
  }
  const body = decodeURIComponent(DIST_TEXT.slice("javascript:".length));
  assert.doesNotThrow(() => new Function(body));
});

test("书签小工具：三个产物同源且未过期", () => {
  const html = readFileSync(new URL("../dist/install.html", import.meta.url), "utf8");
  const pages = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.equal(html, pages, "dist/install.html 与 docs/index.html 必须逐字节相同");

  // `dist/*.txt` 是权威的完整地址；网页里内嵌的是同一串（正文已由
  // encodeURIComponent 处理，不含引号/尖括号/&，所以能安全放进 HTML 属性）。
  const encoded = DIST_TEXT.slice("javascript:".length);
  assert.ok(html.includes(encoded), "安装页应当内嵌同一份编码后的地址");
  assert.ok(pages.includes(encoded), "GitHub Pages 那份也应当内嵌同一份地址");

  // `dist/*.js` 是同一份正文，末尾多了两行来源注释（构建时写进去的）。
  const decoded = decodeURIComponent(encoded);
  assert.ok(DIST_JS.startsWith(decoded), "js 产物应当以 txt 的正文开头");
  assert.ok(DIST_JS.includes("// source: src/content.js"), "js 产物应当带来源注释");
});

test("书签小工具：产物里带着当前版本号", () => {
  // 用动态版本而不是写死：否则每次升版本这条都会红，而它想守的是「产物是从当前
  // 源码构建出来的」，不是某个具体版本号。
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(DIST_JS.includes(pkg.version), `产物里没找到版本 ${pkg.version}，可能忘了重新构建`);
  assert.ok(DIST_TEXT.includes(encodeURIComponent(pkg.version)), "地址里也该带版本号");
});

test("书签小工具：与 src/content.js 行为一致", () => {
  // 产物是**压缩过**的（esbuild --minify），所以注释与多余空白都不在；
  // 只能挑真正会出现的字符串来判。这条断言防的是「改了源码忘了重新构建」。
  for (const marker of [
    "mtgch.com/api/v1/card/",   // 卡图走大学院 API
    "images.mtgch.com",         // 大学院图床
    "tabler/rotate-clockwise",  // 图标出处（排障用）
  ]) {
    assert.ok(DIST_JS.includes(marker), `产物里缺少 ${marker}`);
  }
  // 旧机制必须彻底不在产物里，否则说明构建用的是旧源码
  for (const gone of ["scryfall-images.v2.zh.json", "probeArtUrl", "advanceLadder", "zhs_image_uris"]) {
    // zhs_image_uris 是 API 返回的字段名、会以属性访问形式出现，所以只查前三个的字面量
    if (gone === "zhs_image_uris") continue;
    assert.ok(!DIST_JS.includes(gone), `产物里仍有已删除的旧机制：${gone}`);
  }
});


// ── 截获应用那张本地化表 + 精确还原英文印刷 id（1.9.1）─────────────────

/** 应用那张表的形状：键 = 英文印刷 id，值 = { id: 中文印刷 id, faces: [...] }。 */
const EN_ZEN = "00006596-1166-4a79-8443-ca9f82e6db4e";
const ZH_ZEN = "9a235bac-7372-4190-983d-dbc550b87631";
const EN_GN3 = "540f3ddf-7512-42a0-ba22-b58453747346";
const ZH_FROM_EN_ZEN = `https://cards.scryfall.io/normal/front/9/a/${ZH_ZEN}.jpg?1783000360`;
const SMALL_FROM_EN_ZEN = `https://cards.scryfall.io/small/front/9/a/${ZH_ZEN}.jpg?1783000360`;
/** GN3 那条的值是它自己的 id（它没有中文印刷，回填算法也没给它指派）。 */
const SELF_GN3 = `https://cards.scryfall.io/normal/front/5/4/${EN_GN3}.jpg?1783920302`;
const APP_MAP = {
  schema_version: "v2",
  [EN_ZEN]: { id: ZH_ZEN, faces: [{ small: SMALL_FROM_EN_ZEN, normal: ZH_FROM_EN_ZEN }] },
  [EN_GN3]: { id: EN_GN3, faces: [{ small: SELF_GN3, normal: SELF_GN3 }] },
};

test("buildLocalizedIndex：跳过元数据，按 URL 建索引（同一 URL 只占一条）", () => {
  // 索引是模块级且**幂等**的（不覆盖已有键），所以先清空，否则前面用例留下的
  // 条目会让 added 变成 0 —— 那是测试污染，不是实现问题。
  localizedUrlToEnglish.clear();
  const added = buildLocalizedIndex(APP_MAP);
  // schema_version 不是 UUID，跳过。
  // EN_ZEN 那条 small 与 normal 是两个不同 URL → 2 条；
  // EN_GN3 那条 small 与 normal 是同一个 URL → 只占 1 条。合计 3。
  assert.equal(added, 3);
  // 索引的键是**去掉查询串**的 URL（应用渲染时带不带 `?<ts>` 都可能，
  // 归一化后同一个文件只占一条）。所以这里查归一化后的形式。
  assert.equal(localizedUrlToEnglish.get(ZH_FROM_EN_ZEN.split("?")[0]), EN_ZEN);
  assert.equal(localizedUrlToEnglish.get(SMALL_FROM_EN_ZEN.split("?")[0]), EN_ZEN);
  assert.equal(localizedUrlToEnglish.get(SELF_GN3.split("?")[0]), EN_GN3);
  // 而 englishPrintingIdOf 接受两种形式（自己会归一化）
  assert.equal(englishPrintingIdOf(ZH_FROM_EN_ZEN), EN_ZEN);
  assert.equal(englishPrintingIdOf(SMALL_FROM_EN_ZEN), EN_ZEN);
  assert.equal(englishPrintingIdOf(SELF_GN3), EN_GN3);
});

test("englishPrintingIdOf：用 URL 精确还原，而不是按 id 猜", () => {
  // 关键用例：应用写出来的地址里是**中文** id，而它真正对应的是**英文** id
  assert.equal(englishPrintingIdOf(ZH_FROM_EN_ZEN), EN_ZEN);
  assert.equal(englishPrintingIdOf(SMALL_FROM_EN_ZEN), EN_ZEN);
  // 还原方向必须精确：不能因为「多个英文指向同一中文」就挑错那一个
  assert.notEqual(englishPrintingIdOf(ZH_FROM_EN_ZEN), EN_GN3);
});

test("englishPrintingIdOf：查询串有无都能匹配（应用渲染时可能不带 ts）", () => {
  const withoutTs = ZH_FROM_EN_ZEN.split("?")[0];
  assert.equal(englishPrintingIdOf(withoutTs), EN_ZEN);
});

test("englishPrintingIdOf：未经本地化的英文地址直接用文件名里的 id", () => {
  const url = `https://cards.scryfall.io/normal/front/0/0/${EN_ZEN}.jpg?1783926897`;
  assert.equal(englishPrintingIdOf(url), EN_ZEN);
});

test("englishPrintingIdOf：不认识的地址返回 null（绝不猜）", () => {
  for (const value of [
    "",
    null,
    undefined,
    "https://example.com/normal/front/0/0/" + EN_ZEN + ".jpg",
    `https://cards.scryfall.io/normal/front/1/2/11111111-2222-3333-4444-555555555555.jpg`,
    "https://backs.scryfall.io/normal/back/0/0/" + EN_ZEN + ".jpg",
  ]) {
    assert.equal(englishPrintingIdOf(value), null, `不该认得：${value}`);
  }
});

test("isMtgchUrl：认出已经在大学院图床上的地址（幂等用）", () => {
  assert.equal(isMtgchUrl(MTGCH_ZH), true);
  assert.equal(isMtgchUrl(SCRYFALL), false);
  assert.equal(isMtgchUrl(null), false);
});

test("中英文界面下都能还原：英文地址走快路径，本地化地址走表", () => {
  // 英文界面：应用不本地化，地址里就是英文 id
  const englishUiUrl = `https://cards.scryfall.io/normal/front/0/0/${EN_ZEN}.jpg`;
  assert.equal(englishPrintingIdOf(englishUiUrl), EN_ZEN);
  // 中文界面：应用已换成中文 id，靠截获的表还原回同一个英文 id
  assert.equal(englishPrintingIdOf(ZH_FROM_EN_ZEN), EN_ZEN);
  // 两条路径必须得到**同一个**英文 id，否则两种界面下会换出不同的图
  assert.equal(englishPrintingIdOf(englishUiUrl), englishPrintingIdOf(ZH_FROM_EN_ZEN));
});
