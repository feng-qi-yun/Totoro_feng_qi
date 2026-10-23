import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildRunFixture, calculateRouteSimilarity, createRunPlan, haversineDistance } from '../lib/server/run-data.js';
import { POST as importedRoutesPOST } from '../app/api/sunrun/imported-routes/route.js';
import {
  deleteRunningLine,
  importRunningLine,
  renameRunningLine,
} from '../lib/server/imported-routes.js';
import { listRunningLines, loadRunningLine, withRunningLine } from '../lib/server/running-lines.js';
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

// 一圈约 430 米的椭圆跑道（24 个顶点）
function stadiumRoute() {
  const semiNorth = 85;
  const semiEast = 50;
  const pointList = Array.from({ length: 24 }, (_, index) => {
    const angle = index / 24 * 2 * Math.PI;
    return point(
      Number((semiNorth * Math.cos(angle)).toFixed(2)),
      Number((semiEast * Math.sin(angle)).toFixed(2)),
    );
  });
  return { pointId: 'line-loop', pointName: '操场跑道', pointList };
}

const loopIdentity = { token: 't', stuNumber: '1', schoolCode: '1' };

test('multi-lap tracks overlap lap over lap like a real run', () => {
  // 真实记录：5.6 圈折叠散度 4.6 米。横向偏离若按整条轨迹进度取值，
  // 会叠出「形状相同、大小不同」的嵌套椭圆，这里锁住各圈必须互相重合。
  const route = stadiumRoute();
  // 跑 5.6 圈（与真实记录相当）——圈数太少时折叠搜索不可靠
  const task = { taskId: 'paper-lap', mileage: '2.40', minTime: '10', maxTime: '25' };
  for (let sample = 0; sample < 3; sample += 1) {
    const fixture = buildRunFixture({ task, route, identity: loopIdentity }, { plan: createRunPlan(task) });
    assert.ok(fixture.detail.pointList.length > 600, '应有足够点数');
    const best = findLapMeters(fixture.detail.pointList, { min: 250, max: 800, step: 0.5 });
    assert.ok(best.lapMeters < 790, `圈长应落在环线附近，实际 ${best.lapMeters.toFixed(0)}m`);
    assert.ok(best.spread < 8, `各圈应互相重合，折叠散度 ${best.spread.toFixed(1)}m`);
  }
});

