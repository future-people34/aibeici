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
而 `words[].ex`（例句）、`syn`（中文同义词）、`synEn`（英文近义词）正是由它派生而来。

因此：

- **个人学习、自己本地构建使用**：没有问题。
- **公开发布本仓库（含 `public/data/words.json`）**：严格说有授权风险，建议先做下面任意一件事
  - 去 [KyleBing/dict](https://github.com/KyleBing/dict) 开 issue 询问授权；
  - 或者重新构建一份**不含该来源**的词库：
    ```bash
    node scripts/build-dict.mjs --no-rich
    ```
    这样做之后：音标退回 ECDICT 自带版本，例句 / 同义词 / 英文近义词字段为空
    （提示阶梯会自动退到「构词 + 中文词义提示」，判分逻辑不受影响，因为没有例句也有中文提示兜底）。

## 其他说明

- 阅读理解的文章、题目、译文是**运行时**由模型生成的，不在本仓库里，只有使用者自己在本地生成时才会产生。
- `data/raw/` 下的原始数据（ECDICT 的 csv、词书 jsonl 等）**没有**被提交，用 `npm run fetch:data` 自行下载。
- 本项目不内置任何 API Key，首次使用时由使用者填写自己的。
