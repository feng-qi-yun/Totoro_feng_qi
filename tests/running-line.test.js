import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildRunFixture, calculateRouteSimilarity, createRunPlan, haversineDistance } from '../lib/server/run-data.js';
import { loadRunningLine, withRunningLine } from '../lib/server/running-lines.js';
import { pointToPolylineDistance } from '../scripts/sample-real-runs.js';
import { deriveRunningLine, findLapMeters } from '../scripts/derive-running-line.js';

const LAT = 31.3727;
const LON = 119.4806;
const METERS_PER_DEGREE = 111320;
const METERS_PER_LON = METERS_PER_DEGREE * Math.cos(LAT * Math.PI / 180);

function point(northMeters, eastMeters) {
  return {
    latitude: LAT + northMeters / METERS_PER_DEGREE,
    longitude: LON + eastMeters / METERS_PER_LON,
  };
}

// 一个 100m × 170m 的操场椭圆（周长约 430m），带轻微 GPS 抖动
function stadiumLap({ laps = 3, samples = 900 } = {}) {
  const total = Math.round(samples * laps);
  const track = [];
  const a = 85;   // 半长轴（南北）
  const b = 50;   // 半短轴（东西）
  const lapMeters = 2 * Math.PI * Math.sqrt((a * a + b * b) / 2);
  for (let index = 0; index < total; index += 1) {
    const progress = index / samples * laps;
    const angle = progress * 2 * Math.PI;
    track.push({
      latitude: LAT + (a * Math.cos(angle)) / METERS_PER_DEGREE,
      longitude: LON + (b * Math.sin(angle)) / METERS_PER_LON,
    });
  }
  return { track, lapMeters };
}

function tempDir() {
  const dir = path.join(import.meta.dirname, '..', 'local-data', `test-lines-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('lap length is recovered by phase folding', () => {
  const { track, lapMeters } = stadiumLap();
  const best = findLapMeters(track, { min: 200, max: 800 });
  assert.ok(Math.abs(best.lapMeters - lapMeters) / lapMeters < 0.02,
    `推断圈长 ${best.lapMeters} vs 实际 ${lapMeters.toFixed(1)}`);
  assert.ok(best.spread < 5, `折叠散度 ${best.spread}`);
  // 圈长明显错时折叠散度会爆炸
  const wrong = findLapMeters(track, { min: lapMeters * 0.6, max: lapMeters * 0.65 });
  assert.ok(wrong.spread > best.spread * 2);
});

test('equal-arc sampling returns a closed equidistant loop', () => {
  const { track, lapMeters } = stadiumLap();
  const derived = deriveRunningLine(track, { spacingMeters: 15 });
  assert.ok(Math.abs(derived.lapMeters - lapMeters) / lapMeters < 0.02);
  assert.ok(derived.pointList.length > 20);
  const spacings = derived.pointList.map((item, index) => (
    haversineDistance(item, derived.pointList[(index + 1) % derived.pointList.length])
  ));
  const average = spacings.reduce((total, value) => total + value, 0) / spacings.length;
  assert.ok(spacings.every(value => Math.abs(value - average) < 0.6), '相邻采样点应等距');
  assert.ok(Math.abs(derived.meters - lapMeters) / lapMeters < 0.05, '闭合长度应与圈长一致');
});

test('sampling a too-short track is refused', () => {
  assert.throws(() => deriveRunningLine([point(0, 0), point(10, 0)]), /轨迹点太少/);
});

test('running lines are loaded from local files with a cache', () => {
  const dir = tempDir();
  const routeId = 'sunrunLine-test';
  assert.equal(loadRunningLine(routeId, { dir }), null);
  const line = [point(0, 0), point(0, 40), point(40, 40), point(40, 0)];
  fs.writeFileSync(path.join(dir, `${routeId}.json`), JSON.stringify({ pointList: line }));
  assert.deepEqual(loadRunningLine(routeId, { dir }), line);
  assert.equal(loadRunningLine('', { dir }), null);
  const attached = withRunningLine({ pointId: routeId, pointList: [{ latitude: 1, longitude: 1 }] }, { dir });
  assert.deepEqual(attached.runningLine, line);
  assert.equal(attached.pointList.length, 1, '官方折线保持不变');
  assert.equal(withRunningLine({ pointId: 'missing-line', pointList: [] }, { dir }).runningLine, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generation walks the running line while fit stays measured against the official route', () => {
  // 官方路线是 400×400 的方形边界，真实跑步线在它内侧 12 米
  const official = [point(0, 0), point(0, 400), point(400, 400), point(400, 0)];
  const runningLine = [point(12, 12), point(12, 388), point(388, 388), point(388, 12)];
  const task = { taskId: 'paper-line', mileage: '1.00', minTime: '10', maxTime: '25' };
  const identity = { token: 't', stuNumber: '1', schoolCode: '1' };
  const route = { pointId: 'line', pointName: '操场', pointList: official, runningLine };

  // 1) 关掉横向偏离时，轨迹应当贴着跑步线走（不是顺着官方方形边界）
  const plain = buildRunFixture({ task, route, identity }, {
    plan: createRunPlan(task), deviateRouteFit: false,
  });
  const toLine = plain.detail.pointList.map(item => pointToPolylineDistance(item, runningLine));
  const toOfficial = plain.detail.pointList.map(item => pointToPolylineDistance(item, official));
  // GPS 抖动本身有 ±3 米量级，阈值放到能区分「贴跑步线」与「顺官方折线」即可
  assert.ok(Math.max(...toLine) < 6, `轨迹应贴着跑步线，最远 ${Math.max(...toLine).toFixed(1)}m`);
  assert.ok(Math.min(...toOfficial) > 5, `轨迹不应顺着官方折线走，最近 ${Math.min(...toOfficial).toFixed(1)}m`);
  // 贴着跑步线时对官方路线的拟合度接近 1（12 米偏移远小于 25 米阈值）
  assert.equal(plain.exercise.fitDegree,
    Number(calculateRouteSimilarity(plain.detail.pointList, official)).toFixed(2));

  // 2) 默认（带标定）时拟合度落在目标区间，且上报值等于按官方折线重算的结果
  for (let sample = 0; sample < 5; sample += 1) {
    const fixture = buildRunFixture({ task, route, identity }, { plan: createRunPlan(task) });
    const fitDegree = Number(fixture.exercise.fitDegree);
    assert.ok(fitDegree >= 0.95 && fitDegree <= 0.99, `拟合度 ${fixture.exercise.fitDegree} 超出区间`);
    assert.equal(fixture.exercise.fitDegree,
      Number(calculateRouteSimilarity(fixture.detail.pointList, official)).toFixed(2));
    assert.deepEqual(fixture.exercise.sunrunPathPointList, official, '上报的仍是官方路线点');
  }
});
