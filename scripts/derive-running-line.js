#!/usr/bin/env node
// 从真实跑步记录里导出「真实跑步线」：按圈相位折叠 + 等弧长采样，得到一条干净闭合线。
//
// 用途：小程序里的官方路线折线往往只是操场/区域的边界，跟人实际跑的跑道不是同一条线
// （例：天目湖西操场官方折线 572.7 米、实际跑的椭圆跑道 469.8 米，两者相差 10~27 米）。
// 用真实记录导出跑步线后，生成轨迹就能沿着正常人跑的那条线走。
//
// 只读本地文件，不联网。
import fs from 'node:fs';
import path from 'node:path';
import { haversineDistance } from '../lib/server/run-data.js';

const DEFAULT_INPUT_DIR = path.join(process.cwd(), 'local-data');
const FOLD_BINS = 90;
// 折叠质量：每个采样点到所属相位桶中心的平均距离（米）
function foldSpread(points, cumulative, lapMeters) {
  const buckets = Array.from({ length: FOLD_BINS }, () => ({ count: 0, latitude: 0, longitude: 0 }));
  const bucketOf = distance => Math.min(
    FOLD_BINS - 1,
    Math.floor((((distance % lapMeters) + lapMeters) % lapMeters) / lapMeters * FOLD_BINS),
  );
  for (let index = 0; index < points.length; index += 1) {
    const bucket = buckets[bucketOf(cumulative[index])];
    bucket.count += 1;
    bucket.latitude += points[index].latitude;
    bucket.longitude += points[index].longitude;
  }
  if (buckets.some(bucket => bucket.count === 0)) return { spread: Infinity, centers: [] };
  const centers = buckets.map(bucket => ({
    latitude: bucket.latitude / bucket.count,
    longitude: bucket.longitude / bucket.count,
  }));
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    total += haversineDistance(points[index], centers[bucketOf(cumulative[index])]);
  }
  return { spread: total / points.length, centers };
}

export function findLapMeters(points, { min = 200, max = 1200, step = 0.25 } = {}) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversineDistance(points[index - 1], points[index]));
  }
  let best = null;
  for (let lap = min; lap <= max; lap += step) {
    const { spread, centers } = foldSpread(points, cumulative, lap);
    if (centers.length && (!best || spread < best.spread)) best = { lapMeters: lap, spread, centers };
  }
  return { ...best, cumulative, totalMeters: cumulative.at(-1) };
}

// 沿闭合折线按等弧长取 count 个点
export function sampleLoop(centers, count) {
  const closed = [...centers, centers[0]];
  const cumulative = [0];
  for (let index = 1; index < closed.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversineDistance(closed[index - 1], closed[index]));
  }
  const total = cumulative.at(-1);
  const result = [];
  let cursor = 1;
  for (let index = 0; index < count; index += 1) {
    const target = total * index / count;
    while (cursor < closed.length - 1 && cumulative[cursor] < target) cursor += 1;
    const previousDistance = cumulative[cursor - 1];
    const segment = cumulative[cursor] - previousDistance || 1;
    const ratio = Math.min(1, Math.max(0, (target - previousDistance) / segment));
    const start = closed[cursor - 1];
    const end = closed[cursor];
    result.push({
      longitude: Number((start.longitude + (end.longitude - start.longitude) * ratio).toFixed(6)),
      latitude: Number((start.latitude + (end.latitude - start.latitude) * ratio).toFixed(6)),
    });
  }
  return { pointList: result, meters: total };
}

export function deriveRunningLine(track, { spacingMeters = 15 } = {}) {
  const points = track.map(point => ({
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
  })).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  if (points.length < 60) throw new Error('轨迹点太少，无法导出跑步线');
  const best = findLapMeters(points);
  if (!best || !Number.isFinite(best.spread)) throw new Error('未能推断出圈长，请检查轨迹是否包含完整圈');
  const count = Math.max(4, Math.round(best.lapMeters / spacingMeters));
  const { pointList, meters } = sampleLoop(best.centers, count);
  return {
    lapMeters: Number(best.lapMeters.toFixed(1)),
    foldSpreadMeters: Number(best.spread.toFixed(2)),
    laps: Number((best.totalMeters / best.lapMeters).toFixed(2)),
    meters: Number(meters.toFixed(1)),
    spacingMeters: Number((meters / count).toFixed(2)),
    pointList,
  };
}

function parseArgs(argv) {
  const options = { input: '', recordId: '', spacingMeters: 15, outDir: path.join(DEFAULT_INPUT_DIR, 'derived-routes'), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--record') { options.recordId = value || ''; index += 1; }
    else if (arg === '--spacing') { options.spacingMeters = Math.max(5, Number(value) || 15); index += 1; }
    else if (arg === '--out') { options.outDir = value || options.outDir; index += 1; }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!options.input) options.input = arg;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    console.log(`用法：node scripts/derive-running-line.js <采样结果.json> [--record <记录ID>] [--spacing 15] [--out 目录]

输入是 scripts/sample-real-runs.js --detail --keep-tracks 的产物（含真实轨迹）。
输出 local-data/derived-routes/<路线ID>.json，生成轨迹时会沿这条真实跑步线走。`);
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  const entries = (report.detail || []).filter(item => Array.isArray(item.track) && item.track.length > 1);
  const targets = options.recordId ? entries.filter(item => String(item.recordId) === options.recordId) : entries;
  if (!targets.length) throw new Error('输入文件里没有带轨迹的记录（采样时请加 --keep-tracks）');

  fs.mkdirSync(options.outDir, { recursive: true });
  for (const item of targets) {
    const derived = deriveRunningLine(item.track, { spacingMeters: options.spacingMeters });
    const file = path.join(options.outDir, `${item.routeId}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      derivedFrom: item.recordId,
      routeId: item.routeId,
      routeName: item.routeName,
      generatedAt: new Date().toISOString(),
      ...derived,
    }, null, 1)}\n`);
    console.log(`${item.routeName}（${item.routeId}）`);
    console.log(`  圈长 ${derived.lapMeters}m（折叠散度 ${derived.foldSpreadMeters}m，${derived.laps} 圈）`
      + ` → ${derived.pointList.length} 点 / 每点约 ${derived.spacingMeters}m`);
    console.log(`  已写入 ${path.relative(process.cwd(), file)}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(`导出失败: ${error.message}`);
    process.exitCode = 1;
  }
}
