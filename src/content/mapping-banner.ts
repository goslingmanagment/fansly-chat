import { loadStorageState, saveAccountMapping } from '../shared/storage.js';

interface MappingBannerCallbacks {
  onOpenSettings: () => void;
}

export class MappingBanner {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;

  constructor(private readonly callbacks: MappingBannerCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatmuse-banner chatmuse-hidden';

    const copy = document.createElement('div');
    copy.className = 'chatmuse-banner-copy';
    this.title = document.createElement('div');
    this.title.className = 'chatmuse-banner-title';
    this.title.textContent = 'Which model is this account?';
    this.body = document.createElement('div');
    this.body.className = 'chatmuse-banner-text';
    copy.append(this.title, this.body);

    this.actions = document.createElement('div');
    this.actions.className = 'chatmuse-banner-actions';

    this.root.append(copy, this.actions);
  }

  async render(accountId: string | null, mapped: boolean): Promise<void> {
    if (!accountId || mapped) {
      this.root.classList.add('chatmuse-hidden');
      this.actions.replaceChildren();
      return;
    }

    const state = await loadStorageState();
    this.root.classList.remove('chatmuse-hidden');
    this.actions.replaceChildren();

    if (state.personalities.length === 0) {
      this.body.textContent = 'Create a personality in Settings before ChatMuse can generate replies for this account.';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatmuse-button';
      button.textContent = 'Open Settings';
      button.addEventListener('click', () => this.callbacks.onOpenSettings());
      this.actions.append(button);
      return;
    }

    this.body.textContent = `Assign Fansly account ${accountId} to a model personality.`;

    const select = document.createElement('select');
    select.className = 'chatmuse-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a personality';
    select.append(placeholder);
    for (const personality of state.personalities) {
      const option = document.createElement('option');
      option.value = personality.id;
      option.textContent = personality.name;
      select.append(option);
    }

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'chatmuse-button';
    save.textContent = 'Save Mapping';
    save.disabled = true;

    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'chatmuse-button chatmuse-button-secondary';
    settings.textContent = 'Settings';
    settings.addEventListener('click', () => this.callbacks.onOpenSettings());

    select.addEventListener('change', () => {
      save.disabled = !select.value;
    });

    save.addEventListener('click', async () => {
      if (!select.value) {
        return;
      }
      await saveAccountMapping(accountId, select.value);
      this.root.classList.add('chatmuse-hidden');
    });

    this.actions.append(select, save, settings);
  }
}
