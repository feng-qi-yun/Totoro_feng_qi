#!/usr/bin/env node
// 只读采样脚本：取回你自己真实跑步记录（里程、用时、拟合度、步数、存档轨迹），
// 用于标定 lib/server/run-data.js 的生成参数。
//
// 只调用读取接口，不会提交成绩、不会修改任何记录。
import { pathToFileURL } from 'node:url';
import nextEnv from '@next/env';
import { MINIPROGRAM_BASE_URL } from '../lib/server/config.js';
import { fetchMiniProgram } from '../lib/server/miniprogram-fetch.js';
import { calculateRouteSimilarity, distanceOfTrack, haversineDistance } from '../lib/server/run-data.js';
import { serviceFromBody } from '../lib/server/sunrun-service.js';
import { loginWithToken } from '../lib/server/token-login.js';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const PATHS = {
  papers: '/wxxcx/sunrun/getSunrunPaperList',
  dayRecords: '/wxxcx/sunrun/selectSunRunDayScantronList',
  archDetail: '/wxxcx/sunrun/getSunrunArchDetail',
  runPoints: '/wxxcx/sunrun/getRunPointList',
};

const USAGE = `用法：
  TOTORO_TOKEN=<小程序 Token> node scripts/sample-real-runs.js [选项]

选项：
  --token <token>       小程序 Token（也可用环境变量 TOTORO_TOKEN）
  --days <n>            向前采样多少天，默认 30
  --paper-id <id>       只采样指定任务
  --detail              额外取回每条记录的真实存档轨迹并测量（默认最新 5 条）
  --detail-limit <n>    --detail 最多测量多少条，默认 5
  --keep-tracks         输出中包含完整轨迹点（默认只输出沿线偏离采样）
  --delay <ms>          请求间隔，默认 400
  --no-redact           输出中保留学号/学校代码（默认打码）
  --json                只输出 JSON，不打印摘要
  --help

输出为 JSON，整段贴回即可用于标定 FIT_DEGREE_BAND 等参数。`;

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export function parseArgs(argv) {
  const options = {
    token: process.env.TOTORO_TOKEN || '',
    days: 30,
    paperId: '',
    detail: false,
    detailLimit: 5,
    keepTracks: false,
    delayMs: 400,
    redact: true,
    jsonOnly: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;   // pnpm 会把 -- 原样透传过来
    const value = argv[index + 1];
    if (arg === '--token') { options.token = value || ''; index += 1; }
    else if (arg === '--days') { options.days = Math.max(1, Number(value) || 30); index += 1; }
    else if (arg === '--paper-id') { options.paperId = value || ''; index += 1; }
    else if (arg === '--detail') { options.detail = true; }
    else if (arg === '--detail-limit') { options.detailLimit = Math.max(1, Number(value) || 5); index += 1; }
    else if (arg === '--keep-tracks') { options.keepTracks = true; }
    else if (arg === '--delay') { options.delayMs = Math.max(0, Number(value) || 0); index += 1; }
    else if (arg === '--no-redact') { options.redact = false; }
    else if (arg === '--json') { options.jsonOnly = true; }
    else if (arg === '--help' || arg === '-h') { options.help = true; }
  }
  return options;
}

async function post(path, body, token) {
  const response = await fetchMiniProgram(path, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...body, token }),
  }, { timeoutMs: 20000 });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  const result = await response.json().catch(() => {
    throw new Error(`${path} 未返回有效 JSON`);
  });
  if (result && typeof result === 'object' && result.status != null && String(result.status) !== '00') {
    throw new Error(`${path} 业务失败: ${result.msg || result.message || result.status}`);
  }
  return result;
}

function firstList(result) {
  for (const key of ['data', 'body', 'list', 'obj']) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return Array.isArray(result) ? result : [];
}

const firstOf = (source, keys) => keys
  .map(key => source?.[key])
  .find(value => value !== undefined && value !== null && value !== '');

