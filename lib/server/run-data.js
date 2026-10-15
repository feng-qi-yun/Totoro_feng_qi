const EARTH_RADIUS_METERS = 6371000;
// 仅在没有给出每秒步长时兜底；正常路径使用 实测里程 / 用时
const ROUTE_SPACING_METERS = Object.freeze({ min: 8, max: 12 });
const TRACK_JITTER_STD_METERS = 2;
// 抖动为 AR(1) 相关噪声：GPS 误差在相邻定位点之间高度相关，不会每一步都跳满
const TRACK_JITTER_CORRELATION = 0.7;
const TRACK_JITTER_INNOVATION = 0.45;
// 相邻采样点之间抖动向量的最大变化量（米）
const TRACK_JITTER_STEP_METERS = 2;
const STRIDE_METERS = Object.freeze({ min: 0.7, max: 0.86 });
const METERS_PER_LATITUDE_DEGREE = 111320;
const ROUTE_ONE_FALLBACK_POINTS = Object.freeze([
  { longitude: 118.789377, latitude: 31.939196 },
  { longitude: 118.789678, latitude: 31.93925 },
  { longitude: 118.790021, latitude: 31.939232 },
  { longitude: 118.790257, latitude: 31.939123 },
  { longitude: 118.790922, latitude: 31.938559 },
  { longitude: 118.791201, latitude: 31.937703 },
  { longitude: 118.791716, latitude: 31.935809 },
  { longitude: 118.792038, latitude: 31.93468 },
  { longitude: 118.789785, latitude: 31.934225 },
  { longitude: 118.78897, latitude: 31.935791 },
  { longitude: 118.788262, latitude: 31.937065 },
  { longitude: 118.788176, latitude: 31.93814 },
  { longitude: 118.788648, latitude: 31.938832 },
  { longitude: 118.789442, latitude: 31.939214 },
].map(point => Object.freeze(point)));

// 提交轨迹与官方路线的拟合度目标区间（官方算法：5 米采样、25 米阈值）
// 真实记录实测：沿跑道跑 0.98（离路线 p50 10.4m、超 25m 占比 1.9%）
export const FIT_DEGREE_BAND = Object.freeze({ min: 0.95, max: 0.99 });
// 实测里程相对任务里程的倍率：真实 GPS 累计一定偏多，不允许恰好等于任务里程
export const DISTANCE_GAIN_BAND = Object.freeze({ min: 1.01, max: 1.06 });
// 用时占任务最慢用时（maxTime，即最慢配速）的比例区间：真实记录几乎都贴着上限
export const SLOW_PACE_BAND = Object.freeze({ min: 0.70, max: 0.95 });
// 横向偏离参数：真实轨迹是"整条偏路线一侧若干米并缓慢游走"，不是对称鼓包
const FIT_DEVIATION = Object.freeze({
  anchors: 8,              // 低频漂移的锚点数量（沿轨迹等分，余弦插值）
  walkStep: 0.5,           // 相邻锚点的最大变化量（归一化）
  bias: 0.42,              // 固定偏置：真实轨迹几乎不会回到路线上
  maxOffsetMeters: 40,     // 振幅上限，低于客户端 50 米偏离告警
  fieldAttempts: 10,
  searchSteps: 18,
  toleranceHundredths: 1,
});
// 相邻采样点之间横向位移的最大变化量（米）
const MAX_LATERAL_STEP_METERS = 2;
// 基础轨迹相对计划实测长度的余量：偏离可能缩短轨迹，留余量才能裁到目标长度
const BASE_LENGTH_MARGINS = [1.03, 1.08];
// 六位小数约 0.11 米，比这更短的段会退化成零长度
const MIN_TRACK_SEGMENT_METERS = 0.2;

const pad = value => String(value).padStart(2, '0');
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const randomBetween = (min, max) => min + (max - min) * Math.random();

// 学校按记录保存 phoneInfo，所以默认使用账号真实在用的设备，避免机型与历史记录不一致
export const DEFAULT_DEVICE_PROFILE = Object.freeze({
  brand: 'Redmi', model: '2602BRT18C', system: 'Android 16', version: '8.0.76',
});

