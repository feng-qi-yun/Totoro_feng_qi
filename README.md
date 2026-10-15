# Totoro Sunrun

Next.js 全栈练习项目，使用 App Router 承载前端页面和 `/api` 服务端接口，可直接部署到 Vercel。

## 技术栈

- Next.js App Router
- React
- Zustand
- Lucide React
- BullMQ + Redis（跑步延迟队列）
- pnpm

## 开发

```bash
pnpm install
pnpm dev
```

## 验证

```bash
pnpm lint
pnpm test
pnpm build
```

## 部署

Vercel 使用默认 npm 流程即可：

- Install Command: `npm install`
- Build Command: `npm run build`
- Output: Next.js 默认输出

### 腾讯云生产环境

推送到 `main` 后，[GitHub Actions 工作流](.github/workflows/deploy.yml) 会通过专用 SSH 密钥发布到腾讯云；也可以在 GitHub 的 Actions 页面手动运行。生产环境需要配置以下 Actions secrets：

- `DEPLOY_HOST`：服务器地址
- `DEPLOY_USER`：部署用户
- `DEPLOY_SSH_KEY`：专用 Ed25519 私钥
- `DEPLOY_KNOWN_HOSTS`：经过人工核验的服务器 SSH 公钥记录

服务端的 [`ops/deploy.sh`](ops/deploy.sh) 会串行执行部署，在独立 Git worktree 中安装依赖和构建。构建成功后才原子切换 `/opt/totoro-runtime/current` 并重启服务；健康检查失败时自动恢复上一个版本，服务器保留最近三个版本。

查看生产日志：

```bash
sudo journalctl -u totoro -f
sudo tail -f /var/log/nginx/error.log
```

## 当前功能与平台限制

保留 Next.js 网页与服务端。浏览器只访问本站 `/api/*`，由服务端调用小程序业务接口。

- 输入小程序 Token 登录，支持 Bearer 前缀；GetStudentInfoByToken 校验并获取学生资料。
- getSunrunPaper 获取任务、路线、任务周期、里程与用时要求。
- 网页尚未实现等价的微信后台定位、运动分析、人脸与摄像头采集；学校要求这些校验时，开始跑步会在创建场次前停止。批量接口与旧提交入口已删除。
- 提供“开始跑步”入口，按所选任务与路线执行准备、创建场次、点位查询和成绩提交。

按 `.env.example` 设置 `SUNRUN_MINIPROGRAM_BASE_URL` 为学校实际小程序业务域名，默认 `https://wxxcx.xtotoro.com`，仅允许 HTTPS origin，不添加 `/wxxcx` 路径。原域名发生网络连接错误或超时时，会自动尝试 `SUNRUN_MINIPROGRAM_FALLBACK_BASE_URL`。

本项目不兑换或生成 Token。验证成功且资料包含 snCode、schoolCode、schoolCampusCode 后保存登录状态；旧扫码登录缓存会清除。

`npm test` 使用本地模拟响应检查登录、任务与跑步请求契约，不请求生产接口。`security-audit/` 为分析材料，不参与项目 lint。

## 早操打卡

登录后的任务页会调用 `/wxxcx/platform/mornSign/getMornSignPaper` 获取当前账号的早操任务，展示任务日期、签到时段、今日完成数、允许范围和点位列表。

选择点位并点击“提交签到”后，服务端会重新获取一次当前任务，使用该点位返回的经纬度和二维码，按小程序 `encryptLong` 协议加密请求，再调用 `/wxxcx/platform/mornSign/morningExercises`。每次点击只提交一次，不会因上游业务拒绝自动重试；提交后会刷新任务，以确认 `dayCompSignCount` 是否变化。

## 开始跑步

任务页会先生成路线、里程、用时、配速和步数预览，确认后再执行真实跑步接口。预览数据以随机 ID 在服务端临时保存十分钟，不包含 Token 或生成后的轨迹点；服务重启后需要重新生成预览。确认开始时使用预览选定的统计参数，按**真实记录的采样节奏**生成轨迹：每秒一个定位点（步长 = 实测里程 / 用时）、AR(1) 相关的约 2 米 GPS 抖动、整秒等间隔时间戳，然后依次执行准备配置、`getRunBegin`、点位查询、`sunRunExercises` 和 `sunRunExercisesDetail`，成绩仍然立即提交。

