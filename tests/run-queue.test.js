import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executeConfirmedRun } from '../lib/server/confirmed-run.js';
import {
  buildDelayedRunJob,
  enqueueDelayedRun,
  getDelayedRunJobStatus,
  getStudentRunJobs,
  processDelayedRunJob,
} from '../lib/server/run-queue.js';

const identity = {
  token: 'dedicated-test-token',
  stuNumber: 'student-1',
  schoolCode: 'school-1',
};
const track = {
  routeName: '测试路线',
  km: '3.20',
  usedTime: '00:20:00',
  avgSpeed: `6'15"`,
  fitDegree: '0.98',
};
const task = { taskId: 'paper-1', mileage: '3.20', minTime: 20, maxTime: 20 };
const route = {
  pointId: 'line-1',
  pointName: '测试路线',
  pointList: [
    { longitude: 118.1, latitude: 31.1 },
    { longitude: 118.2, latitude: 31.2 },
  ],
};
const plan = { targetMeters: 3200, measuredMeters: 3300, durationSeconds: 1200, fitTarget: 0.97 };
const session = {
  scantronId: 'test-session-1',
  runStartedAt: '2026-09-15T10:00:00.000Z',
  preferredBaseUrl: 'https://app.xtotoro.com/',
};

let counter = 0;
// 待提交任务写在仓库内的 local-data/（已加入 .gitignore），测试用完即删
function tempStore() {
  counter += 1;
  return path.join(import.meta.dirname, '..', 'local-data', `test-pending-${process.pid}-${counter}.json`);
}

function readJobs(storePath) {
  return JSON.parse(fs.readFileSync(storePath, 'utf8')).jobs;
}

function cleanup(storePath) {
  fs.rmSync(storePath, { force: true });
}

test('delayed jobs store the real execution input and retain the confirmation time', () => {
  const now = new Date('2026-09-15T10:00:00.000Z');
  const job = buildDelayedRunJob({ input: { task, route, ...identity }, plan, session, track }, {
    now,
    jobId: 'job-1',
  });

  assert.equal(job.delayMs, 1_200_000);
  assert.equal(job.scheduledAt, '2026-09-15T10:20:00.000Z');
  assert.equal(job.data.jobId, 'job-1');
  assert.equal(job.data.scheduledAt, '2026-09-15T10:20:00.000Z');
  assert.equal(job.data.payload.session.scantronId, 'test-session-1');
  assert.equal(job.data.payload.plan, plan);
  assert.deepEqual(job.track, track);
  assert.equal(JSON.stringify(job).includes(identity.token), true, '载荷需要真实 Token 才能提交');
  assert.equal(JSON.stringify(job.data.identityFingerprint).includes(identity.stuNumber), false);
  assert.equal(typeof job.data.identityFingerprint, 'string');
});

test('enqueueing writes one pending job into the local store', async () => {
  const storePath = tempStore();
  try {
    const result = await enqueueDelayedRun({ input: { task, route, ...identity }, plan, session, track }, {
      now: new Date('2026-09-15T10:00:00.000Z'),
      jobId: 'job-2',
      storePath,
    });

    assert.equal(result.mode, 'queued');
    assert.equal(result.jobId, 'job-2');
    assert.equal(result.scantronId, 'test-session-1');
    assert.equal(result.scheduledAt, '2026-09-15T10:20:00.000Z');
    const jobs = readJobs(storePath);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'pending');
    assert.equal(jobs[0].jobId, 'job-2');
  } finally {
    cleanup(storePath);
  }
});

test('pending jobs stay hidden from other accounts and never leak the token', async () => {
  const storePath = tempStore();
  try {
    const now = new Date('2026-09-15T10:00:00.000Z');
    for (const [index, owner] of [identity, { ...identity, stuNumber: 'student-2' }].entries()) {
      await enqueueDelayedRun({ input: { task, route, ...owner }, plan, session, track }, {
        now, jobId: `job-${index}`, storePath,
      });
    }

    const own = await getStudentRunJobs(identity, { storePath, now });
    assert.deepEqual(own, [{
      jobId: 'job-0',
      state: 'pending',
      scheduledAt: '2026-09-15T10:20:00.000Z',
      track,
    }]);
    assert.equal(JSON.stringify(own).includes(identity.token), false);
    await assert.rejects(
      getDelayedRunJobStatus('job-1', identity, { storePath, now }),
      /无权查看/,
    );
    await assert.rejects(getDelayedRunJobStatus('missing-job', identity, { storePath, now }), /不存在/);
  } finally {
    cleanup(storePath);
  }
});

