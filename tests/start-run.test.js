import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DISTANCE_GAIN_BAND,
  FIT_DEGREE_BAND,
  SLOW_PACE_BAND,
  buildRunFixture,
  calculateRouteSimilarity,
  createRunPlan,
  distanceOfTrack,
  haversineDistance,
  summarizeRunPlan,
} from '../lib/server/run-data.js';
import { completeRun, prepareRun, startRun } from '../lib/server/start-run.js';

const task = {
  taskId: 'paper-1', name: '跑步任务', mileage: '3.20', minTime: '10', maxTime: '25', fitDegree: '0.60',
  runPointList: [],
};
const route = {
  taskId: 'paper-1', pointId: 'line-1', pointName: '测试路线', longitude: '118.820000', latitude: '31.940000',
  pointList: [
    { longitude: '118.820000', latitude: '31.940000' },
    { longitude: '118.824000', latitude: '31.940000' },
    { longitude: '118.824000', latitude: '31.943000' },
    { longitude: '118.820000', latitude: '31.943000' },
  ],
};
const identity = { token: 'fixture-token', stuNumber: 'student-1', schoolCode: 'school-1' };

test('fixture follows the selected route with realistic mini-program fields', () => {
  const now = new Date('2026-09-14T06:30:00+08:00');
  const fixture = buildRunFixture({ task, route, identity, now });
  const points = fixture.detail.pointList;
  const alternateFixture = buildRunFixture({ task, route, identity, now });
  assert.ok(points.length > 250);
  // 实测里程必须比任务里程多一点，且上报里程等于提交轨迹的实测长度
  const measuredKm = distanceOfTrack(points) / 1000;
  assert.ok(measuredKm > 3.2 && measuredKm <= 3.2 * 1.06, `实测里程 ${measuredKm}`);
  assert.equal(fixture.exercise.km, measuredKm.toFixed(2));
  assert.ok(Number(fixture.exercise.km) > 3.2);
  // 步数必须按实测里程折算，步幅落在 0.7~0.86 米
  const steps = Number(fixture.exercise.steps);
  assert.ok(steps > measuredKm * 1000 / 0.86 && steps < measuredKm * 1000 / 0.7, `步数 ${steps}`);
  assert.equal(fixture.summary.km, fixture.exercise.km);
  assert.equal(fixture.summary.avgSpeed, fixture.exercise.avgSpeed);
  assert.equal(fixture.summary.steps, fixture.exercise.steps);
  assert.notDeepEqual(
    points.map(({ latitude, longitude }) => ({ latitude, longitude })),
    alternateFixture.detail.pointList.map(({ latitude, longitude }) => ({ latitude, longitude })),
  );
  const segmentDistances = points.slice(1).map((point, index) => distanceOfTrack([points[index], point]));
  assert.ok(segmentDistances.every(distance => distance > 0 && distance < 25), '相邻点间距应保持在采样间距量级');
  assert.match(fixture.exercise.avgSpeed, /^\d+'\d{2}"$/);
  assert.match(fixture.exercise.usedTime, /^00:\d{2}:\d{2}$/);
  assert.equal(fixture.begin.paperId, 'paper-1');
  assert.equal(fixture.begin.lineId, 'line-1');
  assert.equal(fixture.exercise.scantronId, '');
  assert.deepEqual(fixture.exercise.sunrunPathPointList, route.pointList);
  assert.equal(fixture.detail.cheatCode, '正常跑步');
  assert.equal(fixture.detail.forceStop, '0');
  assert.equal(fixture.detail.stopReason, '');
  assert.equal(fixture.detail.offsiteDistance, 0);
  // 上报的拟合度必须落在目标区间，且等于用提交轨迹按官方算法重算的结果
  const fitDegree = Number(fixture.exercise.fitDegree);
  assert.ok(fitDegree >= FIT_DEGREE_BAND.min && fitDegree <= FIT_DEGREE_BAND.max, fixture.exercise.fitDegree);
  assert.equal(fixture.exercise.fitDegree, Number(calculateRouteSimilarity(points, route.pointList)).toFixed(2));
  assert.equal(fixture.summary.fitDegree, fixture.exercise.fitDegree);
  assert.ok(points.every((point, index) => Number.isFinite(point.timestamp)
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(point.time)
    && (!index || point.timestamp > points[index - 1].timestamp)));
  // 真实记录是整秒等间隔采样：相邻时间差只允许毫秒级舍入误差
  const timestampGaps = points.slice(1).map((point, index) => point.timestamp - points[index].timestamp);
  const meanGap = timestampGaps.reduce((total, gap) => total + gap, 0) / timestampGaps.length;
  assert.ok(timestampGaps.every(gap => Math.abs(gap - meanGap) <= 2), '时间戳应严格等间隔');
  assert.ok(meanGap >= 900 && meanGap <= 1200, `采样间隔 ${meanGap} 毫秒`);
  // 每秒一个定位点（抖动会拉长实测里程，点数略少于秒数）
  assert.ok(points.length / (timestampGaps.at(-1) - timestampGaps[0] > 0
    ? (points.at(-1).timestamp - points[0].timestamp) / 1000 : 1) > 0.85);
});

test('a narrow time window still produces varied slow-paced durations', () => {
  const narrowTask = { ...task, minTime: '20', maxTime: '22' };
  const durations = Array.from({ length: 40 }, () => createRunPlan(narrowTask).durationSeconds);
  const summary = summarizeRunPlan({ task: narrowTask, route, plan: createRunPlan(narrowTask) });
  for (const seconds of durations) {
    assert.ok(seconds >= 1200 && seconds <= 1320, `用时 ${seconds} 越界`);
    // 交集区间内均匀取值，不应全部钉在 minTime 上
    assert.ok(seconds >= 1200);
  }
  assert.ok(new Set(durations).size > 5, '窄窗口下用时也应有波动');
  assert.ok(durations.some(seconds => seconds > 1200), '不应全部落在 minTime 上');
  assert.match(summary.usedTime, /^00:2[01]:\d{2}$/);
});

test('no consecutive points imply a speed the official client would drop', () => {
  const denseRoute = {
    pointId: 'line-speed',
    pointName: '密集路线',
    pointList: Array.from({ length: 40 }, (_, index) => ({
      longitude: String(118.789 + index * 0.0002),
      latitude: String(31.939 + Math.sin(index / 40 * 2 * Math.PI) * 0.001),
    })),
  };
  // 小程序 handleLocationChange 会丢弃隐含速度大于 8 m/s 的点，提交轨迹不得出现这种相邻点
  for (const candidate of [route, denseRoute]) {
    for (let sample = 0; sample < 20; sample += 1) {
      const points = buildRunFixture({ task, route: candidate, identity }).detail.pointList;
      for (let index = 1; index < points.length; index += 1) {
        const seconds = (points[index].timestamp - points[index - 1].timestamp) / 1000;
        const speed = distanceOfTrack([points[index - 1], points[index]]) / seconds;
        assert.ok(speed <= 8, `${candidate.pointName} 第 ${index} 点隐含速度 ${speed.toFixed(2)} m/s`);
      }
    }
  }
});

test('run plan randomizes bounded time and stride while preserving preview metrics', () => {
  const plans = Array.from({ length: 12 }, () => createRunPlan(task));
  for (const plan of plans) {
    assert.equal(plan.targetMeters, 3200);
    // 用时贴最慢配速：25 分钟上限的 70%~95%
    assert.ok(plan.durationSeconds >= 1500 * SLOW_PACE_BAND.min
      && plan.durationSeconds <= 1500 * SLOW_PACE_BAND.max, `用时 ${plan.durationSeconds}`);
    assert.ok(plan.strideMeters >= 0.7 && plan.strideMeters <= 0.86);
    assert.ok(plan.fitTarget >= FIT_DEGREE_BAND.min && plan.fitTarget <= FIT_DEGREE_BAND.max);
    assert.ok(plan.measuredMeters > plan.targetMeters
      && plan.measuredMeters <= plan.targetMeters * DISTANCE_GAIN_BAND.max,
    `实测里程 ${plan.measuredMeters}`);
  }
  assert.ok(new Set(plans.map(plan => `${plan.durationSeconds}:${plan.strideMeters}`)).size > 1);
  assert.ok(new Set(plans.map(plan => plan.fitTarget)).size > 1);
  assert.ok(new Set(plans.map(plan => plan.measuredMeters)).size > 1);

  const plan = plans[0];
  const preview = summarizeRunPlan({ task, route, plan });
  const fixture = buildRunFixture({ task, route, identity }, { plan });
  const { fitDegree, ...rest } = preview;
  assert.deepEqual(
    (({ routeName, km, usedTime, avgSpeed, steps, deviceModel }) => ({ routeName, km, usedTime, avgSpeed, steps, deviceModel }))(fixture.summary),
    rest,
  );
  assert.equal(fitDegree, plan.fitTarget.toFixed(2));
  // 标定后的实际拟合度应当落在预览目标上，允许最后一位舍入差 0.01
  assert.ok(Math.abs(Number(fixture.summary.fitDegree) - Number(fitDegree)) <= 0.01,
    `${fixture.summary.fitDegree} vs ${fitDegree}`);
});

function distanceToRoute(point, routePoints) {
  let nearest = Infinity;
  for (let index = 0; index < routePoints.length - 1; index += 1) {
    const startLat = Number(routePoints[index].latitude);
    const startLon = Number(routePoints[index].longitude);
    const deltaLat = Number(routePoints[index + 1].latitude) - startLat;
    const deltaLon = Number(routePoints[index + 1].longitude) - startLon;
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

test('fit degree floats inside the configured band without leaving the route corridor', () => {
  const routePoints = route.pointList.map(point => ({
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
  }));
  const scenarios = Array.from({ length: 20 }, () => buildRunFixture({ task, route, identity }));
  const reported = new Set();
  for (const fixture of scenarios) {
    const points = fixture.detail.pointList;
    const fitDegree = Number(fixture.exercise.fitDegree);
    assert.ok(fitDegree >= FIT_DEGREE_BAND.min && fitDegree <= FIT_DEGREE_BAND.max,
      `拟合度 ${fixture.exercise.fitDegree} 超出 ${FIT_DEGREE_BAND.min}~${FIT_DEGREE_BAND.max}`);
    // 服务端拿 sunRunExercisesDetail 的点位重算时必须得到同一个值
    assert.equal(fixture.exercise.fitDegree, Number(calculateRouteSimilarity(points, route.pointList)).toFixed(2));
    // 偏离包络对齐真实记录（p50 10.4m / p90 20.1m / max 27.6m / 超 25m 占比 1.9%）
    const distances = points.map(point => distanceToRoute(point, routePoints)).sort((left, right) => left - right);
    assert.ok(distances.at(-1) < 35, `离路线最远 ${distances.at(-1).toFixed(1)} 米`);
    assert.ok(distances.filter(value => value > 25).length / distances.length < 0.08);
    reported.add(fixture.exercise.fitDegree);
  }
  assert.ok(reported.size > 1, '拟合度应当在区间内浮动，而不是固定值');
});
test('preview fit degree target is reproduced by the submitted track', () => {
  for (const fitTarget of [0.95, 0.97, 0.99]) {
    const plan = { ...createRunPlan(task), fitTarget };
    const fixture = buildRunFixture({ task, route, identity }, { plan });
    assert.equal(fixture.summary.fitDegree, fitTarget.toFixed(2));
    assert.ok(Math.abs(Number(fixture.exercise.fitDegree) - fitTarget) <= 0.01,
      `${fixture.exercise.fitDegree} vs ${fitTarget}`);
    assert.equal(fixture.exercise.fitDegree,
      Number(calculateRouteSimilarity(fixture.detail.pointList, route.pointList)).toFixed(2));
  }

  const plan = createRunPlan(task);
  for (const fitTarget of [undefined, 0.5, 0.9, 0.8, 1]) {
    assert.throws(() => summarizeRunPlan({ task, route, plan: { ...plan, fitTarget } }), /跑步预览数据无效/);
  }
  // 实测里程必须高于任务里程且不超过上限，预览里程也要同步拒绝
  for (const measuredMeters of [undefined, 3100, 3200, 3230, 3500, 3300.5]) {
    assert.throws(() => summarizeRunPlan({ task, route, plan: { ...plan, measuredMeters } }), /跑步预览数据无效/);
  }
  assert.doesNotThrow(() => summarizeRunPlan({ task, route, plan: { ...plan, measuredMeters: 3300 } }));
});

test('generated plans stay valid for every task mileage and never claim the task distance', () => {
  for (const mileage of ['0.20', '0.50', '1.00', '3.20', '5.00', '21.0975']) {
    const variedTask = { ...task, mileage };
    for (let index = 0; index < 25; index += 1) {
      const plan = createRunPlan(variedTask);
      const summary = summarizeRunPlan({ task: variedTask, route, plan });
      const target = Number(mileage) * 1000;
      assert.ok(plan.measuredMeters > target, `${mileage} 实测里程未高于任务里程`);
      assert.ok(plan.measuredMeters <= target * DISTANCE_GAIN_BAND.max + 0.01);
      assert.equal(summary.km, (plan.measuredMeters / 1000).toFixed(2));
      assert.ok(Number(summary.km) > Number(mileage), `${mileage} 上报里程等于任务里程`);
    }
  }
});

test('fit degree stays in band for dense and out-and-back routes', () => {
  const denseRoute = {
    pointId: 'line-dense',
    pointName: '密集路线',
    pointList: Array.from({ length: 40 }, (_, index) => ({
      longitude: String(118.789 + index * 0.0002),
      latitude: String(31.939 + Math.sin(index / 40 * 2 * Math.PI) * 0.001),
    })),
  };
  const outAndBackRoute = {
    pointId: 'line-out-back',
    pointName: '折返路线',
    pointList: [
      { longitude: '118.789377', latitude: '31.939196' },
      { longitude: '118.796000', latitude: '31.940000' },
    ],
  };

  for (const candidate of [denseRoute, outAndBackRoute]) {
    for (let index = 0; index < 5; index += 1) {
      const fixture = buildRunFixture({ task, route: candidate, identity });
      const fitDegree = Number(fixture.exercise.fitDegree);
      assert.ok(fitDegree >= FIT_DEGREE_BAND.min && fitDegree <= FIT_DEGREE_BAND.max,
        `${candidate.pointName} 拟合度 ${fixture.exercise.fitDegree}`);
      assert.equal(fixture.exercise.fitDegree,
        Number(calculateRouteSimilarity(fixture.detail.pointList, candidate.pointList)).toFixed(2));
    }
  }

  // 折返路线顶点稀疏，必须贴身经过每个顶点
  const outAndBackFixture = buildRunFixture({ task, route: outAndBackRoute, identity });
  for (const vertex of outAndBackRoute.pointList) {
    const nearest = Math.min(...outAndBackFixture.detail.pointList.map(point => haversineDistance(point, {
      latitude: Number(vertex.latitude),
      longitude: Number(vertex.longitude),
    })));
    assert.ok(nearest < 15, `折返路线顶点偏离 ${nearest.toFixed(1)} 米`);
  }

  // 顶点间距小于 25 米时，压低拟合度与贴身经过每个顶点在几何上无法兼得：
  // 此时优先保证拟合度落在区间内，但仍不得超出客户端 50 米的偏离告警
  const denseFixture = buildRunFixture({ task, route: denseRoute, identity });
  const routePoints = denseRoute.pointList.map(point => ({
    latitude: Number(point.latitude), longitude: Number(point.longitude),
  }));
  assert.ok(denseFixture.detail.pointList.every(point => distanceToRoute(point, routePoints) < 50));
});

test('start run sends the complete mini-program contract', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ endpoint, body, authorization: options.headers.Authorization });
    const replies = {
      '/wxxcx/platform/camera/currentTimeMillis': { status: '00', code: '0', body: 1 },
      '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration': { status: '00', code: '0', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } },
      '/wxxcx/platform/camera/getCameraConfig': { status: '00', code: '0', body: { flag: 0 }, data: [] },
      '/wxxcx/platform/sunrunFace/selectSunRunRandomConfiguration': { status: '00', code: '0', body: {} },
      '/wxxcx/platform/sunrunFace/startUpNote': { status: '00', code: '0' },
      '/wxxcx/sunrun/getRunBegin': { status: '00', code: '0', scantronId: 'test-session-1' },
      '/wxxcx/sunrun/getRunPointList': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/getRunPointListAbnormal': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/sunRunExercises': { status: '00', code: '0' },
      '/wxxcx/platform/recrecord/sunRunExercisesDetail': { status: '00', code: '0' },
    };
    return new Response(JSON.stringify(replies[endpoint]), { status: 200 });
  };
  const result = await startRun({ task, route, ...identity }, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl,
    now: new Date('2026-09-14T06:30:00+08:00'),
  });
  assert.equal(result.scantronId, 'test-session-1');
  assert.equal(calls.length, 10);
  assert.ok(calls.every(call => call.authorization === 'Bearer fixture-token' && call.body.token === 'fixture-token'));
  assert.equal(calls[5].body.paperId, 'paper-1');
  assert.equal(calls[8].body.scantronId, 'test-session-1');
  assert.equal(calls[9].body.pointList.length, result.track.pointCount);
  assert.equal(calls[9].body.scantronId, 'test-session-1');
  assert.equal(calls[9].body.forceStop, '0');
  assert.equal(calls[9].body.stopReason, '');
  assert.equal(calls[9].body.offsiteDistance, 0);
  assert.deepEqual(result.steps.map(step => step.endpoint), calls.map(call => call.endpoint));
});