export function parseDurationSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const parts = text.split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function shanghaiDates(days, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return Array.from({ length: days }, (_, index) => formatter.format(new Date(now - index * 86400000)));
}

// 记录列表的 routeItudes 字段："经度,纬度,时间;..."，比 getSunrunArchDetail 多带时间戳
export function parseRouteItudes(value) {
  const points = [];
  const seconds = [];
  for (const item of String(value || '').split(';')) {
    const [longitude, latitude, time] = item.split(',');
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({ latitude: lat, longitude: lon });
    seconds.push(Date.parse(String(time).replace(' ', 'T') + '+08:00') / 1000);
  }
  return { points, seconds };
}

// 真实采样节奏：相邻点间距、时间间隔与隐含速度
export function describePaceProfile(points, seconds) {
  if (points.length < 3) return null;
  const gaps = [];
  const spacings = [];
  const speeds = [];
  for (let index = 1; index < points.length; index += 1) {
    const spacing = haversineDistance(points[index - 1], points[index]);
    spacings.push(spacing);
    const delta = seconds[index] - seconds[index - 1];
    if (!Number.isFinite(delta) || delta <= 0) continue;
    gaps.push(delta);
    speeds.push(spacing / delta);
  }
  return {
    spacing: describe(spacings),
    gapSeconds: describe(gaps),
    impliedSpeed: describe(speeds),
    overEightMetersPerSecond: speeds.length
      ? Number((speeds.filter(speed => speed > 8).length / speeds.length).toFixed(4))
      : null,
  };
}

export function toPoints(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(point => ({
    latitude: Number(point?.latitude),
    longitude: Number(point?.longitude),
  })).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

export function pointToPolylineDistance(point, polyline) {
  let nearest = Infinity;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const startLat = polyline[index].latitude;
    const startLon = polyline[index].longitude;
    const deltaLat = polyline[index + 1].latitude - startLat;
    const deltaLon = polyline[index + 1].longitude - startLon;
    const lengthSquared = deltaLat * deltaLat + deltaLon * deltaLon;
    const ratio = lengthSquared
      ? ((point.latitude - startLat) * deltaLat + (point.longitude - startLon) * deltaLon) / lengthSquared
      : 0;
    const clamped = Math.min(1, Math.max(0, ratio));
    nearest = Math.min(nearest, haversineDistance(point, {
      latitude: startLat + clamped * deltaLat,
      longitude: startLon + clamped * deltaLon,
    }));
  }
  return nearest;
}

export function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Number(sorted[lower].toFixed(2));
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)).toFixed(2));
}

export function describe(values) {
  const numbers = values.filter(value => Number.isFinite(value));
  if (!numbers.length) return null;
  return {
    count: numbers.length,
    min: Number(Math.min(...numbers).toFixed(2)),
    p25: percentile(numbers, 0.25),
    median: percentile(numbers, 0.5),
    p75: percentile(numbers, 0.75),
    max: Number(Math.max(...numbers).toFixed(2)),
  };
}

// 从真实存档轨迹量出"真实跑者会偏离路线多远"，并与官方算法重算的拟合度对照
export function analyzeRealTrack(track, routePoints) {
  const points = toPoints(track);
  if (points.length < 2 || routePoints.length < 2) return null;
  const distances = points.map(point => pointToPolylineDistance(point, routePoints));
  const deviationProfile = Array.from({ length: 60 }, (_, index) => (
    distances[Math.min(distances.length - 1, Math.floor(index / 60 * distances.length))]
  )).map(value => Number(value.toFixed(1)));
  const vertexPassages = routePoints.map(vertex => Math.min(...points.map(point => (
    haversineDistance(point, vertex)
  ))));
  return {
    pointCount: points.length,
    trackMeters: Number(distanceOfTrack(points).toFixed(1)),
    recomputedFitDegree: Number(calculateRouteSimilarity(points, routePoints)).toFixed(2),
    distanceToRoute: {
      max: Number(Math.max(...distances).toFixed(1)),
      p50: percentile(distances, 0.5),
      p90: percentile(distances, 0.9),
      p99: percentile(distances, 0.99),
      over25Ratio: Number((distances.filter(distance => distance > 25).length / distances.length).toFixed(3)),
    },
    vertexPassage: {
      max: Number(Math.max(...vertexPassages).toFixed(1)),
      median: percentile(vertexPassages, 0.5),
    },
    deviationProfile,
  };
}

