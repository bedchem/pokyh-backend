import webpush from 'web-push';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DUE_CHECK_INTERVAL_MS = 60 * 1000;
const SCHOOL_COOKIE = '_' + Buffer.from(config.webuntisSchool || 'lbs-brixen').toString('base64');

interface PushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  jsessionid: string;
  bearerToken: string;
  knownUnread: number;
}

async function sendPush(sub: PushSub, payload: { title: string; body: string; url: string }) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
  } catch (err: unknown) {
    // 410 Gone = subscription expired (user uninstalled or browser cleared it)
    if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
    } else {
      logger.warn(`[push] Send failed for ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function pollSubscription(sub: PushSub) {
  if (!sub.jsessionid) return;

  try {
    const res = await fetch(
      `${config.webuntisBase}/api/rest/view/v1/messages?pageSize=100&start=0`,
      {
        headers: {
          Cookie: `JSESSIONID=${sub.jsessionid}; schoolname="${SCHOOL_COOKIE}"`,
          Accept: 'application/json',
          ...(sub.bearerToken ? { Authorization: `Bearer ${sub.bearerToken}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (res.status === 401 || res.status === 403) {
      // WebUntis session expired — reset so we don't spam on re-register
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { knownUnread: -1 } });
      return;
    }

    const text = await res.text();
    if (!res.ok || text.trimStart().startsWith('<')) return;

    const json = JSON.parse(text) as Record<string, unknown>;
    const arr =
      (json.incomingMessages as unknown[]) ??
      (json.messages as unknown[]) ??
      ((json.data as { incomingMessages?: unknown[] } | undefined)?.incomingMessages) ??
      [];

    const unread = (arr as Record<string, unknown>[]).filter((m) => {
      const r = m['isRead'] ?? m['read'];
      if (typeof r === 'boolean') return !r;
      if (typeof r === 'number') return r !== 1;
      return false;
    }).length;

    if (sub.knownUnread >= 0 && unread > sub.knownUnread) {
      const diff = unread - sub.knownUnread;
      await sendPush(sub, {
        title: diff === 1 ? 'Neue Mitteilung' : `${diff} neue Mitteilungen`,
        body: 'Tippe um sie zu sehen',
        url: '/messages',
      });
    }

    await prisma.pushSubscription.update({ where: { id: sub.id }, data: { knownUnread: unread } });
  } catch (err) {
    logger.warn(`[push] Poll error for ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pollAll() {
  const subs = await prisma.pushSubscription.findMany();
  if (subs.length === 0) return;
  logger.debug(`[push] Polling ${subs.length} subscriptions`);
  await Promise.allSettled(subs.map(pollSubscription));
}

async function sendPushToUser(stableUid: string, payload: { title: string; body: string; url: string }) {
  const subs = await prisma.pushSubscription.findMany({ where: { stableUid } });
  await Promise.allSettled(subs.map((sub) => sendPush(sub, payload)));
}

async function checkDueItems() {
  const now = new Date();

  const dueTodos = await prisma.todo.findMany({
    where: { dueAt: { lte: now }, notifiedAt: null, done: false },
  });

  for (const todo of dueTodos) {
    await sendPushToUser(todo.stableUid, {
      title: `Todo fällig: ${todo.title}`,
      body: 'Tippe um es zu sehen',
      url: '/todos',
    });
    await prisma.todo.update({ where: { id: todo.id }, data: { notifiedAt: now } });
    logger.debug(`[push] Todo due notification sent: ${todo.id}`);
  }

  const dueReminders = await prisma.reminder.findMany({
    where: { remindAt: { lte: now }, notifiedAt: null },
    include: { class: { include: { members: true } } },
  });

  for (const reminder of dueReminders) {
    const memberUids = reminder.class.members.map((m) => m.stableUid);
    await Promise.allSettled(
      memberUids.map((uid) =>
        sendPushToUser(uid, {
          title: `Erinnerung: ${reminder.title}`,
          body: reminder.body || 'Tippe um sie zu sehen',
          url: '/reminders',
        }),
      ),
    );
    await prisma.reminder.update({ where: { id: reminder.id }, data: { notifiedAt: now } });
    logger.debug(`[push] Reminder notification sent: ${reminder.id} to ${memberUids.length} members`);
  }
}

export function startPushPoller() {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    logger.info('[push] VAPID keys not set — push notifications disabled');
    return;
  }

  webpush.setVapidDetails(
    `mailto:${config.vapidEmail}`,
    config.vapidPublicKey,
    config.vapidPrivateKey,
  );

  void pollAll();
  setInterval(() => void pollAll(), POLL_INTERVAL_MS);

  void checkDueItems();
  setInterval(() => void checkDueItems(), DUE_CHECK_INTERVAL_MS);

  logger.info('[push] Poller started (messages: 5 min, due items: 1 min)');
}
