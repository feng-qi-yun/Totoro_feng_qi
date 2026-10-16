import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { completeRun } from './start-run.js';
import { summarizeRunPlan } from './run-data.js';
import { createRunLogContext, logRunEvent, runFailureDetails } from './run-events.js';

// 单人本地运行：待提交的跑步任务写在本地 JSON 文件里，由前端的状态轮询在到点后触发提交。
// 不需要 Redis，也不需要常驻 Worker 进程；代价是到点后要打开页面才会补交。
export const DEFAULT_PENDING_STORE_PATH = path.join(process.cwd(), 'local-data', 'pending-runs.json');

const ALLOWED_TRACK_KEYS = ['routeName', 'km', 'usedTime', 'avgSpeed', 'deviceModel', 'fitDegree'];
// 已结束任务的保留时间
const RETENTION_MS = Object.freeze({ completed: 60 * 60 * 1000, failed: 24 * 60 * 60 * 1000 });
const inFlight = new Set();

function storePath(options = {}) {
  return options.storePath || process.env.TOTORO_PENDING_STORE || DEFAULT_PENDING_STORE_PATH;
}

function readStore(options = {}) {
  const file = storePath(options);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { jobs: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`待提交任务文件损坏: ${file}`);
  }
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  // 上次运行在提交过程中退出：整条流程不幂等，标记失败而不是自动重试
  return {
    jobs: jobs
      .filter(job => job && typeof job === 'object' && job.jobId)
      .map(job => (job.state === 'running'
        ? { ...job, state: 'failed', failedReason: '提交过程中程序退出，未确认结果' }
        : job)),
  };
}

