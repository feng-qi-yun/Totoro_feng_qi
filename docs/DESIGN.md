# 实现原理与参数标定

面向要改代码的人。使用步骤见 [README](../README.md)。

## 总体结构

浏览器只与本站 `/api/*` 通信，所有上游请求由 Next.js 服务端（`runtime = 'nodejs'`）代发，带
`Authorization: Bearer <token>` 调用学校小程序业务域名（`SUNRUN_MINIPROGRAM_BASE_URL`，默认
`https://wxxcx.xtotoro.com`，失败时自动尝试 `SUNRUN_MINIPROGRAM_FALLBACK_BASE_URL`）。

| 模块 | 职责 |
| --- | --- |
| `lib/server/token-login.js` | Token 校验（`GetStudentInfoByToken`），取出学号/学校/校区代码 |
| `lib/server/sunrun-service.js` | `getSunrunPaper` 取任务与路线 |
| `lib/server/run-preview.js` | 预览：随机生成一份跑步计划，内存保存 10 分钟 |
| `lib/server/run-data.js` | 轨迹与成绩数据生成、拟合度标定（核心） |
| `lib/server/start-run.js` | 开跑与提交两段流程、上游调用时序 |
| `lib/server/confirmed-run.js` | 确认开始：创建场次 + 写入待提交任务 |
| `lib/server/run-queue.js` | 本地待提交任务（文件存储 + 轮询懒提交） |
| `lib/server/running-lines.js` | 读取真实记录导出的「真实跑步线」 |
| `lib/server/morning-sign.js` | 早操打卡（RSA `encryptLong` 加密后提交） |

## 跑步流程

「确认开始」时依次调用：`currentTimeMillis`（取服务器时间算偏移）→ `selectSunRunStartConfiguration`
（查是否要求开跑人脸）→ 有路线时 `getCameraConfig` + `selectSunRunRandomConfiguration` →
`startUpNote`。第三步的返回决定是否继续：学校若开启开跑人脸、随机人脸或摄像头，流程在创建场次前
抛出 `policy_rejected` 停下，不伪造校验资料。

通过后 `getRunBegin` 创建场次拿到 `scantronId`，再查 `getRunPointList` / `getRunPointListAbnormal`，
最后把任务写入待提交文件。到点后提交两段成绩：`sunRunExercises`（汇总）与
`platform/recrecord/sunRunExercisesDetail`（明细点位）。

## 轨迹生成（`run-data.js`）

真实记录实测节奏：1425 点 / 1436 秒（**每秒一个定位点**）、相邻间距中位 1.99 米、时间戳整秒等间隔。

1. **走线**：优先用真实记录导出的「真实跑步线」，否则用官方路线折线。起点用**绝对坐标**（走线的第一个点），
   不随机旋转——真实跑者每次在同一入口开跑，学校也可能校验起点位置。
2. **步长**：`实测里程 / 用时`，再按抖动与偏离造成的里程膨胀反向修正一次（点数≈用时秒数）。
3. **抖动**：AR(1) 相关噪声（相邻定位点的 GPS 误差高度相关），单步增量限幅。
4. **横向偏离**：低频漂移（8 个锚点余弦插值）+ 固定偏置，模拟"整条偏路线一侧并缓慢游走"；
   位移向量的逐步变化限幅，避免出现真实客户端会丢弃的跳跃。
   **漂移按"圈内相位"取值**（相位由走线过程直接记录，不靠投影猜测）——真实跑者每一圈都跑
   同一条道，各圈应互相重合；若按整条轨迹进度取值，圈数一多就会叠出"形状相同、大小不同"的
   嵌套椭圆（实测折叠散度会从 2 米涨到 20~30 米）。起点附近按圈内相位收敛，保证起点不带着
   几十米偏移，同时各圈仍然一致。
5. **裁剪**：沿折线累计里程裁到精确的实测长度，使上报里程等于提交轨迹的实测长度。

法线方向取自较长基线并做移动平均：抖动后的轨迹逐点方向会乱摆，直接拿它当法线会让偏离本身变成锯齿，
实测会把采样率从 0.99 拖到 0.89 点/秒。

## 里程、配速、步数

- **里程**：`DISTANCE_GAIN_BAND`（1.01–1.06）随机选本次实测里程，预览即显示该值；不允许等于任务里程。
- **用时**：取「任务允许区间」与「最慢用时 `maxTime` 的 `SLOW_PACE_BAND`（70%–95%）」的交集并均匀取值，
  复现真实记录里"贴着上限慢慢跑"；交集为空时退回整个允许区间。
- **配速**：按小程序 `calSpeed` 的方式计算（每公里分钟数的整数部分与秒数分别向下取整）。
- **步数**：不上报（真实记录的 `steps` 为空，只有计步传感器可用时客户端才带步数）。

## 拟合度（`fitDegree`）

学校算法 `calculateRouteSimilarity`：对轨迹每 5 米采样，采样点到官方路线折线的最近距离 ≤ 25 米算匹配，
匹配比例即拟合度。官方要求 > 0.60。

