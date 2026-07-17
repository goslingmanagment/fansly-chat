import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { AgencyHubHealthResponse } from '../src/shared/types.js';

afterEach(async () => { await unmountOptionsPage(); });

/** Find the `.chatgoose-status-row` whose label text equals `label`. */
function rowByLabel(doc: Document, label: string): HTMLElement {
  const row = Array.from(doc.querySelectorAll('.chatgoose-status-row')).find(
    (r) => r.querySelector('.chatgoose-status-label')?.textContent === label,
  );
  if (!row) throw new Error(`No status row labeled ${label}`);
  return row as HTMLElement;
}

describe('options Статус section', () => {
  it('renders six rows and hides Контракт unless debug mode', async () => {
    const { document } = await mountOptionsPage();
    const section = document.querySelector('[data-shell-section="status"]')!;
    const rows = section.querySelectorAll('.chatgoose-status-row');
    expect(rows).toHaveLength(6);
    const contract = Array.from(rows).find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(true);
  });

  it('shows the Контракт row when debug mode is on', async () => {
    const { document } = await mountOptionsPage({ settings: { debugMode: true } });
    const contract = Array.from(document.querySelectorAll('.chatgoose-status-row'))
      .find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(false);
  });
});

describe('options Статус — hub/session hydration', () => {
  it('paints Hub UP with DB latency and Доступ AUTH with identity', async () => {
    const { document } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_x' },
      runtime: {
        health: { ok: true, status: 'ok', dbLatencyMs: 14, contractHash: 'abc', sdkContractHash: 'abc' },
        identity: { ok: true, username: 'lilly-chatter', role: 'chatter', pages: ['Lilly'] },
      },
    });
    const hub = rowByLabel(document, 'Hub (core)');
    expect(hub.querySelector('.chatgoose-badge-mono')?.textContent).toBe('UP');
    expect(hub.textContent).toContain('14');
    const access = rowByLabel(document, 'Доступ');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('AUTH');
    expect(access.textContent).toContain('lilly-chatter');
  });

  it('paints 401 with a «Войти заново» button that scrolls to the hub section', async () => {
    const { document } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'stale' },
      runtime: { identity: { ok: false, reason: 'unauthorized' } },
    });
    const access = rowByLabel(document, 'Доступ');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('401');
    const button = access.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Войти заново');
    const hubCard = document.querySelector('[data-shell-section="hub"]') as HTMLElement;
    hubCard.scrollIntoView = () => undefined; // JSDOM has no layout scroll
    const spy = vi.spyOn(hubCard, 'scrollIntoView');
    button.click();
    expect(spy).toHaveBeenCalled();
  });

  it('shows honest empty states with no hub configured', async () => {
    const { document } = await mountOptionsPage(); // defaults: no_base_url / no_credential
    expect(rowByLabel(document, 'Hub (core)').textContent).toContain('адрес хаба не задан');
    expect(rowByLabel(document, 'Доступ').textContent).toContain('войди или добавь ключ');
  });

  it('DRIFT when the hub contract hash differs from the SDK (debug row)', async () => {
    const { document } = await mountOptionsPage({
      settings: { debugMode: true, agencyHubBaseUrl: 'https://hub.example' },
      runtime: { health: { ok: true, status: 'ok', dbLatencyMs: 1, contractHash: 'live', sdkContractHash: 'vendored' } },
    });
    expect(rowByLabel(document, 'Контракт').querySelector('.chatgoose-badge-mono')?.textContent).toBe('DRIFT');
  });

  it('paints НЕТ ДОСТУПА + «Разрешить доступ» when the hub origin is not granted', async () => {
    const { document } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 't' },
      runtime: {
        health: { ok: false, reason: 'no_permission' },
        identity: { ok: false, reason: 'no_permission' },
      },
    });
    const hub = rowByLabel(document, 'Hub (core)');
    expect(hub.querySelector('.chatgoose-badge-mono')?.textContent).toBe('НЕТ ДОСТУПА');
    expect(hub.dataset.tone).toBe('amber');
    expect((hub.querySelector('button') as HTMLButtonElement).textContent).toBe('Разрешить доступ');
    // no_permission is a hub-health condition, never a credential verdict (§14):
    // the Доступ badge stays neutral, not the red «НЕТ CREDENTIAL».
    const access = rowByLabel(document, 'Доступ');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('НЕИЗВЕСТНО');
    expect(access.dataset.tone).toBe('neutral');
    expect(access.textContent).not.toContain('НЕТ CREDENTIAL');
  });

  it('paints Доступ as neutral НЕИЗВЕСТНО (not НЕТ CREDENTIAL) when the hub is unreachable', async () => {
    const { document } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 't' },
      runtime: {
        health: { ok: false, reason: 'unreachable' },
        identity: { ok: false, reason: 'unreachable' },
      },
    });
    const access = rowByLabel(document, 'Доступ');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('НЕИЗВЕСТНО');
    expect(access.dataset.tone).toBe('neutral');
  });

  it('renders each hub row independently when one read rejects', async () => {
    const { document } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 't' },
      runtime: {
        health: { ok: true, status: 'ok', dbLatencyMs: 8, contractHash: 'a', sdkContractHash: 'a' },
        // A rejected identity read must not strand the Hub row as a skeleton.
        identity: () => Promise.reject(new Error('runtime channel closed')),
      },
    });
    const hub = rowByLabel(document, 'Hub (core)');
    expect(hub.dataset.status).toBe('ready');
    expect(hub.querySelector('.chatgoose-badge-mono')?.textContent).toBe('UP');
    const access = rowByLabel(document, 'Доступ');
    expect(access.dataset.status).toBe('ready');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('НЕИЗВЕСТНО');
  });

  it('in-flight variant: a hub-A run started before the field became hub B drops its paint', async () => {
    // Hydration STARTS under hub A (mount fires it, skeleton shown, both requests
    // issued via allSettled); the chatter re-types the URL to hub B while A's health
    // is still awaited; A's reply then lands → the pre-paint re-check (live sig is
    // now hub B ≠ the expected hub-A snapshot) drops the paint.
    let releaseHealth!: (value: AgencyHubHealthResponse) => void;
    const deferredHealthA = new Promise<AgencyHubHealthResponse>((resolve) => { releaseHealth = resolve; });
    const { document, flushAsync } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub-a.example', agencyHubDeviceToken: 't' },
      runtime: { health: () => deferredHealthA },
    });
    const urlInput = document.querySelector('[data-shell-section="hub"] input[type="url"]') as HTMLInputElement;
    urlInput.value = 'https://hub-b.example'; // typed while A's health is in flight (no persist yet)
    releaseHealth({ ok: true, status: 'ok', dbLatencyMs: 3, contractHash: 'a', sdkContractHash: 'a' });
    await flushAsync();
    expect(rowByLabel(document, 'Hub (core)').querySelector('.chatgoose-badge-mono')?.textContent).not.toBe('UP');
  });

  it('delayed-START variant: a persisted-B run never issues once the field already shows hub C', async () => {
    // Count hub reads; hold the post-persist connection test open so the field can
    // be re-typed DURING the gap before that persist's hydration reaches its first
    // line. Guard step 1 (live sig ≠ expected) must return before any request.
    vi.useFakeTimers(); // the 350 ms autosave debounce is drained by flushAsync's runOnlyPendingTimers
    let healthCalls = 0;
    let releaseConnTest!: () => void;
    const conn = new Promise<void>((resolve) => { releaseConnTest = resolve; });
    const { document, window, flushAsync } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub-a.example', agencyHubDeviceToken: 't' },
      runtime: { health: () => { healthCalls += 1; return { ok: true, status: 'ok', dbLatencyMs: 5, contractHash: 'a', sdkContractHash: 'a' }; } },
    });
    expect(healthCalls).toBe(1); // the mount hydration for hub A
    // Reassign sendMessage post-mount (the Task 9 pattern) so the connection test
    // the post-persist block awaits hangs until released, holding the gap open.
    const browserRef = (window as unknown as { browser: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).browser;
    browserRef.runtime.sendMessage = vi.fn(async (message: unknown) => {
      switch ((message as { type?: string }).type) {
        case 'getAgencyHubHealth': healthCalls += 1; return { ok: true, status: 'ok', dbLatencyMs: 5, contractHash: 'a', sdkContractHash: 'a' };
        case 'getAgencyHubIdentity': return { ok: true, username: 'u', role: 'chatter', pages: [] };
        case 'testAgencyHubConnection': await conn; return { ok: true };
        case 'getSessionsSnapshot': return [];
        case 'getAiQuotaByPage': return {};
        case 'getSpendersStatus': return null;
        default: return undefined;
      }
    });
    const urlInput = document.querySelector('[data-shell-section="hub"] input[type="url"]') as HTMLInputElement;
    urlInput.value = 'https://hub-b.example';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushAsync(); // persist B; its post-persist IIFE parks on the hung connection test
    urlInput.value = 'https://hub-c.example'; // chatter types hub C during the gap (not persisted)
    releaseConnTest();
    await flushAsync(); // hydrate(sig B) runs its first line, sees live=hub C, and bails before any request
    expect(healthCalls).toBe(1); // the stale persisted-B run issued no hub read
  });

  it('sign-in success flips Доступ to AUTH in place (no remount)', async () => {
    const { document, window, flushAsync } = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' }, // URL set, no token yet
      runtime: { identity: { ok: false, reason: 'no_credential' } },
    });
    const access = rowByLabel(document, 'Доступ');
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('НЕТ CREDENTIAL');
    // After sign-in the background has issued a token; identity now returns AUTH.
    const browserRef = (window as unknown as { browser: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).browser;
    browserRef.runtime.sendMessage = vi.fn(async (message: unknown) => {
      switch ((message as { type?: string }).type) {
        case 'issueAgencyHubDeviceToken': return { ok: true, keyPrefix: 'abc', expiresAt: Date.now() + 86_400_000 };
        case 'getAgencyHubIdentity': return { ok: true, username: 'lilly-chatter', role: 'chatter', pages: ['Lilly'] };
        case 'getAgencyHubHealth': return { ok: true, status: 'ok', dbLatencyMs: 5, contractHash: 'a', sdkContractHash: 'a' };
        case 'getSessionsSnapshot': return [];
        case 'getAiQuotaByPage': return {};
        case 'getSpendersStatus': return null;
        default: return undefined;
      }
    });
    const hub = document.querySelector('[data-shell-section="hub"]')!;
    (hub.querySelector('input[placeholder="Логин Hub"]') as HTMLInputElement).value = 'lilly-chatter';
    (hub.querySelector('input[placeholder="Пароль Hub"]') as HTMLInputElement).value = 'pw';
    const signIn = Array.from(hub.querySelectorAll('button')).find((b) => b.textContent === 'Войти и выпустить token') as HTMLButtonElement;
    signIn.click();
    await flushAsync();
    // The SAME Доступ element (no page rebuild) now shows AUTH — hydrateHubStatusRows
    // fired from the sign-in success path, not a remount.
    expect(rowByLabel(document, 'Доступ')).toBe(access);
    expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('AUTH');
    expect(access.textContent).toContain('lilly-chatter');
  });
});
