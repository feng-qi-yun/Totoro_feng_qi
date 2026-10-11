<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 本地 fork 协作约定

本仓库是 `yuyuyudlc/Totoro` 的个人 fork（`origin` = `feng-qi-yun/Totoro_zsb`），按以下约定工作：

- **不推送到上游**，任何情况下都只允许推送到本 fork；默认只做本地提交，推送前先确认。
- **禁止推送 `main`**：`deploy.yml` 的触发条件是 `push: branches: [main]`（或手动 dispatch），推 `main` 会直接部署到腾讯云。需要远端备份时推**分支**，不要推 `main`。
- **不做超出本机的验证**：不启动开发/生产服务器，不部署，不调用学校线上接口，不碰线上 Redis。测试只在本地跑 `pnpm lint` / `pnpm test` / `pnpm build`，网络请求一律用注入的 mock。
- **按节点自行提交**：一个完整改动做完（并通过本地验证）就 `git commit`，不要攒着等提醒；提交信息用仓库既有的 `feat:` / `fix:` / `docs:` 中文风格。
- **提到 PR 不是授权提 PR**：用户会在自己充分测试后再决定是否向上游提 PR，agent 不主动发起。