export const REAL_DEVICE_PROFILES = Object.freeze([
  DEFAULT_DEVICE_PROFILE,
  { brand: 'iPhone', model: 'iPhone 16 Pro Max<iPhone17,2>', system: 'iOS 26.2.1', version: '8.0.75' },
  { brand: 'iPhone', model: 'iPhone 14 Pro<iPhone15,2>', system: 'iOS 18.5.0', version: '8.0.74' },
  { brand: 'Xiaomi', model: '23049RAD8C', system: 'Android 15', version: '8.0.76' },
  { brand: 'vivo', model: 'V2307A', system: 'Android 15', version: '8.0.75' },
  { brand: 'HONOR', model: 'ANY-AN00', system: 'Android 14', version: '8.0.74' },
]);

export function defaultDeviceProfile() {
  const profile = DEFAULT_DEVICE_PROFILE;
  return {
    version: profile.version,
    phoneInfo: `${profile.brand}&${profile.model}&${profile.system}`,
    deviceModel: `${profile.brand} ${profile.model} (${profile.system})`,
  };
}

export function getRandomDeviceProfile() {
  const profile = REAL_DEVICE_PROFILES[Math.floor(Math.random() * REAL_DEVICE_PROFILES.length)];
  return {
    version: profile.version,
    phoneInfo: `${profile.brand}&${profile.model}&${profile.system}`,
    deviceModel: `${profile.brand} ${profile.model.split('<')[0]} (${profile.system})`,
  };
}