test('imported routes are listed with stable labels for the dropdown', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(listRunningLines({ dir }), []);
    const loop = [point(0, 0), point(0, 40), point(40, 40), point(40, 0)];
    fs.writeFileSync(path.join(dir, 'sunrunLine-a.json'), JSON.stringify({
      routeId: 'sunrunLine-a', routeName: '天目湖-西操场', lapMeters: 469.8, pointList: loop,
    }));
    fs.writeFileSync(path.join(dir, 'sunrunLine-b.json'), JSON.stringify({
      routeId: 'sunrunLine-b', routeName: '图书馆', lapMeters: 512, pointList: loop,
    }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');

    const list = listRunningLines({ dir });
    assert.deepEqual(list.map(item => item.label), ['天目湖-西操场-导入路线1', '图书馆-导入路线2']);
    assert.deepEqual(list.map(item => item.lineId), ['sunrunLine-a', 'sunrunLine-b']);
    assert.equal(list[0].baseRouteName, '天目湖-西操场');
    assert.equal(list[0].baseRouteId, 'sunrunLine-a');
    assert.equal(list[0].pointCount, 4);
    // 界面选中「导入路线1」时，走线用导入线、上报仍是官方路线
    const officialRoute = { pointId: 'sunrunLine-a', pointName: '天目湖-西操场', pointList: loop };
    const picked = withRunningLine({ ...officialRoute, pointName: list[0].label, importedLineId: list[0].lineId }, { dir });
    assert.equal(picked.pointName, '天目湖-西操场-导入路线1');
    assert.equal(picked.pointId, 'sunrunLine-a');
    assert.ok(Array.isArray(picked.runningLine) && picked.runningLine.length === 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imported routes can be renamed and deleted', () => {
  const dir = tempDir();
  try {
    const loop = [point(0, 0), point(0, 40), point(40, 40), point(40, 0)];
    fs.writeFileSync(path.join(dir, 'sunrunLine-a.json'), JSON.stringify({
      routeId: 'sunrunLine-a', routeName: '天目湖-西操场', lapMeters: 470, pointList: loop,
    }));

    // 重命名：写进文件，列表里优先用自定义名称
    const renamed = renameRunningLine('sunrunLine-a', '  我的操场  ', { dir });
    assert.equal(renamed.label, '我的操场');
    assert.equal(listRunningLines({ dir })[0].label, '我的操场');
    assert.equal(loadRunningLine('sunrunLine-a', { dir }).length, 4, '重命名不影响点列');

    // 非法名称与非法 ID
    assert.throws(() => renameRunningLine('sunrunLine-a', '   ', { dir }), /不能为空/);
    assert.throws(() => renameRunningLine('sunrunLine-a', 'x'.repeat(41), { dir }), /不能超过/);
    assert.throws(() => renameRunningLine('../etc/passwd', 'x', { dir }), /ID 不合法/);
    assert.throws(() => deleteRunningLine('../etc/passwd', { dir }), /ID 不合法/);

    // 删除
    assert.deepEqual(deleteRunningLine('sunrunLine-a', { dir }), { lineId: 'sunrunLine-a' });
    assert.deepEqual(listRunningLines({ dir }), []);
    assert.throws(() => deleteRunningLine('sunrunLine-a', { dir }), /不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importing derives a running line from the newest real record', async () => {
  const dir = tempDir();
  try {
    const { track } = stadiumLap({ laps: 4, samples: 1000 });
    const officialRoute = { pointId: 'sunrunLine-x', pointName: '天目湖-西操场', pointList: [point(0, 0), point(0, 1)] };
    const calls = [];
    const imported = await importRunningLine({ token: 'tok', routeId: 'sunrunLine-x' }, {
      dir,
      loadProfile: async () => ({ token: 'tok', stuNumber: '20230001', schoolCode: 'SCH', campusId: 'C' }),
      loadTasks: async () => [{ taskId: 'paper-1', runPointList: [officialRoute] }],
      loadTrack: async request => {
        calls.push(request);
        return { recordId: 'sunrunId-1', recordDate: '2026-10-23', points: track };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(imported.routeName, '天目湖-西操场');
    assert.equal(imported.label, '天目湖-西操场-导入路线1');
    assert.equal(imported.recordDate, '2026-10-23');
    assert.ok(imported.pointCount > 10);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sunrunLine-x.json'), 'utf8'));
    assert.equal(saved.derivedFrom, 'sunrunId-1');
    assert.equal(saved.label, imported.label);
    assert.ok(Math.abs(saved.lapMeters - imported.lapMeters) < 0.5);

    // 再次导入同一条路线会覆盖，但保留改过的名字
    renameRunningLine('sunrunLine-x', '跑操场', { dir });
    const again = await importRunningLine({ token: 'tok', routeId: 'sunrunLine-x' }, {
      dir,
      loadProfile: async () => ({ token: 'tok', stuNumber: '20230001', schoolCode: 'SCH', campusId: 'C' }),
      loadTasks: async () => [{ taskId: 'paper-1', runPointList: [officialRoute] }],
      loadTrack: async () => ({ recordId: 'sunrunId-2', recordDate: '2026-10-24', points: track }),
    });
    assert.equal(again.label, '跑操场');
    assert.equal(listRunningLines({ dir }).length, 1, '同一路线只有一条导入线');

    // 找不到记录 / 圈数不足 都要给出可读错误
    await assert.rejects(importRunningLine({ token: 'tok', routeId: 'sunrunLine-x' }, {
      dir,
      loadProfile: async () => ({ token: 'tok', stuNumber: '1', schoolCode: 'S', campusId: 'C' }),
      loadTasks: async () => [{ taskId: 'paper-1', runPointList: [officialRoute] }],
      loadTrack: async () => null,
    }), /没有找到这条路线带轨迹的记录/);
    await assert.rejects(importRunningLine({ token: 'tok', routeId: 'sunrunLine-x' }, {
      dir,
      loadProfile: async () => ({ token: 'tok', stuNumber: '1', schoolCode: 'S', campusId: 'C' }),
      loadTasks: async () => [{ taskId: 'paper-1', runPointList: [officialRoute] }],
      loadTrack: async () => ({ recordId: 'r', recordDate: 'd', points: [point(0, 0), point(1, 1)] }),
    }), /推不出跑步线/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imported route API lists, renames and deletes local lines', async () => {
  const dir = tempDir();
  const previous = process.env.TOTORO_RUNNING_LINE_DIR;
  process.env.TOTORO_RUNNING_LINE_DIR = dir;
  try {
    const loop = [point(0, 0), point(0, 40), point(40, 40), point(40, 0)];
    fs.writeFileSync(path.join(dir, 'sunrunLine-api.json'), JSON.stringify({
      routeId: 'sunrunLine-api', routeName: '天目湖-西操场', lapMeters: 470, recordDate: '2026-10-23', pointList: loop,
    }));

    const call = async body => {
      const response = await importedRoutesPOST(new Request('http://localhost/api/sunrun/imported-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    };

    const listed = await call({});
    assert.equal(listed.status, 200);
    assert.equal(listed.body.routes[0].label, '天目湖-西操场-导入路线1');
    assert.equal(listed.body.routes[0].pointList.length, 4, '列表要带点列供界面画图');

    const renamed = await call({ action: 'rename', line_id: 'sunrunLine-api', label: '我的操场' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.routes[0].label, '我的操场');

    const deleted = await call({ action: 'delete', line_id: 'sunrunLine-api' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.routes, []);

    const bad = await call({ action: 'rename', line_id: '../x', label: 'x' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /ID 不合法/);
  } finally {
    if (previous === undefined) delete process.env.TOTORO_RUNNING_LINE_DIR;
    else process.env.TOTORO_RUNNING_LINE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