test('polling submits a due job exactly once and reports the result', async () => {
  const storePath = tempStore();
  try {
    const calls = [];
    const completeRunImpl = async (input, storedSession, options) => {
      calls.push({ input, storedSession, options });
      return { mode: 'completed', scantronId: storedSession.scantronId, track };
    };
    await enqueueDelayedRun({ input: { task, route, ...identity }, plan, session, track }, {
      now: new Date('2026-09-15T10:00:00.000Z'),
      jobId: 'job-due',
      storePath,
    });

    // 还没到点：轮询只报告待提交，不提交
    const early = await getDelayedRunJobStatus('job-due', identity, {
      storePath, completeRunImpl, now: new Date('2026-09-15T10:10:00.000Z'),
    });
    assert.equal(early.state, 'pending');
    assert.equal(early.result, null);
    assert.equal(calls.length, 0);

    // 到点：轮询触发提交
    const due = await getDelayedRunJobStatus('job-due', identity, {
      storePath, completeRunImpl, now: new Date('2026-09-15T10:20:01.000Z'),
    });
    assert.equal(due.state, 'completed');
    assert.equal(due.result.scantronId, 'test-session-1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.plan, plan);
    assert.equal(calls[0].options.preferredBaseUrl, session.preferredBaseUrl);

    // 再轮询不会重复提交
    const again = await getDelayedRunJobStatus('job-due', identity, {
      storePath, completeRunImpl, now: new Date('2026-09-15T10:30:00.000Z'),
    });
    assert.equal(again.state, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(readJobs(storePath)[0].state, 'completed');
  } finally {
    cleanup(storePath);
  }
});

test('a failed submission is recorded with its reason and never retried', async () => {
  const storePath = tempStore();
  try {
    let calls = 0;
    const completeRunImpl = async () => {
      calls += 1;
      throw Object.assign(new Error('成绩接口拒绝'), { stage: 'submit_exercises' });
    };
    await enqueueDelayedRun({ input: { task, route, ...identity }, plan, session, track }, {
      now: new Date('2026-09-15T10:00:00.000Z'), jobId: 'job-fail', storePath,
    });
    const due = await getDelayedRunJobStatus('job-fail', identity, {
      storePath, completeRunImpl, now: new Date('2026-09-15T10:21:00.000Z'),
    });
    assert.equal(due.state, 'failed');
    assert.equal(due.failedReason, '成绩接口拒绝');
    const after = await getDelayedRunJobStatus('job-fail', identity, {
      storePath, completeRunImpl, now: new Date('2026-09-15T10:22:00.000Z'),
    });
    assert.equal(after.state, 'failed');
    assert.equal(calls, 1, '整条流程不幂等，失败后不得自动重试');
  } finally {
    cleanup(storePath);
  }
});

test('a job interrupted mid-submission is marked failed instead of resubmitted', async () => {
  const storePath = tempStore();
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      jobs: [{
        jobId: 'job-interrupted',
        identityFingerprint: 'x',
        scheduledAt: '2026-09-15T10:20:00.000Z',
        state: 'running',
        track,
        payload: { input: { task, route, ...identity }, plan, session },
        updatedAt: '2026-09-15T10:20:00.000Z',
      }],
    }));
    const jobs = await getStudentRunJobs(identity, { storePath, now: new Date('2026-09-15T10:21:00.000Z') });
    assert.deepEqual(jobs, [], '中断的任务不再出现在待提交列表');
    assert.equal(readJobs(storePath)[0].state, 'failed');
    assert.match(readJobs(storePath)[0].failedReason, /程序退出/);
  } finally {
    cleanup(storePath);
  }
});

test('processDelayedRunJob rejects foreign or incomplete payloads', async () => {
  await assert.rejects(processDelayedRunJob({ jobId: 'x', payload: {} }), /载荷不完整/);
  await assert.rejects(processDelayedRunJob({
    jobId: 'x',
    identityFingerprint: 'not-mine',
    payload: { input: { task, route, ...identity }, plan, session },
  }), /身份校验失败/);
});

test('confirmed runs create the session now and store one pending job', async () => {
  const storePath = tempStore();
  const events = [];
  try {
    const result = await executeConfirmedRun({ task, route, ...identity }, {
      plan,
      storePath,
      jobId: 'job-3',
      now: new Date('2026-09-15T10:00:00.000Z'),
      prepareRunImpl: async () => session,
      logRunEventImpl: (name, context, details) => events.push({ name, context, details }),
    });

    assert.equal(result.mode, 'queued');
    assert.equal(result.jobId, 'job-3');
    const jobs = readJobs(storePath);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.session.scantronId, 'test-session-1');
    assert.deepEqual(events.map(event => event.name), ['run.started', 'run.queued']);
    assert.ok(events.every(event => event.context.request_id === 'job-3'));
    assert.equal(events[0].details.stage, 'get_run_begin');
    assert.equal(events[1].details.stage, 'pending_store');
    assert.equal(JSON.stringify(events).includes(identity.token), false);
  } finally {
    cleanup(storePath);
  }
});

test('confirmed run logs a stage-aware failure without swallowing it', async () => {
  const storePath = tempStore();
  const events = [];
  const expected = Object.assign(new Error('begin rejected'), {
    stage: 'get_run_begin',
    endpoint: '/wxxcx/sunrun/getRunBegin',
    kind: 'business_rejected',
    businessCode: 'LIMIT',
  });
  try {
    await assert.rejects(executeConfirmedRun({ task, route, ...identity }, {
      plan,
      storePath,
      jobId: 'job-failed-before-store',
      prepareRunImpl: async () => { throw expected; },
      logRunEventImpl: (name, context, details) => events.push({ name, context, details }),
    }), error => error === expected);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'run.failed');
    assert.equal(events[0].details.stage, 'get_run_begin');
  } finally {
    cleanup(storePath);
  }
});