export function calculateRouteSimilarity(trackPoints, routePoints, sampleMeters = 5, thresholdMeters = 25) {
  if (!trackPoints || trackPoints.length < 2 || !routePoints || routePoints.length < 2) return 0;

  const haversine = (lat1, lon1, lat2, lon2) => {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  const pointToSegmentDist = (pLat, pLon, aLat, aLon, bLat, bLon) => {
    const latA = Number(aLat), lonA = Number(aLon);
    const latB = Number(bLat), lonB = Number(bLon);
    const dLat = latB - latA;
    const dLon = lonB - lonA;
    const lenSq = dLat * dLat + dLon * dLon;
    let u = lenSq !== 0 ? ((pLat - latA) * dLat + (pLon - lonA) * dLon) / lenSq : -1;
    let nearLat = latA, nearLon = lonA;
    if (u > 1) { nearLat = latB; nearLon = lonB; }
    else if (u > 0) { nearLat = latA + u * dLat; nearLon = lonA + u * dLon; }
    return haversine(pLat, pLon, nearLat, nearLon);
  };

  let matched = 0, total = 0;
  for (let c = 0; c < trackPoints.length - 1; c++) {
    const p1 = trackPoints[c], p2 = trackPoints[c + 1];
    const segDist = haversine(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
    const steps = Math.max(1, Math.ceil(segDist / sampleMeters));

    for (let g = 0; g < steps; g++) {
      const ratio = g / steps;
      const sLat = p1.latitude + (p2.latitude - p1.latitude) * ratio;
      const sLon = p1.longitude + (p2.longitude - p1.longitude) * ratio;
      let minDist = Infinity;

      for (let q = 0; q < routePoints.length - 1; q++) {
        const r1 = routePoints[q], r2 = routePoints[q + 1];
        const d = pointToSegmentDist(sLat, sLon, r1.latitude, r1.longitude, r2.latitude, r2.longitude);
        if (d < minDist) minDist = d;
        if (minDist <= thresholdMeters) break;
      }
      if (minDist <= thresholdMeters) matched++;
      total++;
    }
  }
  return total === 0 ? 0 : Number((matched / total).toFixed(2));
}

export function haversineDistance(pointA, pointB) {
  const lat1 = Number(pointA.latitude) * Math.PI / 180;
  const lat2 = Number(pointB.latitude) * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLng = (Number(pointB.longitude) - Number(pointA.longitude)) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function distanceOfTrack(points) {
  return points.slice(1).reduce((total, point, index) => total + haversineDistance(points[index], point), 0);
}

function normalizedRoute(route) {
  const raw = Array.isArray(route?.pointList) && route.pointList.length > 1
    ? route.pointList
    : [{ longitude: route?.longitude, latitude: route?.latitude }];
  const points = raw.map(point => ({
    longitude: number(point.longitude, NaN), latitude: number(point.latitude, NaN),
  }));
  if (points.length < 2 || points.some(point => !Number.isFinite(point.longitude) || !Number.isFinite(point.latitude))) {
    throw new Error('所选路线缺少可用的经纬度轨迹');
  }

  const closingDistance = haversineDistance(points.at(-1), points[0]);
  if (closingDistance <= 150) return [...points, points[0]];
  return [...points, ...points.slice(1, -1).reverse(), points[0]];
}

function interpolate(pointA, pointB, ratio) {
  return {
    longitude: pointA.longitude + (pointB.longitude - pointA.longitude) * ratio,
    latitude: pointA.latitude + (pointB.latitude - pointA.latitude) * ratio,
  };
}

function normalRandom(random) {
  let value;
  do {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const radius = x * x + y * y;
    value = radius > 0 && radius < 1 ? x * Math.sqrt(-2 * Math.log(radius) / radius) : NaN;
  } while (!Number.isFinite(value) || Math.abs(value) > 3);
  return value;
}

function randomizedLap(lap, random) {
  const route = lap.slice(0, -1);
  const segmentLengths = route.map((point, index) => (
    haversineDistance(point, route[(index + 1) % route.length])
  ));
  const totalMeters = segmentLengths.reduce((total, distance) => total + distance, 0);
  if (totalMeters < 1) throw new Error('所选路线轨迹长度不足');

  let offsetMeters = random() * totalMeters;
  let segmentIndex = 0;
  while (segmentIndex < segmentLengths.length - 1 && offsetMeters > segmentLengths[segmentIndex]) {
    offsetMeters -= segmentLengths[segmentIndex];
    segmentIndex += 1;
  }
  const nextIndex = (segmentIndex + 1) % route.length;
  const start = interpolate(
    route[segmentIndex],
    route[nextIndex],
    segmentLengths[segmentIndex] ? offsetMeters / segmentLengths[segmentIndex] : 0,
  );
  return [
    start,
    ...route.slice(segmentIndex + 1),
    ...route.slice(0, segmentIndex + 1),
    start,
  ];
}

// 抖动：AR(1) 相关噪声（相邻定位点的 GPS 误差高度相关），首尾与相邻步长都被限幅
function jitterTrack(points, random) {
  const result = [];
  let northMeters = 0;
  let eastMeters = 0;
  for (const point of points) {
    const nextNorth = northMeters * TRACK_JITTER_CORRELATION
      + normalRandom(random) * TRACK_JITTER_STD_METERS * TRACK_JITTER_INNOVATION;
    const nextEast = eastMeters * TRACK_JITTER_CORRELATION
      + normalRandom(random) * TRACK_JITTER_STD_METERS * TRACK_JITTER_INNOVATION;
    const deltaNorth = nextNorth - northMeters;
    const deltaEast = nextEast - eastMeters;
    const stepLength = Math.hypot(deltaNorth, deltaEast);
    const scale = stepLength > TRACK_JITTER_STEP_METERS ? TRACK_JITTER_STEP_METERS / stepLength : 1;
    northMeters += deltaNorth * scale;
    eastMeters += deltaEast * scale;
    const longitudeScale = METERS_PER_LATITUDE_DEGREE * Math.max(0.01, Math.cos(point.latitude * Math.PI / 180));
    result.push({
      latitude: point.latitude + northMeters / METERS_PER_LATITUDE_DEGREE,
      longitude: point.longitude + eastMeters / longitudeScale,
    });
  }
  return result;
}

function trimNaturalTrack(baseCoordinates, targetMeters, random) {
  const jittered = jitterTrack(baseCoordinates, random);
  const result = [jittered[0]];
  let distance = 0;
  for (const candidate of jittered.slice(1)) {
    const previous = result.at(-1);
    const segmentDistance = haversineDistance(previous, candidate);
    if (segmentDistance < 0.01) continue;
    const remaining = targetMeters - distance;
    if (segmentDistance >= remaining) {
      result.push(interpolate(previous, candidate, remaining / segmentDistance));
      return result;
    }
    result.push(candidate);
    distance += segmentDistance;
  }
  throw new Error('生成路线未达到目标里程');
}

function generateCoordinates(route, targetMeters, { naturalize = false, stepMeters } = {}) {
  // 真实记录是每秒一个定位点：步长 = 实测里程 / 用时
  const step = Number.isFinite(stepMeters) && stepMeters > 0 ? stepMeters : null;
  const random = Math.random;
  let lap = normalizedRoute(route);
  if (naturalize) lap = randomizedLap(lap, random);
  const result = [{ ...lap[0] }];
  let segmentIndex = 0;
  let current = { ...lap[0] };
  let remainingTarget = naturalize ? targetMeters * 1.25 + (step ?? ROUTE_SPACING_METERS.max) : targetMeters;

  while (remainingTarget > 0.01) {
    const segmentEnd = lap[segmentIndex + 1];
    const segmentDistance = haversineDistance(current, segmentEnd);
    if (segmentDistance < 0.01) {
      segmentIndex = (segmentIndex + 1) % (lap.length - 1);
      current = { ...lap[segmentIndex] };
      continue;
    }
    const movement = Math.min(
      step ?? randomBetween(ROUTE_SPACING_METERS.min, ROUTE_SPACING_METERS.max),
      segmentDistance,
      remainingTarget,
    );
    current = interpolate(current, segmentEnd, movement / segmentDistance);
    result.push(current);
    remainingTarget -= movement;
    if (movement >= segmentDistance - 0.01) {
      segmentIndex = (segmentIndex + 1) % (lap.length - 1);
      current = { ...lap[segmentIndex] };
    }
  }
  return naturalize ? trimNaturalTrack(result, targetMeters, random) : result;
}

function cumulativeDistances(points) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversineDistance(points[index - 1], points[index]));
  }
  return cumulative;
}

