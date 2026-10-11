import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeRealTrack,
  describe,
  parseArgs,
  parseDurationSeconds,
  pointToPolylineDistance,
  sampleRealRuns,
  shanghaiDates,
  toPoints,
} from '../scripts/sample-real-runs.js';

const realRoute = [
  { longitude: '118.789377', latitude: '31.939196' },
  { longitude: '118.791716', latitude: '31.935809' },
  { longitude: '118.792038', latitude: '31.93468' },
  { longitude: '118.789785', latitude: '31.934225' },
];

function fakeUpstream(calls) {
  const replies = {
    '/wxxcx/platform/serverlist/GetStudentInfoByToken': {
      code: 0,
      obj: {
        snCode: '20230001', schoolCode: 'SCHOOL-1', schoolCampusCode: 'CAMPUS-1',
        studentName: '测试同学', schoolName: '测试大学', schoolCampusName: '主校区',
      },
    },
    '/wxxcx/sunrun/getSunrunPaper': {
      status: '00',
      code: '0',
      getSunrunPaperResponseList: [{
        taskId: 'paper-1', name: '阳光跑任务', mileage: '3.20', minTime: '10', maxTime: '25',
        fitDegree: '0.60', offsetRange: '30', startDate: '2026-09-01', endDate: '2026-12-31',
        runTimeRuleList: [{ startTime: '06:00:00', endTime: '22:00:00' }],
        runPointList: [{ pointId: 'line-1', pointName: '环线', pointList: realRoute }],
      }],
    },
    '/wxxcx/sunrun/getSunrunPaperList': {
      status: '00',
      sunrunTaskList: [{ id: 'paper-1', name: '阳光跑任务' }],
    },
    '/wxxcx/sunrun/selectSunRunDayScantronList': {
      status: '00',
      data: [{
        id: 'score-1', lineId: 'line-1', toltalRun: '3.35', usedTime: '00:22:10',
        fitDegree: '0.86', steps: '4210', startTime: '06:31:00', endTime: '06:53:10',
      }],
    },
    '/wxxcx/sunrun/getSunrunArchDetail': {
      status: '00',
      body: {
        pointList: [
          { longitude: '118.789377', latitude: '31.939196' },
          { longitude: '118.790500', latitude: '31.937800' },
          { longitude: '118.791716', latitude: '31.935809' },
        ],
        fitDegree: '0.86',
      },
    },
    '/wxxcx/sunrun/getRunPointList': {
      status: '00', allCount: 12, nullCount: 0, alreadyCount: 12,
    },
  };
  return async url => {
    const endpoint = new URL(url).pathname;
    calls.push(endpoint);
    if (endpoint === '/wxxcx/sunrun/sunRunExercises'
      || endpoint === '/wxxcx/platform/recrecord/sunRunExercisesDetail') {
      throw new Error(`采样脚本不允许调用写入接口 ${endpoint}`);
    }
    const reply = replies[endpoint];
    return reply ? Response.json(reply) : Response.json({ status: '00', code: '0' });
  };
}

test('sampling reads real records and never touches submission endpoints', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeUpstream(calls);
  try {
    const report = await sampleRealRuns({
      token: 'test-token', days: 2, paperId: '', detail: true, detailLimit: 1,
      keepTracks: false, delayMs: 0, redact: true,
    });

    assert.equal(report.student.stuNumber, '***');
    assert.equal(report.student.campusName, '主校区');
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].requiredFitDegree, '0.60');
    assert.equal(report.tasks[0].routes[0].vertexCount, 4);
    assert.equal(report.recordCount, 1);
    assert.equal(report.records[0].fitDegree, 0.86);
    assert.equal(report.records[0].km, 3.35);
    assert.deepEqual(report.summary.reportedFitDegree, {
      count: 1, min: 0.86, p25: 0.86, median: 0.86, p75: 0.86, max: 0.86,
    });
    // 真实里程倍率：3.35 / 3.20
    assert.equal(report.summary.reportedKmOverTask.count, 1);
    assert.equal(report.summary.reportedKmOverTask.median, 1.05);
    assert.equal(report.summary.trackVsReportedKm.count, 1);
    // 用时占比：22:10 相对任务上限 25 分钟
    assert.equal(report.summary.durationOverMaxTime.count, 1);
    assert.equal(report.summary.durationOverMaxTime.median, 0.89);

    const detail = report.detail[0];
    assert.equal(detail.routeId, 'line-1');
    assert.equal(detail.analysis.pointCount, 3);
    assert.equal(detail.analysis.recomputedFitDegree, '1.00');
    assert.deepEqual(detail.runPointProgress, { allCount: 12, nullCount: 0, alreadyCount: 12 });
    assert.equal(detail.track, undefined);
    assert.ok(detail.detailShape.includes('pointList'));

    assert.ok(calls.includes('/wxxcx/sunrun/selectSunRunDayScantronList'));
    assert.ok(calls.includes('/wxxcx/sunrun/getSunrunArchDetail'));
    assert.ok(calls.every(endpoint => !endpoint.includes('sunRunExercises')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('track analysis measures real deviation geometry', () => {
  const routePoints = toPoints(realRoute);
  const onRoute = toPoints(realRoute.map(point => ({
    longitude: Number(point.longitude) + 0.00002,
    latitude: Number(point.latitude) + 0.00002,
  })));
  const analysis = analyzeRealTrack(onRoute, routePoints);
  assert.equal(analysis.pointCount, 4);
  assert.equal(analysis.deviationProfile.length, 60);
  assert.equal(analysis.recomputedFitDegree, '1.00');
  assert.ok(analysis.distanceToRoute.max < 5);
  assert.ok(analysis.vertexPassage.max < 5);
  assert.ok(analysis.trackMeters > 0);

  // 没有经过某些顶点的轨迹，顶点最近距离会明显变大——这正是打卡点风险的量化方式
  const skipsVertices = analyzeRealTrack(toPoints([
    { longitude: '118.789377', latitude: '31.939196' },
    { longitude: '118.789900', latitude: '31.939100' },
  ]), routePoints);
  assert.ok(skipsVertices.vertexPassage.max > 50);
  assert.equal(analyzeRealTrack([], routePoints), null);
});

test('sampling helpers handle sparse and missing fields', () => {
  assert.equal(pointToPolylineDistance({ latitude: 0, longitude: 0 }, [
    { latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 },
  ]), 0);
  assert.equal(describe([]), null);
  assert.deepEqual(describe([1, 2, 3, 4]), { count: 4, min: 1, p25: 1.75, median: 2.5, p75: 3.25, max: 4 });
  assert.equal(toPoints([{ latitude: 'x', longitude: 1 }]).length, 0);
  assert.equal(shanghaiDates(2, Date.parse('2026-09-15T10:00:00Z')).length, 2);
  assert.equal(parseDurationSeconds('00:22:10'), 1330);
  assert.equal(parseDurationSeconds('22:10'), 1330);
  assert.ok(Number.isNaN(parseDurationSeconds('')));

  const options = parseArgs(['--days', '7', '--detail', '--token', 'abc', '--no-redact']);
  assert.equal(options.days, 7);
  assert.equal(options.detail, true);
  assert.equal(options.token, 'abc');
  assert.equal(options.redact, false);
  assert.equal(parseArgs(['--help']).help, true);
});
