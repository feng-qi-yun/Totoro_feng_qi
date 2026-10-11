import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunPreview, verifyRunPreview } from '../lib/server/run-preview.js';
import { POST as previewPOST } from '../app/api/sunrun/preview/route.js';
import { POST as startPOST } from '../app/api/sunrun/start/route.js';
import { POST as runJobPOST } from '../app/api/sunrun/run-job/route.js';

const identity = { token: 'fixture-token', stuNumber: 'student-1', schoolCode: 'school-1' };
const task = { taskId: 'paper-1', name: '跑步任务', mileage: '3.20', minTime: '10', maxTime: '25' };
const route = {
  pointId: 'line-1', pointName: '测试路线',
  pointList: [
    { longitude: '118.820000', latitude: '31.940000' },
    { longitude: '118.824000', latitude: '31.940000' },
  ],
};

test('run preview stores a compact random plan without exposing credentials or track points', () => {
  const now = new Date('2026-09-15T18:00:00+08:00');
  const preview = createRunPreview({ task, route, identity }, { now });
  const serialized = JSON.stringify(preview);

  assert.equal(preview.track.routeName, '测试路线');
  assert.match(preview.previewToken, /^[0-9a-f-]{36}$/);
  assert.equal(serialized.includes(identity.token), false);
  assert.equal(serialized.includes('pointList'), false);
  const plan = verifyRunPreview(preview.previewToken, { task, route, identity }, { now });
  assert.equal(plan.targetMeters, 3200);
  // 实测里程必须比任务里程多一点，且预览显示的就是最终会上报的值
  assert.ok(plan.measuredMeters > plan.targetMeters);
  assert.equal(preview.track.km, (plan.measuredMeters / 1000).toFixed(2));
  assert.ok(Number(preview.track.km) > 3.2 && Number(preview.track.km) <= 3.2 * 1.06);
});

test('run preview rejects unknown IDs, expiry, and identity or route changes', () => {
  const now = new Date('2026-09-15T18:00:00+08:00');
  const preview = createRunPreview({ task, route, identity }, { now });
  const last = preview.previewToken.at(-1);
  const tampered = `${preview.previewToken.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;

  assert.throws(() => verifyRunPreview(tampered, { task, route, identity }, { now }), /无效/);
  assert.throws(() => verifyRunPreview(preview.previewToken, {
    task, route, identity: { ...identity, stuNumber: 'student-2' },
  }, { now }), /不匹配/);
  assert.throws(() => verifyRunPreview(preview.previewToken, {
    task, route: { ...route, pointId: 'line-2' }, identity,
  }, { now }), /不匹配/);
  assert.throws(() => verifyRunPreview(preview.previewToken, {
    task,
    route: { ...route, pointList: route.pointList.map((point, index) => (
      index ? point : { ...point, longitude: '118.999999' }
    )) },
    identity,
  }, { now }), /不匹配/);
  assert.throws(() => verifyRunPreview(preview.previewToken, { task, route, identity }, {
    now: new Date(now.getTime() + 10 * 60 * 1000 + 1),
  }), /过期/);
});

test('route-free preview keeps the route-1 fallback contract without exposing its points', () => {
  const preview = createRunPreview({ task, route: undefined, identity });
  assert.equal(preview.track.routeName, '无固定路线');
  assert.equal(JSON.stringify(preview).includes('118.789377'), false);
  const plan = verifyRunPreview(preview.previewToken, { task, route: undefined, identity });
  assert.equal(plan.targetMeters, 3200);
  assert.ok(plan.measuredMeters > plan.targetMeters);
});

function request(path, body) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('preview route metrics are the metrics queued by confirmed start', { concurrency: false }, async t => {
  const queueKey = Symbol.for('totoro.liveRunQueue');
  const previousQueue = globalThis[queueKey];
  const previousRedisUrl = process.env.REDIS_URL;
  const added = [];
  globalThis[queueKey] = {
    add: async (...args) => { added.push(args); },
    getJobs: async () => added.map(([, data]) => ({
      id: data.jobId,
      data,
      getState: async () => 'delayed',
    })),
  };
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  t.mock.method(globalThis, 'fetch', async url => {
    const endpoint = new URL(url).pathname;
    const replies = {
      '/wxxcx/platform/serverlist/GetStudentInfoByToken': {
        code: 0,
        obj: {
          snCode: identity.stuNumber,
          schoolCode: identity.schoolCode,
          schoolCampusCode: 'campus-1',
        },
      },
      '/wxxcx/platform/camera/currentTimeMillis': { status: '00', code: '0', body: 1 },
      '/wxxcx/platform/sunrunFace/selectSunRunStartConfiguration': { status: '00', code: '0', body: { sunrunStartFace: '0', sunrunPointRandom: '0' } },
      '/wxxcx/platform/camera/getCameraConfig': { status: '00', code: '0', body: { flag: 0 } },
      '/wxxcx/platform/sunrunFace/selectSunRunRandomConfiguration': { status: '00', code: '0', body: {} },
      '/wxxcx/platform/sunrunFace/startUpNote': { status: '00', code: '0' },
      '/wxxcx/sunrun/getRunBegin': { status: '00', code: '0', scantronId: 'route-session-1' },
      '/wxxcx/sunrun/getRunPointList': { status: '00', code: '0', data: [] },
      '/wxxcx/sunrun/getRunPointListAbnormal': { status: '00', code: '0', data: [] },
    };
    return Response.json(replies[endpoint]);
  });
  t.after(() => {
    if (previousQueue === undefined) delete globalThis[queueKey];
    else globalThis[queueKey] = previousQueue;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  const body = {
      token: identity.token,
      stu_number: identity.stuNumber,
      school_code: identity.schoolCode,
      task,
      route,
  };
  const previewResponse = await previewPOST(request('/api/sunrun/preview', body));
    const previewBody = await previewResponse.json();
    assert.equal(previewBody.success, true);

    const startResponse = await startPOST(request('/api/sunrun/start', {
      ...body,
      preview_token: previewBody.preview.previewToken,
    }));
    const startBody = await startResponse.json();
    assert.equal(startBody.success, true);
    assert.equal(startBody.result.mode, 'queued');
    assert.deepEqual(startBody.result.track, previewBody.preview.track);
    assert.equal(added.length, 1);
    assert.equal(added[0][0], 'execute-live-run');
    assert.equal(added[0][2].delay > 0, true);
    assert.equal(added[0][1].payload.session.scantronId, 'route-session-1');

    const restoredResponse = await runJobPOST(request('/api/sunrun/run-job', {
      token: identity.token,
      stu_number: 'spoofed-student',
      school_code: 'spoofed-school',
    }));
    const restoredBody = await restoredResponse.json();
    assert.equal(restoredBody.success, true);
    assert.equal(restoredBody.jobs.length, 1);
    assert.equal(restoredBody.jobs[0].jobId, startBody.result.jobId);
    assert.equal(JSON.stringify(restoredBody.jobs).includes(identity.token), false);
});
