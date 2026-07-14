import { buildAccountLookupOrder } from '../shared/account-aliases.js';
import { getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { loadStorageState, saveAccountMapping } from '../shared/storage.js';

interface MappingBannerCallbacks {
  onOpenSettings: () => void;
}

export class MappingBanner {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private renderGeneration = 0;
  private desiredAccountId: string | null = null;
  private desiredMapped = false;

  constructor(private readonly callbacks: MappingBannerCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatgoose-banner chatgoose-hidden';

    const copy = document.createElement('div');
    copy.className = 'chatgoose-banner-copy';
    this.title = document.createElement('div');
    this.title.className = 'chatgoose-banner-title';
    this.title.textContent = 'Which model is this account?';
    this.body = document.createElement('div');
    this.body.className = 'chatgoose-banner-text';
    copy.append(this.title, this.body);

    this.actions = document.createElement('div');
    this.actions.className = 'chatgoose-banner-actions';

    this.root.append(copy, this.actions);
  }

  async render(accountId: string | null, mapped: boolean): Promise<void> {
    const generation = ++this.renderGeneration;
    this.desiredAccountId = accountId;
    this.desiredMapped = mapped;
    if (!accountId || mapped) {
      this.root.classList.add('chatgoose-hidden');
      this.actions.replaceChildren();
      return;
    }

    const state = await loadStorageState();
    if (
      generation !== this.renderGeneration ||
      this.desiredAccountId !== accountId ||
      this.desiredMapped
    ) {
      return;
    }
    this.root.classList.remove('chatgoose-hidden');
    this.actions.replaceChildren();

    const activePersonas = getActivePersonaCatalog(state.personaCatalog);
    if (activePersonas.length === 0) {
      this.body.textContent = 'No active server personas are available. Ask an Agency Hub admin to create or activate one.';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatgoose-button';
      button.textContent = 'Open Settings';
      button.addEventListener('click', () => this.callbacks.onOpenSettings());
      this.actions.append(button);
      return;
    }

    const mappedKey = buildAccountLookupOrder(
      state.accountAliases,
      accountId,
      accountId,
    ).map((key) => state.accountMappings[key]).find(Boolean) ?? null;
    const mappedCatalogEntry = mappedKey
      ? state.personaCatalog.find((entry) => entry.key === mappedKey) ?? null
      : null;
    this.body.textContent = mappedKey && mappedCatalogEntry?.status !== 'active'
      ? `The saved persona for ${accountId} is unavailable. Choose an active server persona; the saved mapping is preserved until you do.`
      : `Assign Fansly account ${accountId} to a model personality.`;

    const select = document.createElement('select');
    select.className = 'chatgoose-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a personality';
    select.append(placeholder);
    for (const personality of state.personaCatalog) {
      const option = document.createElement('option');
      option.value = personality.key;
      const usable = personality.status === 'active';
      option.textContent = usable
        ? personality.displayName
        : `${personality.displayName} · archived`;
      option.disabled = !usable;
      select.append(option);
    }
    if (mappedKey && !mappedCatalogEntry) {
      const missing = document.createElement('option');
      missing.value = mappedKey;
      missing.textContent = `Unavailable persona · ${mappedKey}`;
      missing.disabled = true;
      select.append(missing);
    }
    if (mappedKey && mappedCatalogEntry?.status !== 'active') {
      select.value = mappedKey;
    }

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'chatgoose-button';
    save.textContent = 'Save Mapping';
    save.disabled = true;

    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'chatgoose-button chatgoose-button-secondary';
    settings.textContent = 'Settings';
    settings.addEventListener('click', () => this.callbacks.onOpenSettings());

    select.addEventListener('change', () => {
      save.disabled = !select.value;
    });

    save.addEventListener('click', async () => {
      if (
        !select.value ||
        generation !== this.renderGeneration ||
        this.desiredAccountId !== accountId ||
        this.desiredMapped
      ) {
        return;
      }
      save.disabled = true;
      try {
        await saveAccountMapping(accountId, select.value);
        if (generation === this.renderGeneration) {
          this.root.classList.add('chatgoose-hidden');
        }
      } catch (error) {
        if (generation === this.renderGeneration) {
          save.disabled = false;
        }
        console.error('Failed to save account mapping', error);
      }
    });

    this.actions.append(select, save, settings);
  }
}
