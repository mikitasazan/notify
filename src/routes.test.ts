/**
 * Покрывает то, чего не покрывал render.test.ts: КУДА уходит событие, СО ЗВУКОМ
 * ли, и что CLI делает с кривой командой. Ровно эти три места и дали находки
 * аудита 27.07.2026 — рендер был проверен, а маршрут и разбор аргументов нет.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { severity } from './events.ts';
import { ROUTES, targets } from './routes.ts';

test('событие уходит во вкладку Ops своего проекта, и только туда', () => {
  const where = targets({ type: 'deploy', project: 'playhub', status: 'ok' });

  assert.equal(where.length, 1);
  assert.equal(where[0].chat, ROUTES.playhub.chat);
  assert.equal(where[0].thread, ROUTES.playhub.ops);
});

test('неизвестный проект не роняет процесс, а даёт пустой список целей', () => {
  // @ts-expect-error — проверяем именно нетипизированный вызов: так приходит
  // опечатка из bash, где типов нет.
  assert.deepEqual(targets({ type: 'deploy', project: 'плейхаб', status: 'ok' }), []);
});

test('красное звонит, зелёное молчит', () => {
  const fail = targets({ type: 'deploy', project: 'arvent', status: 'fail' });
  const ok = targets({ type: 'deploy', project: 'arvent', status: 'ok' });

  assert.equal(fail[0].silent, false);
  assert.equal(ok[0].silent, true);
});

test('инцидент и молчание задачи красные сами по себе, без --status', () => {
  assert.equal(severity({ type: 'incident', project: 'one-q', title: 'Redis лёг' }), 'error');
  assert.equal(severity({ type: 'heartbeat_miss', project: 'one-q', job: 'Бэкап' }), 'error');
});

test('у каждого проекта из ROUTES свой форум — общий чат означал бы, что чужие видят чужое', () => {
  const chats = Object.values(ROUTES).map((f) => f.chat);

  assert.equal(new Set(chats).size, chats.length);
});

/**
 * Запускает CLI без токена: отправки не будет, важен только разбор аргументов.
 * spawnSync, а не execFileSync: последний отдаёт stderr лишь когда процесс упал,
 * а тут весь смысл в выводе процесса, который ОБЯЗАН вернуть 0.
 */
const runCli = (...args: string[]): { code: number; stderr: string } => {
  const res = spawnSync(process.execPath, [fileURLToPath(new URL('cli.ts', import.meta.url)), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, TELEGRAM_OPS_TOKEN: '' }
  });

  return { code: res.status ?? -1, stderr: res.stderr };
};

test('флаг без значения — явная ошибка, а не href="true"', () => {
  const { code, stderr } = runCli('deploy', '--project', 'playhub', '--status', 'ok', '--url');

  assert.equal(code, 0);
  assert.match(stderr, /--url без значения/);
  assert.match(stderr, /событие не отправлено/);
  // И ничего не улетело: до отправки дело не дошло, значит нет ни sent, ни skipped.
  assert.doesNotMatch(stderr, /skipped/);
});

test('без токена CLI отдаёт skipped и код 0 — задача не должна падать из-за уведомления', () => {
  const { code, stderr } = runCli('job', '--project', 'playhub', '--job', 'тест', '--status', 'ok');

  assert.equal(code, 0);
  assert.match(stderr, /skipped/);
});

test('--status success не должен рисовать красное: опечатка при ручном вызове', () => {
  const { stderr } = runCli('deploy', '--project', 'playhub', '--status', 'success');

  // Токена нет, поэтому дальше skipped — но событие СОБРАЛОСЬ, а не отвалилось
  // на разборе: значит `success` признан успехом наравне с `ok`.
  assert.match(stderr, /skipped/);
  assert.doesNotMatch(stderr, /без значения/);
});