test('start run rejects invalid origins and incomplete identity before fetching', async () => {
  const fetchImpl = () => assert.fail('invalid input must not access the network');
  await assert.rejects(startRun({ task, route, ...identity }, {
    baseUrl: 'http://sunrun-test.example.com', fetchImpl,
  }), /HTTPS origin/);
  await assert.rejects(startRun({ task, route, ...identity }, {
    baseUrl: 'https://sunrun-test.example.com/path', fetchImpl,
  }), /HTTPS origin/);
  await assert.rejects(startRun({ task, route, token: '', stuNumber: 'student-1', schoolCode: 'school-1' }, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl,
  }), /缺少账号资料/);
});

test('delayed workflow creates the session now and only completes it later', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    calls.push({ endpoint, body: JSON.parse(options.body) });
    const replies = {
      '/wxxcx/platform/camera/currentTimeMillis': { status: '00', code: '0', body: 1 },
      '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration': { status: '00', code: '0', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } },
      '/wxxcx/platform/camera/getCameraConfig': { status: '00', code: '0', body: { flag: 0 } },
      '/wxxcx/platform/sunrunFace/selectSunRunRandomConfiguration': { status: '00', code: '0', body: {} },
      '/wxxcx/platform/sunrunFace/startUpNote': { status: '00', code: '0' },
      '/wxxcx/sunrun/getRunBegin': { status: '00', code: '0', scantronId: 'prepared-session-1' },
      '/wxxcx/sunrun/getRunPointList': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/getRunPointListAbnormal': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/sunRunExercises': { status: '00', code: '0' },
      '/wxxcx/platform/recrecord/sunRunExercisesDetail': { status: '00', code: '0' },
    };
    return Response.json(replies[endpoint]);
  };
  const now = new Date('2026-09-15T10:00:00.000Z');
  const prepared = await prepareRun({ task, route, ...identity }, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl, now,
  });
  assert.equal(prepared.scantronId, 'prepared-session-1');
  assert.equal(calls.some(call => call.endpoint === '/wxxcx/sunrun/sunRunExercises'), false);

  const preparationCount = calls.length;
  await completeRun({ task, route, ...identity }, prepared, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl,
  });
  assert.deepEqual(calls.slice(preparationCount).map(call => call.endpoint), [
    '/wxxcx/sunrun/sunRunExercises',
    '/wxxcx/platform/recrecord/sunRunExercisesDetail',
  ]);
  assert.equal(calls.filter(call => call.endpoint === '/wxxcx/sunrun/getRunBegin').length, 1);
  assert.ok(calls.slice(preparationCount).every(call => call.body.scantronId === 'prepared-session-1'));
});