// 限制位移向量的逐步变化量，轨迹不会出现真实客户端会当作异常丢弃的跳跃
function limitDisplacementStep(vectors, maxStep) {
  const limited = [vectors[0]];
  for (let index = 1; index < vectors.length; index += 1) {
    const previous = limited[index - 1];
    const eastDelta = vectors[index].east - previous.east;
    const northDelta = vectors[index].north - previous.north;
    const length = Math.hypot(eastDelta, northDelta);
    if (length <= maxStep || length === 0) {
      limited.push(vectors[index]);
      continue;
    }
    const scale = maxStep / length;
    limited.push({
      east: previous.east + eastDelta * scale,
      north: previous.north + northDelta * scale,
    });
  }
  return limited;
}

// 左法线单位向量：方向取自较长基线并做移动平均。抖动后的轨迹逐点方向会乱摆，
// 直接用它当法线会让横向偏离也变成锯齿、白白拉长里程。
const NORMAL_BASELINE_SAMPLES = 4;
const NORMAL_SMOOTHING_SAMPLES = 2;

function movingAverage(values, radius) {
  return values.map((_, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(values.length - 1, index + radius);
    let sum = 0;
    for (let cursor = from; cursor <= to; cursor += 1) sum += values[cursor];
    return sum / (to - from + 1);
  });
}

function trackNormals(points) {
  const raw = points.map((point, index) => {
    const previous = points[Math.max(0, index - NORMAL_BASELINE_SAMPLES)];
    const next = points[Math.min(points.length - 1, index + NORMAL_BASELINE_SAMPLES)];
    const longitudeScale = METERS_PER_LATITUDE_DEGREE * Math.max(0.01, Math.cos(point.latitude * Math.PI / 180));
    const northSpan = (next.latitude - previous.latitude) * METERS_PER_LATITUDE_DEGREE;
    const eastSpan = (next.longitude - previous.longitude) * longitudeScale;
    const length = Math.hypot(northSpan, eastSpan) || 1;
    return { north: eastSpan / length, east: -northSpan / length };
  });
  const east = movingAverage(raw.map(normal => normal.east), NORMAL_SMOOTHING_SAMPLES);
  const north = movingAverage(raw.map(normal => normal.north), NORMAL_SMOOTHING_SAMPLES);
  return east.map((value, index) => {
    const length = Math.hypot(value, north[index]) || 1;
    return { east: value / length, north: north[index] / length };
  });
}

