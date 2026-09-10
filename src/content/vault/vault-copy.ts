// Every user-facing string of the vault uploader, in one place (the cabinet's
// copy.ts discipline). Russian, chatter vocabulary: «волт», «альбом», «Fansly».

import type {
  VaultUploadPlanProblem,
  VaultUploadPlanWarning,
} from '../../shared/vault-upload.js';
import type { VaultItemState, VaultStopReason } from './upload-runner.js';

// The launcher's own two strings are in `vault-launcher-copy.ts`: that file is
// bundled into the classic bootstrap, this one must never be.
export const VAULT_COPY = {
  title: 'Загрузка в волт',
  subtitleIdle: 'Набор файлов в один альбом, по одному, с проверкой каждого.',
  close: 'Закрыть',
  closeBlocked: 'Идёт загрузка. Поставьте на паузу, чтобы закрыть.',
  minimize: 'Свернуть',
  expand: 'Развернуть',

  accountLabel: 'Аккаунт',
  accountLoading: 'определяется…',
  accountUnknown: 'не определён — обновите страницу Fansly',
  accountRefresh: 'Проверить снова',
  albumLabel: 'Альбом',
  albumMissing: 'откройте альбом в волте',
  uploaderLabel: 'Форма загрузки',
  uploaderReady: 'готова',
  uploaderMissing: 'раскройте «Upload to Vault» в альбоме',
  uploaderBusy: 'занята — Fansly ещё обрабатывает файл',

  pickFolder: 'Выбрать папку',
  pickFiles: 'Выбрать файлы',
  orderLabel: 'Порядок в альбоме',
  orderFirstOnTop: 'первый файл сверху',
  orderLastOnTop: 'последний файл сверху',
  orderHint: 'Fansly показывает свежие загрузки первыми, поэтому очередь идёт с конца списка.',

  previewTitle: (count: number, folder: string | null): string =>
    folder ? `${folder} · ${formatCount(count)}` : formatCount(count),
  previewEmpty: 'Выберите папку с набором. Файлы встанут в альбом в этом порядке.',

  checkpointFound: (done: number, total: number): string =>
    `Прошлый запуск: готово ${done} из ${total}. Эти файлы будут пропущены.`,
  checkpointTotalMismatch: (previous: number, current: number): string =>
    `Прошлый запуск был на ${previous} файлов, сейчас выбрано ${current}. Проверьте, что это тот же набор.`,
  checkpointReset: 'Сбросить прошлый запуск',
  checkpointResetConfirm: 'Точно сбросить? Готовые файлы будут загружены снова.',
  checkpointResetYes: 'Да, сбросить',
  checkpointResetNo: 'Оставить',
  checkpointLeftBehind: 'Не удалось убрать запись о запуске: при следующем открытии панель может предложить его продолжить.',
  checkpointSaveFailed: 'Не удалось сохранить ответ в контрольную точку. Попробуйте ещё раз.',
  checkpointClearFailed: 'Не удалось сбросить прошлый запуск. Попробуйте ещё раз.',

  uncertainTitle: (name: string): string => `Результат для «${name}» неизвестен`,
  uncertainBody: 'Файл был передан Fansly, но подтверждения не было. Найдите его в альбоме и скажите, что видите. Панель сама его не перезальёт.',
  uncertainPresent: 'Есть в альбоме',
  uncertainMissing: 'Нет в альбоме',

  start: 'Начать',
  resume: 'Продолжить',
  pause: 'Пауза после текущего',
  pausing: 'Дозагружаю текущий…',

  progress: (done: number, total: number): string => `Готово ${done} из ${total}`,
  current: (name: string): string => `Сейчас: ${name}`,
  elapsed: (seconds: number): string => `${formatDuration(seconds)} в работе`,

  statePaused: 'Пауза. Продолжить можно в любой момент.',
  stateComplete: 'Готово: все файлы в альбоме.',
  reportUploaded: (count: number): string => `Загружено сейчас: ${count}`,
  reportPresent: (count: number): string => `Уже были в альбоме: ${count}`,
  reportCheckpoint: (count: number): string => `Из прошлого запуска: ${count}`,
  reportOrderOk: (checked: number): string =>
    `Порядок первых ${checked} карточек совпадает с планом.`,
  reportOrderMismatch: (position: number, expected: string, actual: string): string =>
    `Позиция ${position}: ожидался «${expected}», в альбоме «${actual}». Проверьте порядок вручную.`,
  reportOrderUnavailable: 'Карточки альбома не видны — порядок не проверен.',

  itemStatus: (entry: VaultItemState): string => {
    switch (entry.status) {
      case 'pending':
        return 'в очереди';
      case 'present':
        return 'уже в альбоме';
      case 'uploading':
        return 'загружается';
      case 'verified':
        return entry.source === 'checkpoint'
          ? 'готов (прошлый запуск)'
          : entry.source === 'chatter'
            ? 'готов (подтверждён вами)'
            : 'готов';
      case 'failed':
        return 'ошибка Fansly';
      case 'uncertain':
        return 'неизвестно';
    }
  },

  problem: (problem: VaultUploadPlanProblem): string => {
    switch (problem.kind) {
      case 'empty':
        return 'В выборе нет фото или видео. Поддерживаются JPG, PNG, GIF, WebP, MP4, MOV, M4V, WebM.';
      case 'duplicate-keys':
        return `Одинаковые имена (без расширения): ${problem.names.join(', ')}. Проверка по имени не различит их — переименуйте.`;
    }
  },
  warning: (warning: VaultUploadPlanWarning): string => {
    switch (warning.kind) {
      case 'non-ascii':
        return `${formatCount(warning.count)} с кириллицей или спецсимволами в имени. Fansly может изменить имя, и проверка не найдёт карточку — лучше переименовать латиницей.`;
      case 'nested-ignored':
        return `Пропущено из вложенных папок: ${warning.count}. Загружаются только файлы из самой папки.`;
      case 'unsupported-ignored':
        return `Пропущено неподдерживаемых файлов: ${warning.count}.`;
    }
  },

  stopReason: (reason: VaultStopReason, albumTitle: string): string => {
    switch (reason.kind) {
      case 'route-left':
        return 'Вы ушли со страницы волта. Вернитесь в альбом и нажмите «Продолжить».';
      case 'album-closed':
        return `Альбом закрыт. Откройте «${albumTitle}» и нажмите «Продолжить».`;
      case 'album-changed':
        return reason.albumTitle
          ? `Открыт другой альбом («${reason.albumTitle}»). Вернитесь в «${albumTitle}».`
          : `Альбом «${albumTitle}» больше не открыт. Вернитесь в него.`;
      case 'uploader-missing':
        return 'Не найдена форма загрузки. Раскройте «Upload to Vault» в альбоме и продолжите.';
      case 'uploader-busy':
        return 'Форма загрузки Fansly занята другим файлом. Дождитесь, пока она освободится.';
      case 'uploader-error':
        return `Fansly сообщил об ошибке: ${reason.text}. Файл помечен как неудачный; «Продолжить» попробует его снова.`;
      case 'handoff-unavailable':
        return 'Не удалось передать файл в форму Fansly. Раскройте «Upload to Vault» заново и продолжите.';
      case 'handoff-indeterminate':
        return 'Передача файла прервалась на полпути. Проверьте альбом и ответьте ниже.';
      case 'timeout':
        return 'Fansly не подтвердил файл за 45 минут. Проверьте альбом и ответьте ниже.';
      case 'order-mismatch':
        return reason.actual
          ? `Файл загружен, но сверху альбома «${reason.actual}», а ожидался «${reason.expected}». Проверьте альбом: возможно, кто-то загружает параллельно.`
          : `Файл «${reason.expected}» загружен, но карточки альбома не видны. Проверьте альбом.`;
      case 'checkpoint-write-failed':
        return reason.afterUpload
          ? 'Файл загружен и подтверждён, но контрольную точку сохранить не удалось. Не загружайте его вручную повторно; нажмите «Продолжить», чтобы попробовать снова.'
          : 'Не удалось сохранить контрольную точку. Загрузка остановлена до передачи файла — ничего не потеряно.';
      case 'file-missing':
        return `Файл «${reason.name}» не найден в выборе. Выберите папку заново.`;
      case 'internal-error':
        return `Панель споткнулась: ${reason.message}. Проверьте альбом; если файл помечен «неизвестно», ответьте ниже.`;
    }
  },

  footer: 'Файлы идут через форму загрузки Fansly в этой вкладке — как если бы вы выбирали их вручную. Не перезагружайте страницу во время загрузки; после обрыва панель спросит про последний файл.',
} as const;

export function formatCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun = mod10 === 1 && mod100 !== 11
    ? 'файл'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
      ? 'файла'
      : 'файлов';
  return `${count} ${noun}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0
    ? `${minutes} мин ${rest.toString().padStart(2, '0')} с`
    : `${rest} с`;
}