test('a route-less task creates a real session and submits an empty configured route', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    calls.push({ endpoint, body: JSON.parse(options.body) });
    const replies = {
      '/wxxcx/platform/camera/currentTimeMillis': { status: '00', code: '0', body: 1 },
      '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration': { status: '00', code: '0', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } },
      '/wxxcx/platform/sunrunFace/startUpNote': { status: '00', code: '0' },
      '/wxxcx/sunrun/getRunBegin': { status: '00', code: '0', scantronId: 'route-free-session-1' },
      '/wxxcx/sunrun/getRunPointList': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/getRunPointListAbnormal': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/sunRunExercises': { status: '00', code: '0' },
      '/wxxcx/platform/recrecord/sunRunExercisesDetail': { status: '00', code: '0' },
    };
    return Response.json(replies[endpoint]);
  };
  const result = await startRun({ task: { ...task, runPointList: [] }, route: undefined, ...identity }, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl,
    now: new Date('2026-09-15T18:00:00+08:00'),
  });
  assert.equal(result.mode, 'completed');
  assert.equal(result.scantronId, 'route-free-session-1');
  assert.equal(result.track.routeName, '无固定路线');
  assert.ok(result.track.pointCount > 250);
  assert.deepEqual(calls.map(call => call.endpoint), [
    '/wxxcx/platform/camera/currentTimeMillis',
    '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration',
    '/wxxcx/platform/sunrunFace/startUpNote',
    '/wxxcx/sunrun/getRunBegin',
    '/wxxcx/sunrun/getRunPointList',
    '/wxxcx/sunrun/getRunPointListAbnormal',
    '/wxxcx/sunrun/sunRunExercises',
    '/wxxcx/platform/recrecord/sunRunExercisesDetail',
  ]);
  assert.equal(calls[3].body.runType, 0);
  assert.equal(calls[3].body.paperId, 'paper-1');
  assert.equal(calls[3].body.lineId, '');
  assert.equal(calls[3].body.faceBase64, '');
  assert.equal(calls[3].body.token, 'fixture-token');
  assert.match(calls[3].body.version, /^\d+\.\d+\.\d+$/);
  assert.ok(calls[3].body.phoneInfo.includes('&') && !calls[3].body.phoneInfo.includes('Node.js'));
  assert.equal(calls[6].body.scantronId, 'route-free-session-1');
  assert.equal(calls[6].body.taskId, 'paper-1');
  assert.deepEqual(calls[6].body.sunrunPathPointList, []);
  assert.equal(calls[7].body.scantronId, 'route-free-session-1');
  assert.equal(calls[7].body.forceStop, '0');
  assert.equal(calls[7].body.stopReason, '');
  assert.equal(calls[7].body.offsiteDistance, 0);
  assert.equal(calls[7].body.pointList.length, result.track.pointCount);
  // 无固定路线任务同样按实测里程上报：比任务里程多一点，且与提交轨迹一致
  const routeFreeKm = distanceOfTrack(calls[7].body.pointList) / 1000;
  assert.ok(routeFreeKm > 3.2 && routeFreeKm <= 3.2 * 1.06, `实测里程 ${routeFreeKm}`);
  assert.equal(calls[6].body.km, routeFreeKm.toFixed(2));
  assert.equal(result.track.km, calls[6].body.km);
  assert.deepEqual(
    { longitude: calls[7].body.pointList[0].longitude, latitude: calls[7].body.pointList[0].latitude },
    { longitude: 118.789377, latitude: 31.939196 },
  );
  assert.ok(calls[7].body.pointList.every(point => (
    point.longitude >= 118.788176 && point.longitude <= 118.792038
    && point.latitude >= 31.934225 && point.latitude <= 31.93925
  )));
});

