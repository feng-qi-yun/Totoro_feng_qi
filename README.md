# Totoro Sunrun

本机单机运行的运动打卡工具：Next.js App Router 承载前端页面与 `/api` 服务端接口，所有上游请求由服务端代发，只在本机跑，不对外提供服务。

## 技术栈

- Next.js App Router
- React
- Zustand
- Lucide React
- pnpm

本项目**只在本机运行**：没有 Redis、没有常驻 Worker、没有线上部署流程。待提交的成绩写在本机文件里（见「跑步待提交」），单人使用，其他人使用请自行 clone 一份跑在自己电脑上。

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

## 在本机运行

要求：Node.js 20 以上、pnpm。**不需要 Redis、不需要数据库、不需要任何云服务。**

```bash
git clone <本仓库地址>
cd Totoro_feng_qi
pnpm install
cp .env.example .env      # 默认值即可用；如学校有独立业务域名再改
pnpm dev                  # → http://localhost:3000
```

1. 用 `repos/open-totoro-token`（或 Windows 版）从已登录的微信小程序进程里读出 Token；
2. 打开 http://localhost:3000，粘贴 Token 登录；
3. 任务页选任务与路线 → 「查看跑步数据」核对预览 → 「确认并开始跑步」。

`.env` 只需要两个上游域名（默认已填好）：

```dotenv
SUNRUN_MINIPROGRAM_BASE_URL=https://wxxcx.xtotoro.com
SUNRUN_MINIPROGRAM_FALLBACK_BASE_URL=https://app.xtotoro.com
```

其他可选环境变量：`TOTORO_PENDING_STORE` 指定待提交任务文件的位置（默认 `local-data/pending-runs.json`）。

验证代码本身（都不联网、不碰学校接口）：

```bash
pnpm lint
pnpm test
pnpm build
```

## 当前功能与平台限制

保留 Next.js 网页与服务端。浏览器只访问本站 `/api/*`，由服务端调用小程序业务接口。

- 输入小程序 Token 登录，支持 Bearer 前缀；GetStudentInfoByToken 校验并获取学生资料。
- getSunrunPaper 获取任务、路线、任务周期、里程与用时要求。
- 网页尚未实现等价的微信后台定位、运动分析、人脸与摄像头采集；学校要求这些校验时，开始跑步会在创建场次前停止。批量接口与旧提交入口已删除。
- 提供“开始跑步”入口，按所选任务与路线执行准备、创建场次、点位查询和成绩提交。

按 `.env.example` 设置 `SUNRUN_MINIPROGRAM_BASE_URL` 为学校实际小程序业务域名，默认 `https://wxxcx.xtotoro.com`，仅允许 HTTPS origin，不添加 `/wxxcx` 路径。原域名发生网络连接错误或超时时，会自动尝试 `SUNRUN_MINIPROGRAM_FALLBACK_BASE_URL`。

本项目不兑换或生成 Token。验证成功且资料包含 snCode、schoolCode、schoolCampusCode 后保存登录状态；旧扫码登录缓存会清除。

`pnpm test` 使用本地模拟响应检查登录、任务、跑步与待提交队列的契约，不请求生产接口。`security-audit/` 为逆向分析材料，不参与项目 lint。

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

### 真实跑步线

官方路线折线往往只是操场/区域的**边界**，和正常人实际跑的跑道不是同一条线。天目湖西操场的实测对比：

| | 官方折线 | 实际跑的跑道 |
|---|---|---|
| 单圈长度 | 572.7 m（21 顶点，矩形边界形状） | **469.8 m**（椭圆跑道，约 94m × 176m） |
| 形状 | 矩形/边界 | 椭圆跑道 |

两者相差 p50 10.2 米、最大 27.0 米——这正是真实记录里那个"整条偏一侧约 10 米"的来源，不是随机漂移。

`scripts/derive-running-line.js` 用真实跑步记录导出这条线：按**圈相位折叠**（遍历候选圈长，取折叠后散度最小的那个，从而自动识别出你跑了几圈、每圈多长）再做**等弧长采样**，得到一条干净闭合线。

```bash
# 1) 采样一次真实跑过的记录（含轨迹）
TOTORO_TOKEN=<Token> npm run sample:runs -- --days 7 --detail --keep-tracks > local-data/latest.json
# 2) 导出跑步线 → local-data/derived-routes/<路线ID>.json
npm run derive:line -- local-data/latest.json --spacing 15
```

有导出线时，生成轨迹**沿这条线走**，但 `fitDegree` 与上报的 `sunrunPathPointList` **仍按官方路线计算**（学校就是拿官方路线比的）。实测（西操场，40 次平均）：拟合度 0.971（真实 0.980）、离官方路线 p50 11.8 / p90 21.5 / max 29.0 米（真实 10.4 / 20.1 / 27.6），轨迹形状变成正常人的跑道椭圆。

没跑过的路线（例如教学楼、图书馆）没有真实记录，就继续用官方折线生成；跑过一次真实记录后导出即可。

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

## 跑步待提交

成绩不能当场提交：`sunRunExercises` 里带的是这段运动的起止时间，真实客户端也是跑完才提交。本项目用一个**本地文件**实现这个等待，不用 Redis、不用常驻进程：

- 「确认开始」先创建场次（`getRunBegin`），再把「场次 + 任务 + 跑步计划」写进 `local-data/pending-runs.json`，状态 `pending`；
- 前端每 2 秒轮询任务状态，**轮询时若已到点（场次开始时间 + 用时）就顺手提交**，成功后状态变 `completed`；
- 因此到点后**要打开页面**才会补交；关掉页面再回来、甚至重启程序，回来一开页面就会补上；
- 每个任务只提交一次：整条流程不幂等，失败会记下原因且不自动重试，成功结果保留 1 小时、失败记录保留 1 天；
- 若程序在提交过程中退出，该任务在下次读取时标记为失败（不重试，避免重复记成绩）。

`local-data/` 已加入 `.gitignore`：里面既有待提交任务（含明文 Token），也有采样得到的个人跑步数据，**不要提交**。文件只在本机使用，请自行注意本机账号安全。

## Markdown 对话框

公共组件 `components/MarkdownDialog.jsx` 使用原生 `<dialog>` 提供焦点管理、Escape 与遮罩关闭。对话内容固定从项目根目录的 `dialog/index.md` 导入，由 `@next/mdx` 在开发或生产构建阶段编译，不会在浏览器运行时读取文件。

## 评论区

任务页底部通过 `@giscus/react` 接入仓库的 GitHub Discussions。评论按页面路径映射到 `General` 分类，首次发言需要使用 GitHub 账号授权 Giscus；仓库需要保持 Discussions 开启并安装 [Giscus GitHub App](https://github.com/apps/giscus)。嵌入区域会从站点同源的 `public/giscus-theme.css` 加载自定义主题，使编辑器、按钮和评论卡片保持项目的纸张底色、粗黑边框与方角风格。