function writeStore(store, options = {}) {
  const file = storePath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function pruneJobs(jobs, now) {
  return jobs.filter(job => {
    const updatedAt = Date.parse(job.updatedAt || '') || 0;
    if (job.state === 'completed') return now - updatedAt < RETENTION_MS.completed;
    if (job.state === 'failed') return now - updatedAt < RETENTION_MS.failed;
    return true;
  });
}

function identityFingerprint(identity) {
  if (!identity?.stuNumber || !identity?.schoolCode) throw new Error('缺少任务身份资料');
  return createHash('sha256')
    .update(`${identity.schoolCode}\0${identity.stuNumber}`)
    .digest('base64url');
}

function sanitizedTrack(track) {
  if (!track || typeof track !== 'object') throw new Error('缺少跑步预览摘要');
  return Object.fromEntries(ALLOWED_TRACK_KEYS.filter(key => track[key] !== undefined).map(key => [key, track[key]]));
}

export function buildDelayedRunJob({ input, plan, session, track }, options = {}) {
  const durationSeconds = Number(plan?.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('预览用时无效');
  if (!session?.scantronId) throw new Error('缺少已创建的跑步场次');
  const runStartedAt = new Date(session.runStartedAt);
  if (Number.isNaN(runStartedAt.getTime())) throw new Error('跑步场次开始时间无效');

  const now = options.now || new Date();
  const scheduledAt = new Date(runStartedAt.getTime() + Math.round(durationSeconds * 1000));
  const jobId = options.jobId || randomUUID();
  return {
    jobId,
    delayMs: Math.max(1000, scheduledAt.getTime() - now.getTime()),
    scheduledAt: scheduledAt.toISOString(),
    data: {
      jobId,
      identityFingerprint: identityFingerprint(input),
      scheduledAt: scheduledAt.toISOString(),
      track: sanitizedTrack(track),
      payload: {
        input,
        plan,
        session: {
          scantronId: session.scantronId,
          runStartedAt: runStartedAt.toISOString(),
          preferredBaseUrl: session.preferredBaseUrl,
        },
      },
    },
    track: sanitizedTrack(track),
  };
}

export async function enqueueDelayedRun(input, options = {}) {
  const built = buildDelayedRunJob(input, options);
  const now = (options.now || new Date()).getTime();
  const store = readStore(options);
  store.jobs = pruneJobs(store.jobs, now);
  store.jobs.push({
    ...built.data,
    state: 'pending',
    result: null,
    failedReason: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  writeStore(store, options);
  return {
    mode: 'queued',
    jobId: built.jobId,
    scantronId: built.data.payload.session.scantronId,
    scheduledAt: built.scheduledAt,
    track: built.track,
  };
}

// 到点后由轮询触发：只提交一次，把结果写回文件
export async function processDelayedRunJob(job, options = {}) {
  const payload = job?.payload;
  if (!payload?.input || !payload?.plan || !payload?.session?.scantronId || !payload?.session?.runStartedAt) {
    throw new Error('待提交任务载荷不完整');
  }
  if (identityFingerprint(payload.input) !== job.identityFingerprint) {
    throw new Error('待提交任务身份校验失败');
  }
  const runStartedAt = new Date(payload.session.runStartedAt);
  if (Number.isNaN(runStartedAt.getTime())) throw new Error('待提交任务开始时间无效');
  const completeRunImpl = options.completeRunImpl || completeRun;
  const logRunEventImpl = options.logRunEventImpl || logRunEvent;
  const context = createRunLogContext(payload.input, { jobId: String(job.jobId), plan: payload.plan });
  try {
    const result = await completeRunImpl(payload.input, payload.session, {
      plan: payload.plan,
      preferredBaseUrl: payload.session.preferredBaseUrl,
    });
    logRunEventImpl('run.completed', context, {
      stage: 'local_submit',
      scantron_id: result.scantronId || payload.session.scantronId,
    });
    return result;
  } catch (error) {
    logRunEventImpl('run.failed', context, {
      ...runFailureDetails(error, 'local_submit', [payload.input?.token, payload.input?.stuNumber]),
      scantron_id: payload.session.scantronId,
    });
    throw error;
  }
}

async function submitDueJobs(jobs, now, options = {}) {
  for (const job of jobs) {
    if (job.state !== 'pending' || inFlight.has(job.jobId)) continue;
    if (Date.parse(job.scheduledAt) > now) continue;
    inFlight.add(job.jobId);
    job.state = 'running';
    job.updatedAt = new Date(now).toISOString();
    writeStore({ jobs }, options);
    try {
      job.result = await processDelayedRunJob(job, options);
      job.state = 'completed';
    } catch (error) {
      job.state = 'failed';
      job.failedReason = error?.message || '提交失败';
    } finally {
      job.updatedAt = new Date().toISOString();
      inFlight.delete(job.jobId);
      writeStore({ jobs }, options);
    }
  }
}

export async function getStudentRunJobs(identity, options = {}) {
  const now = (options.now || new Date()).getTime();
  const store = readStore(options);
  store.jobs = pruneJobs(store.jobs, now);
  // 立刻落盘：中断恢复（running -> failed）与过期清理都要持久化
  writeStore(store, options);
  await submitDueJobs(store.jobs, now, options);
  const fingerprint = identityFingerprint(identity);
  return store.jobs
    .filter(job => job.identityFingerprint === fingerprint && ['pending', 'running'].includes(job.state))
    .map(job => ({
      jobId: String(job.jobId),
      state: job.state,
      scheduledAt: job.scheduledAt,
      track: sanitizedTrack(job.track || summarizeRunPlan({
        task: job.payload?.input?.task,
        route: job.payload?.input?.route,
        plan: job.payload?.plan,
      })),
    }))
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
}

export async function getDelayedRunJobStatus(jobId, identity, options = {}) {
  const now = (options.now || new Date()).getTime();
  const store = readStore(options);
  store.jobs = pruneJobs(store.jobs, now);
  const job = store.jobs.find(item => String(item.jobId) === String(jobId || ''));
  if (!job) throw new Error('待提交任务不存在或已清理');
  if (job.identityFingerprint !== identityFingerprint(identity)) throw new Error('无权查看此任务');
  writeStore(store, options);
  await submitDueJobs(store.jobs, now, options);
  const updated = readStore(options).jobs.find(item => String(item.jobId) === String(jobId)) || job;
  return {
    jobId: String(jobId),
    state: updated.state,
    result: updated.state === 'completed' ? updated.result : null,
    failedReason: updated.state === 'failed' ? (updated.failedReason || '提交失败') : null,
  };
}