test('start run stops before creating a session when face verification is required', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const endpoint = new URL(url).pathname;
    calls.push(endpoint);
    const result = endpoint.endsWith('selectSunRunStartConfiguration')
      ? { status: '00', code: '0', body: { sunrunStartFace: '1' } }
      : endpoint.endsWith('getCameraConfig')
        ? { status: '00', code: '0', body: { flag: 0 } }
        : { status: '00', code: '0', body: {} };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await assert.rejects(startRun({ task, route, ...identity }, {
    baseUrl: 'https://sunrun-test.example.com', fetchImpl,
  }), /人脸校验/);
  assert.equal(calls.length, 5);
  assert.ok(!calls.includes('/wxxcx/sunrun/getRunBegin'));
});

test('start run switches to the fallback origin for the rest of the workflow', async t => {
  t.mock.method(console, 'error', () => {});
  const hosts = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    hosts.push(parsed.hostname);
    if (parsed.hostname === 'wxxcx.xtotoro.com') throw new TypeError('fetch failed');
    const result = parsed.pathname.endsWith('selectSunRunStartConfiguration')
      ? { status: '00', code: '0', body: { sunrunStartFace: '1' } }
      : parsed.pathname.endsWith('getCameraConfig')
        ? { status: '00', code: '0', body: { flag: 0 } }
        : { status: '00', code: '0', body: {} };
    return Response.json(result);
  };
  await assert.rejects(startRun({ task, route, ...identity }, { fetchImpl }), /人脸校验/);
  assert.deepEqual(hosts, [
    'wxxcx.xtotoro.com',
    'app.xtotoro.com',
    'app.xtotoro.com',
    'app.xtotoro.com',
    'app.xtotoro.com',
    'app.xtotoro.com',
  ]);
});