实测节奏对齐（真实记录 `sunrunId20261015440`：1436 秒 / 1425 点 / 间距中位 1.99 米）：生成轨迹采样率约 0.95 点/秒（间隔约 1.05 秒），间距中位约 2.9 米，差异来自用时区间更宽（真实那次贴在 0.957 的慢端）。

任务没有固定路线时，预览显示“无固定路线”，开始后使用内置路线 1 生成轨迹，同时继续向上游提交空 `lineId` 和空 `sunrunPathPointList`。若学校启用了开跑人脸、随机人脸或摄像头检查，流程会在创建场次前停止，不会伪造校验资料。

### 里程与配速

上报的里程不允许恰好等于任务里程。预览会按 `DISTANCE_GAIN_BAND`（`1.01–1.06`）随机选定本次的实测里程并显示出来，确认开始时**先把轨迹沿折线裁到精确的实测长度**，再由此派生 `km`、`avgSpeed`、`steps`：三者都来自同一份提交轨迹，服务端用 `sunRunExercisesDetail` 的点位重算长度时得到同一个值。配速按小程序 `calSpeed` 的方式计算（每公里分钟数的整数部分与秒数分别向下取整），因此不会出现比真实客户端高一秒的取值。无固定路线任务同样按实测里程上报。

用时不贴最快配速，而是取自「任务允许区间」与「最慢用时（`maxTime`）的 `SLOW_PACE_BAND`（`70%–95%`）」的交集，复现真实记录里常见的“贴着上限慢慢跑”；交集为空（窗口极窄）时才退回整个允许区间。`minTime` 10 分 / `maxTime` 25 分的 3.2 公里任务实测用时 17.5–23.8 分钟，对应配速 5'13"–7'17"，不再是 3'44" 那种成绩。

**步数不上报**：真实记录（包括真实跑的那条）的 `steps` 为空，只有计步传感器可用时客户端才带步数，所以提交的 `steps` 固定为空字符串，不再按里程编造一个步数；预览页的步数一栏也随之不再显示。

### 轨迹拟合度

学校算法（`calculateRouteSimilarity`：5 米采样、25 米阈值）比较提交轨迹与官方路线，官方客户端还会本地重算。为了让拟合度不再固定为 `1.00`，预览会为本次跑步随机选定 `0.75–0.90` 的目标值（`FIT_DEGREE_BAND`，显示为“预估拟合度”），确认开始后服务端给轨迹叠加横向偏离场：**路段中间最多偏离路线 40 米，官方路线顶点（打卡点）附近收敛回路线**，再用上述算法二分标定偏离幅度。因此上报的 `fitDegree` 落在目标区间内，并且等于按提交点位重算的结果；无固定路线任务不上报路线，`fitDegree` 仍为 `0.00`。目标值随预览保存在 `plan.fitTarget`，延迟任务载荷因此升到 `schemaVersion 5`，旧版本的延迟任务会以“不支持的延迟任务”失败而不做静默降级。

横向偏离是**低频漂移 + 固定偏置**（`FIT_DEVIATION`：8 个锚点余弦插值、首尾与相邻步长限幅），对齐真实记录的形态——整条轨迹偏路线一侧若干米并缓慢游走，而不是"路段中间鼓起、回到路线上"。实测包络（对照真实 0.98 那次：离路线 p50 10.4 / p90 20.1 / p99 25.8 / 最大 27.6 米，超 25 米采样点占 1.9%）：生成轨迹 p50 约 14 米、p90 约 22 米、最大约 28 米、超 25 米占约 3%，拟合度落在 0.95–0.99。

法线方向取自**较长基线并做移动平均**：抖动后的轨迹逐点方向会乱摆，直接拿它当法线会让偏离本身变成锯齿、白白拉长里程（实测会让采样率从 0.99 掉到 0.89 点/秒）。

### 用真实记录标定参数

