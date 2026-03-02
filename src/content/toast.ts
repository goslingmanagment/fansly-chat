import { ensureToastRoot } from './dom-anchor.js';

interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

export class ToastController {
  private readonly root = ensureToastRoot();

  show(message: string, options: ToastOptions = {}): void {
    const toast = document.createElement('div');
    toast.className = 'chatmuse-toast';

    const text = document.createElement('div');
    text.textContent = message;
    toast.append(text);

    if (options.actionLabel && options.onAction) {
      const actions = document.createElement('div');
      actions.className = 'chatmuse-toast-actions';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'chatmuse-button';
      action.textContent = options.actionLabel;
      action.addEventListener('click', () => {
        options.onAction?.();
        toast.remove();
      });
      actions.append(action);
      toast.append(actions);
    }

    this.root.append(toast);
    window.setTimeout(() => {
      toast.remove();
    }, options.durationMs ?? 4500);
  }
}