// 横向偏离场：整条轨迹偏路线一侧若干米并缓慢游走（对齐真实记录：
// 离路线 p50 10.4m、p90 20.1m、超 25m 占比 1.9%），而不是对称鼓包
function deviationField(points, random) {
  const walk = [randomBetween(-FIT_DEVIATION.walkStep, FIT_DEVIATION.walkStep)];
  for (let index = 1; index < FIT_DEVIATION.anchors; index += 1) {
    walk.push(Math.min(1, Math.max(-1, walk[index - 1] + randomBetween(
      -FIT_DEVIATION.walkStep, FIT_DEVIATION.walkStep,
    ))));
  }
  const sign = random() < 0.5 ? -1 : 1;
  const cumulative = cumulativeDistances(points);
  const total = cumulative.at(-1) || 1;
  const raw = points.map((_, index) => {
    const position = cumulative[index] / total * (FIT_DEVIATION.anchors - 1);
    const left = Math.min(FIT_DEVIATION.anchors - 2, Math.floor(position));
    const eased = 0.5 - Math.cos(Math.PI * (position - left)) / 2;
    const drift = walk[left] + (walk[left + 1] - walk[left]) * eased;
    return sign * FIT_DEVIATION.bias + drift * (1 - FIT_DEVIATION.bias);
  });
  const peak = Math.max(...raw.map(Math.abs)) || 1;
  return raw.map(value => value / peak);
}

function offsetTrack(points, field, normals, meters) {
  const vectors = points.map((point, index) => {
    const offset = meters * field[index];
    return { east: normals[index].east * offset, north: normals[index].north * offset };
  });
  const limited = limitDisplacementStep(vectors, MAX_LATERAL_STEP_METERS);
  return points.map((point, index) => {
    const longitudeScale = METERS_PER_LATITUDE_DEGREE * Math.max(0.01, Math.cos(point.latitude * Math.PI / 180));
    return {
      latitude: point.latitude + limited[index].north / METERS_PER_LATITUDE_DEGREE,
      longitude: point.longitude + limited[index].east / longitudeScale,
    };
  });
}

function roundTrack(points) {
  const rounded = [];
  for (const point of points) {
    const next = {
      latitude: Number(point.latitude.toFixed(6)),
      longitude: Number(point.longitude.toFixed(6)),
    };
    if (!rounded.length || haversineDistance(rounded.at(-1), next) > MIN_TRACK_SEGMENT_METERS) rounded.push(next);
  }
  return rounded;
}

// 沿折线累计里程裁到精确长度：让上报里程与提交轨迹的实测长度完全一致。
// 末尾不足 0.2 米的一段会被六位小数取整压成零长度，直接不追加。
function trimToLength(points, targetMeters) {
  const result = [points[0]];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = result.at(-1);
    const segment = haversineDistance(previous, points[index]);
    if (segment < MIN_TRACK_SEGMENT_METERS) continue;
    const remaining = targetMeters - total;
    if (remaining <= MIN_TRACK_SEGMENT_METERS) return result;
    if (segment >= remaining) {
      const cut = interpolate(previous, points[index], Math.max(0, remaining / segment));
      result.push({
        latitude: Number(cut.latitude.toFixed(6)),
        longitude: Number(cut.longitude.toFixed(6)),
      });
      return result;
    }
    result.push(points[index]);
    total += segment;
  }
  return result;
}

export function fitDegreeOf(pointList, routePoints) {
  return Number(calculateRouteSimilarity(pointList, routePoints)).toFixed(2);
}

function fitHundredths(pointList, routePoints) {
  return Math.round(Number(fitDegreeOf(pointList, routePoints)) * 100);
}

function closerFit(best, hundredths, pointList, target) {
  if (best && Math.abs(best.hundredths - target) <= Math.abs(hundredths - target)) return best;
  return { hundredths, pointList };
}

