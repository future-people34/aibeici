# 参与开发

欢迎提 issue 和 PR。下面几条能让事情顺畅一些。

## 跑起来

```bash
npm install        # 或 pnpm install
npm run dev        # http://127.0.0.1:5180，改代码热更新
npm test           # 三个自测套件，改动判分/调度/阅读逻辑前先跑一遍
```

首次运行需要 API Key，见 README 的「配置 API Key」。

## 提交前请自查

```bash
node scripts/preflight.mjs   # 检查有没有把密钥写进文件、统计体积
npm run build                # 类型检查 + 打包
npm test
```

## 几条约定

- **绝不要提交任何密钥**。`apikey.txt`、`.env.local` 都在 `.gitignore` 里，也别把 Key 硬编码进代码或测试。
- 判分、调度、阅读校验这类「逻辑」改动，**请同时在 `scripts/selftest-*.ts` 里加断言**。
  这几个自测不联网、跑得很快，是这个项目唯一的回归防线。
- 词库（`public/data/words.json`）是构建产物，请改 `scripts/build-dict.mjs` 而不是手改 JSON。
- 数据授权的情况比较复杂，动到数据来源前先看 [NOTICE.md](NOTICE.md)。

## 想改判分的手感

最值得调的两处：

- `src/lib/judge.ts` 里的 `buildPrompt()` —— 系统提示词，决定模型怎么判「部分正确」；
- `src/lib/judge.ts` 里的 `HEDGE` —— 哪些模糊表述不本地判、直接交给模型。

改完用 `npm test` 里的批量召回 / 拦截率来对比（现在分别约 97.3% 和 100%）。

## 想调复习节奏

`src/lib/srs.ts`：`ratingFor()` 决定作答怎么映射成 Again/Hard/Good/Easy，
`applyRating()` 里有易忘词的间隔压制阈值。
