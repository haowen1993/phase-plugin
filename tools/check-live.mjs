#!/usr/bin/env node
/**
 * 对着真实的大学院废墟图床跑一遍「三级阶梯」的判定，确认本工具依赖的 URL 形状
 * 今天仍然成立。
 *
 *     node tools/check-live.mjs
 *
 * 为什么需要它：本工具不能查 API，判据就是 `/zhs/` 路径的 404。这套映射是第三方
 * 站点的实现细节，不是公开契约——哪天他们改了路径，本工具会静默退化成「英文卡图」
 * 或「兜底 Scryfall」，界面不报错。这个脚本把那条隐式契约显式化，改动能被立刻
 * 发现。
 *
 * 需要网络。退出码非 0 表示至少一项断言与预期不符。
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });

const { parseArtUrl, urlFor } = globalThis.__phaseZhCardArt;

/**
 * 取样覆盖本工具必须处理的每一类印刷：
 *  - 有官方中文图（2X2 Lightning Bolt）
 *  - 无中文图，只有英文图（UNF Standard Procedure）
 *  - 双面牌（ISD Delver of Secrets // Insectile Aberration）
 *  - 衍生物（TOTJ Bird 有中文图；THOB Goblin Army 无）
 */
const SAMPLES = [
  { label: "有官方中文图", tier: "zh", size: "normal", face: "front", id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7", expect: 200 },
  { label: "无中文图（中文层应 404）", tier: "zh", size: "normal", face: "front", id: "d4a72769-f691-48c1-939f-54df244fb209", expect: 404 },
  { label: "无中文图的英文层", tier: "mtg-en", size: "normal", face: "front", id: "d4a72769-f691-48c1-939f-54df244fb209", expect: 200 },
  { label: "双面牌正面", tier: "zh", size: "normal", face: "front", id: "11bf83bb-c95b-4b4f-9a56-ce7a1816307a", expect: 200 },
  { label: "双面牌背面", tier: "zh", size: "normal", face: "back", id: "11bf83bb-c95b-4b4f-9a56-ce7a1816307a", expect: 200 },
  { label: "large 尺寸", tier: "zh", size: "large", face: "front", id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7", expect: 200 },
  { label: "small 尺寸", tier: "zh", size: "small", face: "front", id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7", expect: 200 },
  { label: "有中文图的衍生物", tier: "zh", size: "normal", face: "front", id: "000d9280-a79a-4f9f-822c-7aaecbff3337", expect: 200 },
  { label: "无中文图的衍生物（中文层应 404）", tier: "zh", size: "normal", face: "front", id: "0045408d-4ab9-48bf-84aa-c6d827682090", expect: 404 },
  { label: "无中文图衍生物的英文层", tier: "mtg-en", size: "normal", face: "front", id: "0045408d-4ab9-48bf-84aa-c6d827682090", expect: 200 },
  { label: "art_crop（英文层，626x457）", tier: "mtg-en", size: "art_crop", face: "front", id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7", expect: 200 },
];

function scryfallUrlFor(ref) {
  return urlFor("scryfall", ref);
}

/**
 * 必须是 GET，不能改成 HEAD。
 *
 * images.mtgch.com 对**未命中边缘缓存**的 HEAD 请求返回 404，而同一个 URL 用 GET
 * 是 200。实测：`curl -I` → 404，`curl -o /dev/null` → 200；已被 GET 取过一次的
 * 对象，HEAD 才会跟着返回 200。所以用 HEAD 跑这个脚本会得到「覆盖率 0%」这种
 * 完全错误的结论，而 GET 才是浏览器取卡图真正走的方法。
 *
 * 想省流量可以用 `Range: bytes=0-0`（存在 → 206，不存在 → 404），已验证可靠。
 */
/**
 * 探测一个 URL 的状态码。
 *
 * ── 为什么要重试，而不是一次定生死 ─────────────────────────────────────
 *
 * images.mtgch.com 挂在腾讯 EdgeOne 后面，一次解析出 4 个地址，而**多数地址会
 * 直接拒连**：实测同一个 URL 连续 12 次只有 1 次拿到 200。所以「连不上」在这里
 * 是常态，不是结论——把它当成断言失败会让这个脚本每次都红。
 *
 * 更需要小心的是 Node 自己的行为：连接多个地址都失败时，fetch 抛的是
 * **AggregateError**（`error.errors` 里是每一条 ECONNREFUSED），而不是普通的
 * TypeError。早先这个脚本就是被它直接带崩的，连一行结果都没打印出来。
 *
 * 所以：重试若干轮，任何一次拿到状态码就算数；全部失败才报 ERR。
 */
const ATTEMPTS = 20;

async function probe(url) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      // Range 让响应只传 1 个字节：存在 → 206，不存在 → 404。
      const response = await fetch(url, {
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
      });
      return response.status;
    } catch {
      // 连接被拒 / AggregateError / 超时——换下一个边缘节点再试。
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return "ERR";
}

let failures = 0;

for (const sample of SAMPLES) {
  // 先造一个应用的英文卡图 URL，再让本工具自己的解析器把它变成待测 URL——这样
  // 测的就是本工具的真实输入输出，而不是脚本里另写一份拼装逻辑。
  const seed = scryfallUrlFor({
    size: sample.size,
    face: sample.face,
    shardA: sample.id[0],
    shardB: sample.id[1],
    printingId: sample.id,
  });
  const parsed = parseArtUrl(seed);
  if (!parsed) {
    console.log(`✖ ${sample.label}：本工具解析不了自己的种子 URL ${seed}`);
    failures += 1;
    continue;
  }
  const url = urlFor(sample.tier, parsed.ref);
  const status = await probe(url);
  // 「存在」用 206 表达：探测带 `Range: bytes=0-0`，所以一份存在的图回的是 206
  // 而不是 200。断言写成「期望 200」再对 206 判失败就会把好消息报成坏消息——
  // 这里两种都算命中，只有 404 才是「这张印刷没有这一层」。
  const ok = sample.expect === 200 ? status === 200 || status === 206 : status === sample.expect;
  if (!ok) failures += 1;
  console.log(`${ok ? "✔" : "✖"} ${sample.label.padEnd(30)} ${String(status).padEnd(4)} (期望 ${sample.expect})  ${url}`);
}

console.log(failures === 0
  ? "\n全部符合预期：三级阶梯的 URL 形状今天仍然成立。"
  : `\n${failures} 项与预期不符：大学院废墟可能改了路径，本工具需要跟着调整。`);
process.exit(failures === 0 ? 0 : 1);
