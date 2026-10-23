# 数据来源与授权说明

本仓库的代码以 MIT 许可发布（见 `LICENSE`）。但 **`public/data/words.json` 里的词库数据来自多个上游项目，
它们的许可各不相同**，以下是逐字段的出处，请按需遵守。

## 逐字段出处

| 数据 | 位于 | 上游 | 许可 |
|---|---|---|---|
| 词条、音标、中文/英文释义、BNC/COCA 词频、词形变化 | `words[].w / uk / us / ph / f / bnc / senses / forms` | [ECDICT](https://github.com/skywind3000/ECDICT) | **MIT** ✅ |
| 双语例句、中文同义词、英文近义词 | `words[].ex / syn / synEn` | [KyleBing/dict](https://github.com/KyleBing/dict) 六级词书 | **未声明许可证** ⚠️ |
| 四级 / 六级词表（用来区分增量词） | 构建期使用，不直接落盘 | [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary) | **BSD-3-Clause** ✅ |
| 词频排序 | `words[].f` | [FrequencyWords](https://github.com/hermitdave/FrequencyWords) | **MIT** ✅ |
| 补充英文释义（ECDICT 缺的 1503 条） | `words[].senses[].en` | 本项目用 DeepSeek 批量生成，缓存在 `data/raw/en-defs.json` | 同本项目 |
| 中文词义提示（5268 条） | `words[].zhHint` | 本项目用 DeepSeek 批量生成，缓存在 `data/raw/zh-hints.json` | 同本项目 |
| 阅读理解文章、题目、中文译文 | 运行时由模型生成，不随仓库分发 | 使用者自己的模型接口 | 使用者自理 |

## ⚠️ 关于 KyleBing/dict

该仓库**没有声明开源许可证**。按默认版权规则，「保留所有权利」意味着未获授权不宜再分发其内容，
而 `words[].ex`（例句）、`syn`（中文同义词）、`synEn`（英文近义词）由它派生而来。

**本仓库里提交的 `public/data/words.json` 是合规模式构建的**，不含任何来自该仓库的数据：

```bash
node scripts/build-dict.mjs      # 默认：只用 ECDICT + 模型生成内容
```

所以在合规模式下，`ex / syn / synEn` 三个字段为空数组，音标退回 ECDICT 自带的版本。
提示阶梯会自动退到「构词 + 中文词义提示」，判分逻辑完全不受影响（同义词少了，个别近义表述会交给模型判断）。

想把这些数据加回来（仅在你确认授权之后）：

```bash
node scripts/build-dict.mjs --rich
```

## 其他说明

- 阅读理解的文章、题目、译文是**运行时**由模型生成的，不在本仓库里，只有使用者自己在本地生成时才会产生。
- `data/raw/` 下的原始数据（ECDICT 的 csv、词书 jsonl 等）**没有**被提交，用 `npm run fetch:data` 自行下载。
  其中 `en-defs.json` 与 `zh-hints.json` 是花过模型调用生成的结果，**已提交**，这样别人重建词库不用再花钱。
- 本项目不内置任何 API Key，首次使用时由使用者填写自己的。
