import { randomUUID } from 'node:crypto';
import { prepareRun } from './start-run.js';
import { enqueueDelayedRun } from './run-queue.js';
import { summarizeRunPlan } from './run-data.js';
import { createRunLogContext, logRunEvent, runFailureDetails } from './run-events.js';

export async function executeConfirmedRun(input, options = {}) {
  const jobId = options.jobId || randomUUID();
  const context = createRunLogContext(input, { jobId, plan: options.plan });
  const logRunEventImpl = options.logRunEventImpl || logRunEvent;
  const prepareRunImpl = options.prepareRunImpl || prepareRun;
  let fallbackStage = 'pending_store_ready';
  try {
    fallbackStage = 'run_prepare';
    let startedLogged = false;
    const logStarted = (startedSession) => {
      if (startedLogged) return;
      startedLogged = true;
      logRunEventImpl('run.started', context, {
        stage: 'get_run_begin',
        scantron_id: startedSession.scantronId,
      });
    };
    const session = await prepareRunImpl(input, {
      plan: options.plan,
      now: options.now,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      onSessionStarted: logStarted,
    });
    // Test doubles and older injected implementations may not support the callback.
    logStarted(session);

    fallbackStage = 'pending_store';
    const result = await enqueueDelayedRun({
      input,
      plan: options.plan,
      session: {
        scantronId: session.scantronId,
        runStartedAt: session.runStartedAt,
        preferredBaseUrl: session.preferredBaseUrl,
      },
      track: summarizeRunPlan({ task: input.task, route: input.route, plan: options.plan }),
    }, {
      storePath: options.storePath,
      now: options.now,
      jobId,
    });
    logRunEventImpl('run.queued', context, {
      stage: 'pending_store',
      scantron_id: result.scantronId,
      scheduled_at: result.scheduledAt,
    });
    return result;
  } catch (error) {
    logRunEventImpl('run.failed', context, runFailureDetails(error, fallbackStage, [
      input?.token,
      input?.stuNumber,
    ]));
    throw error;
  }
}