function calibrateField(coordinates, routePoints, target, random, normals, measuredMeters) {
  let best = null;
  for (let attempt = 0; attempt < FIT_DEVIATION.fieldAttempts && best?.hundredths !== target; attempt += 1) {
    const field = deviationField(coordinates, random);
    const at = meters => trimToLength(
      roundTrack(offsetTrack(coordinates, field, normals, meters)), measuredMeters,
    );
    // 这个场形在振幅上限内达不到目标，换一个场形
    if (fitHundredths(at(FIT_DEVIATION.maxOffsetMeters), routePoints) > target) continue;
    let low = 0;
    let high = FIT_DEVIATION.maxOffsetMeters;
    for (let step = 0; step < FIT_DEVIATION.searchSteps; step += 1) {
      const meters = (low + high) / 2;
      const pointList = at(meters);
      const hundredths = fitHundredths(pointList, routePoints);
      best = closerFit(best, hundredths, pointList, target);
      if (hundredths === target) break;
      if (hundredths > target) low = meters; else high = meters;
    }
  }
  return best;
}

// 二分标定横向偏离幅度，使官方算法在提交点位上重算出的拟合度等于目标值
export function calibrateFitTrack(coordinates, routePoints, fitTarget, options = {}) {
  const random = options.random || Math.random;
  const measuredMeters = options.measuredMeters ?? Infinity;
  const target = Math.round(fitTarget * 100);
  const best = calibrateField(
    coordinates, routePoints, target, random, trackNormals(coordinates), measuredMeters,
  );
  if (!best) return null;
  return { pointList: best.pointList, fitDegree: (best.hundredths / 100).toFixed(2) };
}

function plainTrack(route, measuredMeters, naturalize, routePoints, stepMeters) {
  const pointList = trimToLength(
    roundTrack(generateCoordinates(route, measuredMeters, { naturalize, stepMeters })), measuredMeters,
  );
  return { pointList, fitDegree: fitDegreeOf(pointList, routePoints) };
}

// 抖动与横向偏离会拉长实测里程、使裁剪吃掉点数：先按首遍走线测出膨胀率并反向修正步长
function correctedStepMeters(route, measuredMeters, durationSeconds, naturalize, stepMeters) {
  const walk = generateCoordinates(route, measuredMeters, { naturalize, stepMeters });
  const intendedSteps = Math.max(1, Math.round(measuredMeters / stepMeters));
  const actualSteps = Math.max(1, walk.length - 1);
  return stepMeters * actualSteps / intendedSteps;
}

function buildTrack({ route, measuredMeters, naturalize, fitTarget, deviate, stepMeters }) {
  const routePoints = Array.isArray(route?.pointList) ? route.pointList : [];
  if (!deviate || routePoints.length < 2) {
    return plainTrack(route, measuredMeters, naturalize, routePoints, stepMeters);
  }
  // 横向偏离在极端几何下会缩短轨迹：基础轨迹留出余量并逐级加长，保证仍能裁到计划的实测长度
  for (const margin of BASE_LENGTH_MARGINS) {
    const coordinates = generateCoordinates(route, measuredMeters * margin, { naturalize, stepMeters });
    const calibrated = calibrateFitTrack(coordinates, routePoints, fitTarget, { measuredMeters });
    if (calibrated && distanceOfTrack(calibrated.pointList) >= measuredMeters - 0.5) return calibrated;
  }
  return plainTrack(route, measuredMeters, naturalize, routePoints, stepMeters);
}

// 真实记录的时间戳是整秒、严格等间隔（相邻时间差中位 1 秒）
function generateTimestamps(start, durationSeconds, pointCount) {
  const startTimestamp = start.getTime();
  const totalMilliseconds = durationSeconds * 1000;
  const intervalCount = Math.max(1, pointCount - 1);
  return Array.from({ length: pointCount }, (_, index) => (
    index === intervalCount
      ? startTimestamp + totalMilliseconds
      : startTimestamp + Math.round(index * totalMilliseconds / intervalCount)
  ));
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`;
}

// 与小程序 calSpeed 一致：先取每公里分钟数，再对分钟和秒分别向下取整
function formatPace(seconds, km) {
  if (!(km > 0)) return `0'00"`;
  const minutes = seconds / 60 / km;
  const wholeMinutes = Math.floor(minutes);
  return `${wholeMinutes}'${pad(Math.floor((minutes - wholeMinutes) * 60))}"`;
}

