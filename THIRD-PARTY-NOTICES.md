# 第三方声明

本仓库的代码用 [MIT](LICENSE)，但仓库里包含**第三方图形资产**，它们各有自己的许可。
这份文件按各自的许可要求，收录完整的版权声明与许可全文。

---

## Tabler Icons — 阶段图标（12 个）

`src/content.js` 里的 `PHASE_ICON_INNER` 收录了 12 个回合阶段图标的 SVG 路径，
逐字取自 **Tabler Icons**：

```
https://tabler.io/icons
```

出处逐条对应见 `src/content.js` 的 `PHASE_ICON_SOURCE`：

| 阶段 | 图标 |
| --- | --- |
| 重置 Untap | `tabler/rotate-clockwise` |
| 维持 Upkeep | `tabler/settings` |
| 抓牌 Draw | `tabler/play-card` |
| 战斗前主阶段 PreCombatMain | `tabler/square-number-1` |
| 战斗开始 BeginCombat | `tabler/swords` |
| 宣告攻击者 DeclareAttackers | `tabler/sword` |
| 宣告阻挡者 DeclareBlockers | `tabler/shield` |
| 战斗伤害 CombatDamage | `tabler/flame` |
| 战斗结束 EndCombat | `tabler/flag-3` |
| 战斗后主阶段 PostCombatMain | `tabler/square-number-2` |
| 结束步骤 End | `tabler/hourglass` |
| 净化步骤 Cleanup | `tabler/brush` |

### 为什么只保留一个图标库

早先的版本混用了 Lucide 与 Tabler 两家。为了让**许可面收窄到一份**，非 Tabler 的
6 个图标（齿轮、交叉双剑、单手剑、盾牌、沙漏、扫帚）已全部换成 Tabler 的对应图形。

代价说清楚：Tabler 没有「扫帚」，净化步骤用的是 `brush`（刷子）——语义上仍是「清理」，
形状比扫帚更斜一些。

**刻意没用 Apple 的 SF Symbols**：它的许可把使用范围限定为「运行在 Apple 系统上的
App」，网页不在内。要用就得在 README 里写一段限制，而那段限制本仓库没有资格授予
（不是 Apple，无权转授权）。

### 许可全文

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 卡图（不在本仓库代码许可范围内）

本工具**不复制、不缓存、不再分发**任何卡图——它只在显示时把浏览器指向大学院废墟的
图床，所以卡图不在本仓库的分发内容里。

- 卡图来自**大学院废墟**（[mtgch.com](https://mtgch.com)，图床 `images.mtgch.com`）。
  其中既包含官方简体中文印刷图，也包含社区制作的中文图；大学院废墟在 `zhs_image`
  字段里标注了每张图的来源（如 `官方`、`衍生物`、`TrentTouch`、`万智烽火`、`新版风云集`）。
- 卡图的权利归属与使用条款由该站点及其上游来源决定。
- Magic: The Gathering 是 Wizards of the Coast 的商标。本工具是非官方作品，与
  Wizards of the Coast 及 phase.rs 项目均无关联。
