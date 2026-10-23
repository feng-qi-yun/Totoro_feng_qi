// 从真实跑步记录里推导「真实跑步线」：按圈相位折叠 + 等弧长采样。
// 纯计算、不碰文件系统，供 scripts/derive-running-line.js 与界面导入接口共用。
import { haversineDistance } from './run-data.js';

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