// 里程/用时/配速/步数都由实测里程派生，保证与提交轨迹自洽
function trackMetrics(measuredMeters, durationSeconds, strideMeters) {
  const km = measuredMeters / 1000;
  return {
    km: km.toFixed(2),
    usedTime: formatDuration(durationSeconds),
    avgSpeed: formatPace(durationSeconds, km),
    steps: String(Math.round(measuredMeters / strideMeters)),
  };
}

function normalizeRunPlan(task, plan) {
  const requestedKm = Math.max(0.2, number(task?.mileage, 3.2));
  const minSeconds = Math.max(60, Math.round(number(task?.minTime, 10) * 60));
  const maxSeconds = Math.max(minSeconds, Math.round(number(task?.maxTime, 25) * 60));
  const targetMeters = number(plan?.targetMeters, NaN);
  const measuredMeters = number(plan?.measuredMeters, NaN);
  const durationSeconds = number(plan?.durationSeconds, NaN);
  const strideMeters = number(plan?.strideMeters, NaN);
  const fitTarget = number(plan?.fitTarget, NaN);
  const device = plan?.device ? {
    version: String(plan.device.version),
    phoneInfo: String(plan.device.phoneInfo),
    deviceModel: String(plan.device.deviceModel || plan.device.phoneInfo),
  } : defaultDeviceProfile();

  if (Math.abs(targetMeters - requestedKm * 1000) > 0.01
    || !Number.isFinite(measuredMeters) || measuredMeters < targetMeters * DISTANCE_GAIN_BAND.min
    || measuredMeters > targetMeters * DISTANCE_GAIN_BAND.max
    || Number((measuredMeters / 1000).toFixed(2)) !== measuredMeters / 1000
    || !Number.isSafeInteger(durationSeconds) || durationSeconds < minSeconds || durationSeconds > maxSeconds
    || strideMeters < STRIDE_METERS.min || strideMeters > STRIDE_METERS.max
    || !Number.isFinite(fitTarget) || Number(fitTarget.toFixed(2)) !== fitTarget
    || fitTarget < FIT_DEGREE_BAND.min || fitTarget > FIT_DEGREE_BAND.max) {
    throw new Error('跑步预览数据无效');
  }
  return { targetMeters, measuredMeters, durationSeconds, strideMeters, fitTarget, device };
}

export function createRunPlan(task, options = {}) {
  const requestedKm = Math.max(0.2, number(task?.mileage, 3.2));
  const minSeconds = Math.max(60, Math.round(number(task?.minTime, 10) * 60));
  const maxSeconds = Math.max(minSeconds, Math.round(number(task?.maxTime, 25) * 60));
  // 用时取自任务允许区间与"最慢用时 70%~95%"的交集：既不越界，也不会在 minTime 上堆出尖峰
  const slowLower = Math.max(minSeconds, maxSeconds * SLOW_PACE_BAND.min);
  const slowUpper = Math.min(maxSeconds, maxSeconds * SLOW_PACE_BAND.max);
  const durationSeconds = Math.round(slowUpper >= slowLower
    ? randomBetween(slowLower, slowUpper)
    : randomBetween(minSeconds, maxSeconds));
  const device = options.device || defaultDeviceProfile();

  return {
    targetMeters: requestedKm * 1000,
    measuredMeters: Math.round(randomBetween(
      Math.ceil(requestedKm * DISTANCE_GAIN_BAND.min * 100) / 100,
      Math.floor(requestedKm * DISTANCE_GAIN_BAND.max * 100) / 100,
    ) * 100) * 10,
    durationSeconds,
    strideMeters: randomBetween(STRIDE_METERS.min, STRIDE_METERS.max),
    // 目标值两端各留 0.01 余量：标定允许最后一位舍入差，舍入后仍落在 FIT_DEGREE_BAND 内
    fitTarget: Number(randomBetween(
      FIT_DEGREE_BAND.min + 0.01,
      FIT_DEGREE_BAND.max - 0.01,
    ).toFixed(2)),
    device,
  };
}

