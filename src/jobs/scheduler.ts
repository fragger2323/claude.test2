import type { Logger } from 'pino';
import { db } from '../db/client.js';
import { enqueueJob } from './queue.js';

/**
 * Scheduler (runs inside the worker every minute):
 *  - saved searches with schedule "daily" run once a day at their hour (discover + analyse
 *    only new/stale leads; incremental by design) — it NEVER sends messages;
 *  - maintenance (retention purge, cache cleanup) once a day.
 */
export function nextDailyRun(hour: number, from = new Date()): Date {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

let lastMaintenanceDay = '';

export async function schedulerTick(log: Logger, now = new Date()): Promise<{ enqueued: number }> {
  let enqueued = 0;
  const due = await db().savedSearch.findMany({ where: { schedule: 'daily', OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] } });
  for (const s of due) {
    const hour = s.scheduleHour ?? 7;
    if (!s.nextRunAt) {
      await db().savedSearch.update({ where: { id: s.id }, data: { nextRunAt: nextDailyRun(hour, now) } });
      continue;
    }
    const active = await db().job.findMany({ where: { type: 'scheduled_search', status: { in: ['queued', 'running'] } }, select: { payload: true } });
    const running = active.some((j) => (j.payload as { savedSearchId?: string } | null)?.savedSearchId === s.id);
    if (!running) {
      await enqueueJob('scheduled_search', { savedSearchId: s.id });
      enqueued++;
      log.info({ savedSearchId: s.id, name: s.name }, 'scheduled saved search due');
    }
    await db().savedSearch.update({ where: { id: s.id }, data: { nextRunAt: nextDailyRun(hour, now) } });
  }
  const day = now.toISOString().slice(0, 10);
  if (day !== lastMaintenanceDay && now.getHours() >= 3) {
    lastMaintenanceDay = day;
    const pending = await db().job.count({ where: { type: 'maintenance', status: { in: ['queued', 'running'] } } });
    if (pending === 0) {
      await enqueueJob('maintenance', {});
      enqueued++;
    }
  }
  return { enqueued };
}