test('getRunBegin business rejection exposes safe stage metadata', async () => {
  const fetchImpl = async url => {
    const endpoint = new URL(url).pathname;
    const replies = {
      '/wxxcx/platform/camera/currentTimeMillis': { status: '00', code: '0', body: Date.now() },
      '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration': { status: '00', code: '0', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } },
      '/wxxcx/platform/camera/getCameraConfig': { status: '00', code: '0', body: { flag: 0 } },
      '/wxxcx/platform/sunrunFace/selectSunRunRandomConfiguration': { status: '00', code: '0', body: {} },
      '/wxxcx/platform/sunrunFace/startUpNote': { status: '00', code: '0' },
      '/wxxcx/sunrun/getRunBegin': { status: '01', code: 'LIMIT', msg: '该任务次数今日已达上限' },
    };
    return Response.json(replies[endpoint]);
  };

  await assert.rejects(
    prepareRun({ task, route, ...identity }, {
      baseUrl: 'https://sunrun-test.example.com',
      fetchImpl,
      plan: createRunPlan(task),
    }),
    error => {
      assert.equal(error.stage, 'get_run_begin');
      assert.equal(error.endpoint, '/wxxcx/sunrun/getRunBegin');
      assert.equal(error.kind, 'business_rejected');
      assert.equal(error.httpStatus, 200);
      assert.equal(error.businessStatus, '01');
      assert.equal(error.businessCode, 'LIMIT');
      assert.match(error.message, /今日已达上限/);
      assert.ok(error.elapsedMs >= 0);
      return true;
    },
  );
});

test('worker submission HTTP failure identifies the exercise stage', async () => {
  const fetchImpl = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(
    completeRun({ task, route, ...identity }, {
      scantronId: 'session-1',
      runStartedAt: '2026-09-19T08:00:00.000Z',
    }, {
      baseUrl: 'https://sunrun-test.example.com',
      fetchImpl,
      plan: createRunPlan(task),
    }),
    error => {
      assert.equal(error.stage, 'submit_exercises');
      assert.equal(error.endpoint, '/wxxcx/sunrun/sunRunExercises');
      assert.equal(error.kind, 'upstream_http');
      assert.equal(error.httpStatus, 503);
      assert.ok(error.elapsedMs >= 0);
      return true;
    },
  );
});