export async function sampleRealRuns(options, { log = () => {} } = {}) {
  log(`上游域名: ${MINIPROGRAM_BASE_URL}`);
  const profile = await loginWithToken(options.token);
  log(`账号: ${profile.stuName || '(未返回姓名)'} / ${profile.stuNumber} / ${profile.campusName || profile.campusId}`);

  const tasks = await serviceFromBody({
    token: profile.token,
    stu_number: profile.stuNumber,
    campus_id: profile.campusId,
  }).getSunrunTasks();
  log(`任务数: ${tasks.length}`);

  const wantedTasks = options.paperId
    ? tasks.filter(task => String(task.taskId) === String(options.paperId))
    : tasks;
  const taskMileage = new Map(tasks.map(task => [String(task.taskId), Number(task.mileage)]));
  const taskMaxSeconds = new Map(tasks.map(task => [String(task.taskId), Number(task.maxTime) * 60]));
  const routes = [];
  for (const task of wantedTasks) {
    for (const route of task.runPointList || []) routes.push({ task, route });
  }

  const paperList = await post(PATHS.papers, {
    stuNumber: profile.stuNumber,
    snCode: profile.stuNumber,
  }, profile.token).catch(error => {
    log(`任务列表接口不可用（不影响成绩采样）: ${error.message}`);
    return null;
  });

  const records = new Map();
  for (const date of shanghaiDates(options.days)) {
    for (const task of wantedTasks) {
      await sleep(options.delayMs);
      let dayRecords;
      try {
        dayRecords = firstList(await post(PATHS.dayRecords, {
          snCode: profile.stuNumber,
          evaluateDate: date,
          paperId: task.taskId,
        }, profile.token));
      } catch (error) {
        log(`${date} ${task.name} 记录查询失败: ${error.message}`);
        continue;
      }
      for (const record of dayRecords) {
        const recordId = firstOf(record, ['id', 'scantronId', 'scoreId']);
        if (recordId === undefined) continue;
        const key = `${task.taskId}:${recordId}`;
        if (records.has(key)) continue;
        records.set(key, {
          date,
          recordId: String(recordId),
          taskId: String(task.taskId),
          routeId: String(firstOf(record, ['pointId', 'lineId', 'runPointId']) ?? ''),
          km: Number(firstOf(record, ['toltalRun', 'totalRun', 'distance', 'km', 'mileage']) ?? NaN),
          usedTime: String(firstOf(record, ['userTime', 'usedTime', 'useTime', 'time']) ?? ''),
          fitDegree: Number(firstOf(record, ['trajectorySimilary', 'fitDegree', 'fit', 'degree']) ?? NaN),
          positionDivation: Number(firstOf(record, ['positionDivation']) ?? NaN),
          avgPace: Number(firstOf(record, ['avgPace']) ?? NaN),
          warnFlag: String(firstOf(record, ['warnFlag']) ?? ''),
          warnType: String(firstOf(record, ['warnType']) ?? ''),
          verdict: String(firstOf(record, ['sobCode', 'sobId']) ?? ''),
          ifQualify: String(firstOf(record, ['ifQualify']) ?? ''),
          phoneInfo: String(firstOf(record, ['phoneInfo']) ?? ''),
          version: String(firstOf(record, ['version']) ?? ''),
          routeItudes: String(firstOf(record, ['routeItudes']) ?? ''),
          steps: Number(firstOf(record, ['steps', 'step', 'stepCount']) ?? NaN),
          startTime: String(firstOf(record, ['startTime', 'beginTime']) ?? ''),
          endTime: String(firstOf(record, ['endTime']) ?? ''),
          raw: record,
        });
      }
    }
    log(`已采样 ${records.size} 条记录（扫描到 ${date}）`);
  }

  const list = [...records.values()].sort((left, right) => String(right.date).localeCompare(String(left.date)));
  const detailed = [];
  if (options.detail && list.length) {
    for (const record of list.slice(0, options.detailLimit)) {
      await sleep(options.delayMs);
      let detail;
      try {
        detail = await post(PATHS.archDetail, { scoreId: record.recordId }, profile.token);
      } catch (error) {
        log(`记录 ${record.recordId} 存档轨迹查询失败: ${error.message}`);
        continue;
      }
      const body = detail?.body && typeof detail.body === 'object' ? detail.body : detail;
      const parsed = parseRouteItudes(record.routeItudes);
      const track = parsed.points.length
        ? parsed.points
        : toPoints(firstOf(body, ['pointList', 'points', 'polyline', 'sunrunPathPointList']) || []);
      const candidates = routes.filter(entry => entry.task.taskId === record.taskId);
      const matched = candidates.find(entry => String(entry.route.pointId) === record.routeId) || candidates[0];
      const item = {
        recordId: record.recordId,
        taskId: record.taskId,
        routeId: matched ? String(matched.route.pointId) : '',
        routeName: matched ? matched.route.pointName : '',
        routeVertexCount: matched ? toPoints(matched.route.pointList).length : 0,
        routeMeters: matched ? Number(distanceOfTrack(toPoints(matched.route.pointList)).toFixed(1)) : null,
        reportedKm: Number.isFinite(record.km) ? record.km : null,
        reportedFitDegree: Number.isFinite(record.fitDegree) ? record.fitDegree : null,
        reportedSteps: Number.isFinite(record.steps) ? record.steps : null,
        analysis: matched ? analyzeRealTrack(track, toPoints(matched.route.pointList)) : null,
        paceProfile: parsed.points.length ? describePaceProfile(parsed.points, parsed.seconds) : null,
        verdict: record.verdict,
        warnType: record.warnType,
        ifQualify: record.ifQualify,
        detailShape: body && typeof body === 'object' ? Object.keys(body) : null,
        ...(options.keepTracks ? { track } : {}),
      };
      await sleep(options.delayMs);
      try {
        const points = await post(PATHS.runPoints, { scantronId: record.recordId }, profile.token);
        item.runPointProgress = {
          allCount: firstOf(points, ['allCount']) ?? null,
          nullCount: firstOf(points, ['nullCount']) ?? null,
          alreadyCount: firstOf(points, ['alreadyCount']) ?? null,
        };
      } catch (error) {
        log(`记录 ${record.recordId} 打卡点进度查询失败: ${error.message}`);
      }
      detailed.push(item);
      log(`已测量存档轨迹 ${detailed.length} 条`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: MINIPROGRAM_BASE_URL,
    student: {
      stuNumber: options.redact ? '***' : profile.stuNumber,
      schoolCode: options.redact ? '***' : profile.schoolCode,
      campusId: options.redact ? '***' : profile.campusId,
      campusName: profile.campusName,
    },
    sampledDays: options.days,
    tasks: tasks.map(task => ({
      taskId: task.taskId,
      name: task.name,
      mileage: task.mileage,
      minTime: task.minTime,
      maxTime: task.maxTime,
      requiredFitDegree: task.fitDegree,
      offsetRange: task.offsetRange,
      runTimeRuleCount: (task.runTimeRuleList || []).length,
      routes: (task.runPointList || []).map(route => ({
        pointId: route.pointId,
        pointName: route.pointName,
        vertexCount: toPoints(route.pointList).length,
        routeMeters: Number(distanceOfTrack(toPoints(route.pointList)).toFixed(1)),
      })),
    })),
    papersResponseKeys: paperList && typeof paperList === 'object' ? Object.keys(paperList) : null,
    recordCount: list.length,
    records: list.map(record => ({
      date: record.date,
      recordId: record.recordId,
      taskId: record.taskId,
      routeId: record.routeId,
      km: Number.isFinite(record.km) ? record.km : null,
      usedTime: record.usedTime,
      usedSeconds: parseDurationSeconds(record.usedTime),
      fitDegree: Number.isFinite(record.fitDegree) ? record.fitDegree : null,
      positionDivation: Number.isFinite(record.positionDivation) ? record.positionDivation : null,
      avgPace: Number.isFinite(record.avgPace) ? record.avgPace : null,
      warnFlag: record.warnFlag,
      warnType: record.warnType,
      verdict: record.verdict,
      ifQualify: record.ifQualify,
      phoneInfo: record.phoneInfo,
      version: record.version,
      steps: Number.isFinite(record.steps) ? record.steps : null,
      startTime: record.startTime,
      endTime: record.endTime,
    })),
    firstRecordShape: list.length ? list[0].raw : null,
    summary: {
      reportedFitDegree: describe(list.map(record => record.fitDegree)),
      km: describe(list.map(record => record.km)),
      steps: describe(list.map(record => record.steps)),
      // 真实里程相对任务里程的倍率，用于标定 DISTANCE_GAIN_BAND
      reportedKmOverTask: describe(list.map(record => record.km / taskMileage.get(record.taskId))),
      // 真实用时占任务最慢用时（maxTime）的比例，用于标定 SLOW_PACE_BAND
      durationOverMaxTime: describe(list.map(record => {
        const seconds = parseDurationSeconds(record.usedTime);
        const maxSeconds = taskMaxSeconds.get(record.taskId);
        return seconds && maxSeconds ? seconds / maxSeconds : NaN;
      })),
      // 存档轨迹的几何长度与上报里程的比值，用于判断上报里程是否与轨迹自洽
      trackVsReportedKm: describe(detailed.map(item => (
        item.analysis && item.reportedKm ? item.analysis.trackMeters / (item.reportedKm * 1000) : NaN
      ))),
      recomputedFitDegree: describe(detailed.map(item => Number(item.analysis?.recomputedFitDegree))),
      trackMeters: describe(detailed.map(item => item.analysis?.trackMeters)),
      distanceToRouteMax: describe(detailed.map(item => item.analysis?.distanceToRoute.max)),
      distanceToRouteP90: describe(detailed.map(item => item.analysis?.distanceToRoute.p90)),
      over25Ratio: describe(detailed.map(item => item.analysis?.distanceToRoute.over25Ratio)),
      vertexPassageMax: describe(detailed.map(item => item.analysis?.vertexPassage.max)),
      // 采样节奏：用于标定每秒点数、相邻间距与隐含速度
      sampleGapSeconds: describe(detailed.map(item => item.paceProfile?.gapSeconds.median)),
      sampleSpacingMeters: describe(detailed.map(item => item.paceProfile?.spacing.median)),
      impliedSpeedMedian: describe(detailed.map(item => item.paceProfile?.impliedSpeed.median)),
      impliedSpeedMax: describe(detailed.map(item => item.paceProfile?.impliedSpeed.max)),
    },
    detail: detailed,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.token) {
    console.error('缺少 Token：设置 TOTORO_TOKEN 环境变量或使用 --token。');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const report = await sampleRealRuns(options, {
    log: message => { if (!options.jsonOnly) console.error(message); },
  });

  if (!options.jsonOnly) {
    console.error('\n采样摘要：');
    for (const [name, value] of Object.entries(report.summary)) {
      console.error(`  ${name}: ${value ? JSON.stringify(value) : '(无数据)'}`);
    }
    console.error('\n下方 JSON 整段贴回即可用于标定参数：\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error(`采样失败: ${error.message}`);
    process.exitCode = 1;
  });
}
