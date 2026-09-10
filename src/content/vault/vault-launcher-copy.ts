// The launcher's two strings live apart from `vault-copy.ts` on purpose: the
// launcher is bundled into the classic bootstrap that every Fansly page runs,
// and importing the panel's copy object there doubled that script for
// chatters who never open the vault (esbuild cannot tree-shake object
// properties). Everything else the uploader says stays in `vault-copy.ts`.

export const VAULT_LAUNCHER_COPY = {
  label: 'Загрузка',
  title: 'Загрузить набор в этот альбом по порядку',
} as const;