`scripts/sample-real-runs.js` 是只读采样脚本，调用 `getSunrunPaperList`、`selectSunRunDayScantronList`、`getSunrunArchDetail` 和 `getRunPointList`，把你自己真实跑步记录的里程、用时、拟合度、步数、存档轨迹和打卡点进度取回本地并统计分布。它不会调用 `sunRunExercises` 等提交接口。

```bash
mkdir -p local-data
TOTORO_TOKEN=<小程序 Token> npm run sample:runs -- --days 60 --detail \
  > local-data/sample-60d.json 2> local-data/sample-60d.log
```

采样结果放在仓库根的 `local-data/`，该目录已加入 `.gitignore`：里面有真实轨迹与成绩记录（含 GPS 坐标），只在本机用于标定，不要提交。

采样摘要里的 `reportedKmOverTask` 用于标定 `DISTANCE_GAIN_BAND`，`reportedFitDegree`（学校字段 `trajectorySimilary`）用于标定 `FIT_DEGREE_BAND`，`durationOverMaxTime`（学校字段 `userTime`）用于标定 `SLOW_PACE_BAND`，`sampleGapSeconds` / `sampleSpacingMeters` / `impliedSpeedMedian` 用于标定采样节奏，`distanceToRoute` / `vertexPassage` 分布用于标定 `FIT_DEVIATION`。轨迹优先取记录列表里的 `routeItudes` 字段（自带时间戳），失败才回退 `getSunrunArchDetail`。

学校字段名与直觉不同，脚本按真实字段取值：拟合度 `trajectorySimilary`、用时 `userTime`、配速 `avgPace`（秒/公里）、位置偏差 `positionDivation`，另有 `warnFlag` / `warnType` / `sobCode`（运动判定，如"疑似全程走路"）/ `ifQualify` / `phoneInfo`。

`SUNRUN_MINIPROGRAM_BASE_URL` 必须设置为无路径的 HTTPS origin；使用原接口时为 `https://wxxcx.xtotoro.com`。开始跑步会请求 `getRunBegin` 和两段成绩提交接口。

## 跑步延迟队列

“确认开始”固定把任务写入 Redis，并按预览的完整跑步用时延迟执行。到期后，独立 Worker 使用确认时刻作为跑步开始时间，依次调用准备配置、`getRunBegin`、点位查询、`sunRunExercises` 和 `sunRunExercisesDetail` 正式接口。账号和记录是否隔离由正式后端负责，本项目不维护账号白名单或模式开关。

配置 Redis 地址：

```dotenv
REDIS_URL=redis://127.0.0.1:6379
```

Worker 执行正式请求需要完整请求资料，因此 Token、任务、路线和跑步计划会作为任务载荷直接保存在 Redis 中。Redis 必须部署在受信网络，禁止暴露到公网，并应配置访问认证与最小权限。

网页与 Worker 必须使用完全相同的配置，并分别作为常驻进程启动：

```bash
pnpm dev
pnpm worker:run
```

生产服务器使用 `totoro.service` 运行网页，使用 `ops/totoro-worker.service` 运行延迟任务 Worker。两者都连接仅监听本机的 Redis；部署脚本切换版本、失败回滚时会同时重启两个服务。

整段正式接口流程不是幂等操作，因此每个 BullMQ 任务只执行一次，不对整个流程自动重试。成功结果保留一小时，失败结果保留一天；前端通过任务状态接口轮询并展示最终场次编号。

## Markdown 对话框

公共组件 `components/MarkdownDialog.jsx` 使用原生 `<dialog>` 提供焦点管理、Escape 与遮罩关闭。对话内容固定从项目根目录的 `dialog/index.md` 导入，由 `@next/mdx` 在开发或生产构建阶段编译，不会在浏览器运行时读取文件。

## 评论区

任务页底部通过 `@giscus/react` 接入仓库的 GitHub Discussions。评论按页面路径映射到 `General` 分类，首次发言需要使用 GitHub 账号授权 Giscus；仓库需要保持 Discussions 开启并安装 [Giscus GitHub App](https://github.com/apps/giscus)。嵌入区域会从站点同源的 `public/giscus-theme.css` 加载自定义主题，使编辑器、按钮和评论卡片保持项目的纸张底色、粗黑边框与方角风格。
