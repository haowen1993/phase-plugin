import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });

const { buildReverseMap, zhToEnPrinting, rewriteUrl, parseArtUrl } = globalThis.__phaseZhPhaseIcons;

const EN = "0000579f-7b35-4ed3-b44c-db2a538066fe";
const ZH = "d01e2dda-366b-4274-b2c1-27e3e94743d4";

/**
 * 这一组守的是**「所有卡图都走大学院废墟」**这条要求的核心：
 * 大学院图床只认 Scryfall 的**英文印刷 id**，而 phase.rs 在中文界面下会把地址换成
 * **中文印刷 id**——两者是两组完全不相交的 id（实测 84393 条映射里交集只有 4 个）。
 * 所以不换算的话，有中文图的卡反而会 404、最后裂掉。
 */
test("反查表：从映射表建出「中文印刷 id → 英文印刷 id」", () => {
  const payload = {
    // 真实形状：键是英文印刷 id，值里的 normal URL 里是中文印刷 id
    [EN]: { id: EN, faces: [{ normal: `https://cards.scryfall.io/normal/front/d/0/${ZH}.jpg?1783014248` }] },
    // 没换印次（中英同 id）：不该记，记了反而多一次查表
    "abcdef01-2345-6789-abcd-ef0123456789": {
      id: "abcdef01-2345-6789-abcd-ef0123456789",
      faces: [{ normal: "https://cards.scryfall.io/normal/front/a/b/abcdef01-2345-6789-abcd-ef0123456789.jpg" }],
    },
    // 元数据与残缺条目：都要跳过
    "schema_version": "v2",
    "not-a-uuid": { faces: [{ normal: "https://x/y.webp" }] },
    "11111111-2222-3333-4444-555555555555": { faces: [] },
  };
  const before = zhToEnPrinting.size;
  const added = buildReverseMap(payload);
  assert.equal(added, 1, "只应接受那一条真正换过印次的条目");
  assert.equal(zhToEnPrinting.get(ZH), EN);
  assert.equal(zhToEnPrinting.size, before + 1, "不该把元数据当成卡");
});

test("改写：反查表里有中文 id 时，换成大学院图床的英文 id 地址", () => {
  assert.equal(zhToEnPrinting.get(ZH), EN, "上一条用例应当已把映射写进表里");
  const input = `https://cards.scryfall.io/normal/front/d/0/${ZH}.jpg?1783014248`;
  const output = rewriteUrl(input);
  assert.equal(
    output,
    `https://images.mtgch.com/zhs/normal/front/0/0/${EN}.webp`,
    "应当换成大学院的中文层，且分片目录必须随 id 一起换（0/0 而不是 d/0）",
  );
  // 分片目录与文件名必须一致，否则大学院会 404
  const parsed = parseArtUrl(output);
  assert.equal(parsed.ref.shardA, EN[0]);
  assert.equal(parsed.ref.shardB, EN[1]);
});

test("改写：表里没有的 id 照旧走大学院中文层，交给失败路径去换算", () => {
  const unknown = "99999999-8888-7777-6666-555555555555";
  const input = `https://cards.scryfall.io/normal/front/9/9/${unknown}.jpg`;
  const output = rewriteUrl(input);
  assert.equal(output, `https://images.mtgch.com/zhs/normal/front/9/9/${unknown}.webp`);
});

test("改写：art_crop 不查表，直接走英文层（插画与语言无关）", () => {
  assert.equal(zhToEnPrinting.get(ZH), EN);
  const input = `https://cards.scryfall.io/art_crop/front/d/0/${ZH}.jpg`;
  const output = rewriteUrl(input);
  assert.equal(output, `https://images.mtgch.com/sf/art_crop/front/d/0/${ZH}.webp`);
  assert.ok(output.includes("/sf/"), "art_crop 应当走英文层而不是 /zhs/");
});