export function summarizeRunPlan({ task, route, plan }) {
  const normalized = normalizeRunPlan(task, plan);
  const hasRoute = Array.isArray(route?.pointList) && route.pointList.length > 1;
  return {
    routeName: route?.pointName || route?.pointId || '无固定路线',
    ...trackMetrics(normalized.measuredMeters, normalized.durationSeconds, normalized.strideMeters),
    deviceModel: normalized.device?.deviceModel || 'iPhone 14 Pro (iOS 17.5.1)',
    fitDegree: hasRoute ? normalized.fitTarget.toFixed(2) : '0.00',
  };
}

export function buildRunFixture({ task, route, identity, now = new Date(), naturalize = true }, options = {}) {
  if (!task?.taskId) throw new Error('缺少跑步任务');
  if (!route?.pointId) throw new Error('当前任务未配置跑步路线');
  const plan = normalizeRunPlan(task, options.plan || createRunPlan(task));
  const { durationSeconds, device } = plan;
  const summary = summarizeRunPlan({ task, route, plan });
  const start = new Date(now);
  const end = new Date(start.getTime() + durationSeconds * 1000);
  const { pointList: roundedCoordinates, fitDegree } = buildTrack({
    route,
    measuredMeters: plan.measuredMeters,
    // 每秒一个定位点：步长取实测里程 / 用时，再按抖动膨胀反向修正
    stepMeters: correctedStepMeters(
      route, plan.measuredMeters, durationSeconds, naturalize, plan.measuredMeters / durationSeconds,
    ),
    naturalize,
    fitTarget: plan.fitTarget,
    deviate: options.deviateRouteFit !== false,
  });
  // 轨迹已被裁到与计划的实测长度相差厘米级，因此里程/配速/步数统一由计划长度派生：
  // 预览、摘要与提交三者完全一致，绝不直接写任务里程
  const metrics = trackMetrics(plan.measuredMeters, durationSeconds, plan.strideMeters);
  const timestamps = generateTimestamps(start, durationSeconds, roundedCoordinates.length);
  const pointList = roundedCoordinates.map((point, index) => {
    const timestamp = timestamps[index];
    return {
      ...point,
      time: formatDateTime(new Date(timestamp)),
      timestamp,
    };
  });
  const token = identity?.token || '';
  const version = identity?.version || device?.version || '8.0.50';
  const phoneInfo = identity?.phoneInfo || device?.phoneInfo || 'iPhone&iPhone 14 Pro<iPhone15,2>&iOS 17.5.1';

  return {
    begin: {
      runType: 0, version, phoneInfo, paperId: task.taskId, lineId: route.pointId, faceBase64: '',
    },
    exercise: {
      scantronId: '', stuNumber: String(identity?.stuNumber || ''), schoolCode: String(identity?.schoolCode || ''),
      runType: 0, km: metrics.km, usedTime: metrics.usedTime,
      fitDegree, avgSpeed: metrics.avgSpeed,
      steps: metrics.steps, token, version, phoneInfo,
      evaluateDate: formatDate(start), endTime: formatTime(end), startTime: formatTime(start),
      taskId: task.taskId, sunrunPathPointList: route.pointList, flag: '1',
    },
    detail: {
      pointList, gyroscope: [], accelerometer: [], cheatCode: '正常跑步',
      stopReason: '', offsiteDistance: 0, forceStop: '0',
      scantronId: '', token,
    },
    summary: {
      taskName: task.name || task.taskId, ...summary, ...metrics,
      fitDegree,
      pointCount: pointList.length, startTime: formatTime(start), endTime: formatTime(end),
    },
  };
}

export function buildRouteFreeFixture({ task, identity, now = new Date() }, options = {}) {
  const generatedRoute = {
    pointId: 'route-free',
    pointName: '无固定路线',
    pointList: ROUTE_ONE_FALLBACK_POINTS,
  };
  const fixture = buildRunFixture({ task, route: generatedRoute, identity, now, naturalize: false }, { ...options, deviateRouteFit: false });

  return {
    ...fixture,
    begin: { ...fixture.begin, lineId: '' },
    exercise: { ...fixture.exercise, fitDegree: '0.00', sunrunPathPointList: [] },
    summary: { ...fixture.summary, routeName: '无固定路线', fitDegree: '0.00' },
  };
}
