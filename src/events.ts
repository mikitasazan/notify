/**
 * Каталог событий — единственная точка входа для отправки. `notify()` (см.
 * `send.ts`) принимает ТОЛЬКО значения этого типа: свободного текста в API
 * нет, значит «своё» сообщение технически не написать.
 *
 * Правило эволюции схемы (версии нет и не будет — сообщение живёт секунду и
 * читается глазами, версионировать нечего):
 *   - новое поле у СУЩЕСТВУЮЩЕГО типа добавляется ТОЛЬКО опциональным;
 *   - обязательные поля не добавляются никогда — только новый тип события.
 * Тогда старый вызывающий код и новый пакет совместимы в обе стороны.
 */

export type Project = 'playhub' | 'one-q' | 'arvent' | 'game-publisher';

/**
 * Позиция списка внутри сообщения: задача из дайджеста, упавшая проверка,
 * замечание. `url` необязателен — тогда рендерится просто строкой.
 */
export type Item = { text: string; url?: string };

export type NotifyEvent =
  /** Выкатка кода на сервер. */
  | {
      type: 'deploy';
      project: Project;
      status: 'ok' | 'fail';
      commit?: string;
      /** Ссылка на коммит — строка «коммит» становится кликабельной. */
      commitUrl?: string;
      url?: string;
      /**
       * Куда выкатили. Заполнять ТОЛЬКО когда окружений больше одного: у сайтов
       * с единственным продом «куда: прод» — строка, которую читают глазами и
       * ничего из неё не узнают.
       */
      target?: string;
      /**
       * Откуда запустили: «вручную с Mac», «GitHub Actions». Вот это как раз
       * новость — путей выкатки два, они дают разные последствия (ручной идёт
       * с ноутбука и переменные берёт из локального .env), и по карточке видно,
       * какой сработал.
       */
      via?: string;
    }
  /** Регулярная задача по расписанию: импорт игр, бэкап БД, валидатор. */
  | {
      type: 'job';
      project: Project;
      job: string;
      status: 'ok' | 'fail';
      stats?: Array<[label: string, value: string | number]>;
      /** Детали: что именно упало, замечания прогона. */
      items?: Item[];
      note?: string;
      url?: string;
    }
  /** Сводка с цифрами: дневной отчёт, дайджест аналитики. */
  | {
      type: 'report';
      project: Project;
      title: string;
      period?: string;
      lines: Array<[label: string, value: string | number]>;
      /**
       * Список позиций со ссылками — для дайджестов задач, где ценность в
       * самих названиях, а не в цифре. Рендерятся отдельным блоком после
       * `lines`.
       */
      items?: Item[];
      url?: string;
    }
  /** Итог CI на основной ветке. */
  | {
      type: 'ci';
      project: Project;
      status: 'ok' | 'fail';
      branch?: string;
      commit?: string;
      actor?: string;
      url?: string;
    }
  /**
   * Событие пул-реквеста. Виды покрывают весь путь PR, потому что владелец
   * следит за работой команды по вкладке Ops, а не по почте: почта приходит
   * только когда тебя позвали лично, и половина событий в неё не попадает.
   */
  | {
      type: 'pr';
      project: Project;
      action:
        | 'opened'
        | 'ready_for_review'
        | 'review_requested'
        | 'approved'
        | 'changes_requested'
        | 'merged'
        | 'closed';
      number: number;
      title: string;
      author?: string;
      reviewer?: string;
      url?: string;
    }
  /** Событие задачи: заведена, взята в работу, закрыта. */
  | {
      type: 'issue';
      project: Project;
      action: 'opened' | 'assigned' | 'closed';
      number: number;
      title: string;
      author?: string;
      assignee?: string;
      url?: string;
    }
  /** Приложение сломалось прямо сейчас (рантайм-алерт). */
  | {
      type: 'incident';
      project: Project;
      title: string;
      detail?: string;
      url?: string;
    }
  /** Задача не отметилась вовремя — сторож молчания (heartbeat). */
  | {
      type: 'heartbeat_miss';
      project: Project;
      job: string;
      lastSeen?: string;
      expected?: string;
    };

export type EventType = NotifyEvent['type'];

/** Красное = со звуком и с дублем в тему инцидентов. Всё остальное — тихо. */
export const severity = (e: NotifyEvent): 'info' | 'error' => {
  if (e.type === 'incident' || e.type === 'heartbeat_miss') {
    return 'error';
  }

  if ('status' in e && e.status === 'fail') {
    return 'error';
  }

  return 'info';
};