- 目标区间 `FIT_DEGREE_BAND` = **0.95–0.99**（实测：沿跑道真跑一次是 0.98）。
- 标定方式：二分横向偏离幅度，使**官方算法在提交点位上重算出的值**等于目标值；因此上报的
  `fitDegree` 与 `sunRunExercisesDetail` 里的点位自洽（服务端若重算会得到同一个值）。
- 目标值两端各留 0.01 余量，舍入后仍落在区间内。

### 真实跑步线

小程序里的官方路线折线常常只是操场/区域边界。天目湖西操场的实测：

| | 官方折线 | 实际跑的跑道 |
| --- | --- | --- |
| 单圈长度 | 572.7 m（21 顶点，矩形边界形状） | 469.8 m（椭圆跑道，约 94m × 176m） |

两者相差 p50 10.2 米、最大 27.0 米——这正是真实记录里"整条偏一侧约 10 米"的来源，不是随机漂移。

`scripts/derive-running-line.js` 从真实记录导出这条线：**按圈相位折叠**（遍历候选圈长，取折叠后
各相位桶内散度最小者，从而自动识别圈数与单圈长度）→ **等弧长采样** → 写入
`local-data/derived-routes/<路线ID>.json`。生成轨迹沿它走，但 `fitDegree` 与上报的
`sunrunPathPointList` 仍按官方路线计算。

实测（西操场，40 次平均）：拟合度 0.971（真实 0.980）、离官方路线 p50 11.8 / p90 21.5 / max 29.0 米
（真实 10.4 / 20.1 / 27.6）。

界面呈现：`lib/server/running-lines.js` 的 `listRunningLines()` 把 `local-data/derived-routes/*.json` 列成
「<官方路线名>-导入路线1/2…」（`/api/sunrun/imported-routes`，编号按文件名排序、损坏文件跳过且不占号），
每条都带 `baseRouteId` / `baseRouteName`，明确它关联的是哪条官方路线；任务页把它并入路线下拉框。选中「导入路线N」时，
前端仍按对应的**官方路线**提交（`pointId`/`lineId`/`sunrunPathPointList` 不变），只是额外带
`importedLineId`，服务端据此把「真实跑步线」挂到 `route.runningLine` 供走线使用。

横向偏离按**圈内相位**取值：相位由走线过程直接记录（`generateCoordinates` 边走边累积弧长），
不靠投影猜测。若按整条轨迹进度取值，圈数一多就会叠出"形状相同、大小不同"的嵌套椭圆
（实测折叠散度会从 2 米涨到 20~30 米，而真实记录 5.6 圈只有 4.6 米）。

## 待提交任务（本地文件）

成绩不能当场提交：`sunRunExercises` 带的是这段运动的起止时间，真实客户端也是跑完才提交。本机版用
`local-data/pending-runs.json` 实现这个等待，不用 Redis、不用常驻进程：

- 确认开始时写入任务（状态 `pending`），前端每 2 秒轮询；
- 轮询时若已到点（场次开始时间 + 用时）就**顺手提交**，成功后状态变 `completed`；
- 到点后要打开页面才会补交；关掉页面再回来、甚至重启程序，回来打开页面就会补上；
- 每个任务只提交一次（整条流程不幂等），失败记原因且不重试；成功结果保留 1 小时、失败记录 1 天；
- 程序在提交过程中退出时，该任务下次读取被标记为失败（不重试，避免重复记成绩）。

## 机型指纹

学校按记录保存 `phoneInfo` 与 `version`，随机或写死的机型会和你的历史记录不一致。机型读
`.env` 的 `TOTORO_DEVICE_PROFILE`（格式 `品牌&型号&系统`，与小程序同款）与 `TOTORO_CLIENT_VERSION`；
`pnpm setup:device` 会从最近一次真实跑步记录里自动读出并写入。未配置或格式错误时退回兜底机型。

## 用真实记录标定参数

`scripts/sample-real-runs.js` 只读拉取你自己的记录（`--detail --keep-tracks` 会带回轨迹），
统计出来用于标定：

| 采样摘要字段 | 标定对象 |
| --- | --- |
| `reportedKmOverTask`（学校字段 `toltalRun`） | `DISTANCE_GAIN_BAND` |
| `reportedFitDegree`（学校字段 `trajectorySimilary`） | `FIT_DEGREE_BAND` |
| `durationOverMaxTime`（学校字段 `userTime`） | `SLOW_PACE_BAND` |
| `sampleGapSeconds` / `sampleSpacingMeters` / `impliedSpeedMedian` | 采样节奏（每秒点数、间距） |
| `distanceToRoute` / `vertexPassage` | `FIT_DEVIATION` 的振幅与形态 |

学校字段名与直觉不同：拟合度 `trajectorySimilary`、用时 `userTime`、配速 `avgPace`（秒/公里）、
位置偏差 `positionDivation`，另有 `warnFlag` / `warnType` / `sobCode`（运动判定，如"疑似全程走路"）/
`ifQualify`。轨迹优先取记录列表里的 `routeItudes` 字段（自带时间戳），失败才回退 `getSunrunArchDetail`。

## 数据与安全

- `local-data/` 已加入 `.gitignore`：里面有明文 Token、待提交任务、真实轨迹与采样结果，只在本机使用。
- 程序不对外提供服务，也不需要 Redis 或数据库；只有服务端会访问学校接口。
