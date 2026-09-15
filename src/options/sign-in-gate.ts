import { COPY } from './copy.js';

/** Reuse the cabinet's one sign-in form and writer. Moving the live nodes
 * preserves input, request and custody state across sign-in/sign-out; there is
 * no second password handler or hidden duplicate of the form. */
export function createSignInGate(options: {
  root: HTMLElement;
  cabinet: HTMLElement;
  form: HTMLFormElement;
  feedback: HTMLElement;
  signOutStatus: HTMLElement;
  helpLink: HTMLElement;
  advanced: HTMLElement;
  version: string;
}): { update: (required: boolean, rejected: boolean) => void; dispose: () => void } {
  const doc = options.root.ownerDocument;
  const gate = doc.createElement('main');
  gate.className = 'chatgoose-signin-gate';
  gate.dataset.signInGate = 'true';
  gate.hidden = true;
  const card = doc.createElement('section');
  card.className = 'chatgoose-signin-card';
  const brand = doc.createElement('div');
  brand.className = 'chatgoose-signin-brand';
  brand.textContent = COPY.rail.brand;
  const title = doc.createElement('h1');
  title.id = 'chatgoose-signin-title';
  title.textContent = COPY.signInGate.title;
  gate.setAttribute('aria-labelledby', title.id);
  const subtitle = doc.createElement('p');
  subtitle.className = 'chatgoose-signin-subtitle';
  subtitle.textContent = COPY.signInGate.subtitle;
  const notice = doc.createElement('p');
  notice.className = 'chatgoose-signin-notice';
  notice.setAttribute('role', 'status');
  const fields = doc.createElement('div');
  fields.className = 'chatgoose-signin-fields';
  const help = doc.createElement('p');
  help.className = 'chatgoose-signin-help';
  help.textContent = COPY.signInGate.help;
  const links = doc.createElement('div');
  links.className = 'chatgoose-signin-links';
  const advanced = doc.createElement('div');
  advanced.className = 'chatgoose-signin-advanced';
  const version = doc.createElement('div');
  version.className = 'chatgoose-signin-version';
  version.textContent = `${COPY.rail.versionPrefix}${options.version}`;
  card.append(brand, title, subtitle, notice, fields, help, links, advanced);
  gate.append(card, version);
  options.root.append(gate);

  const placements = [
    { node: options.form, target: fields },
    { node: options.feedback, target: fields },
    { node: options.signOutStatus, target: fields },
    { node: options.helpLink, target: links },
    { node: options.advanced, target: advanced },
  ].map(({ node, target }) => {
    const marker = doc.createComment('sign-in control home');
    node.before(marker);
    return { node, target, marker };
  });
  let showing = false;
  const restore = (): void => {
    for (const { node, marker } of placements) marker.after(node);
  };
  return {
    update(required, rejected) {
      notice.hidden = !rejected;
      notice.textContent = rejected ? COPY.signInGate.rejected : '';
      options.cabinet.hidden = required;
      options.cabinet.inert = required;
      gate.hidden = !required;
      if (showing === required) return;
      showing = required;
      if (required) {
        for (const { node, target } of placements) target.append(node);
        // A fresh sign-out must not keep a previously typed password around.
        const password = options.form.querySelector<HTMLInputElement>('input[type="password"]');
        if (password) password.value = '';
        options.form.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.focus();
      } else {
        restore();
        options.cabinet.querySelector<HTMLElement>('.chatgoose-cabinet-item[aria-current="page"]')?.focus();
      }
    },
    dispose() {
      restore();
      for (const { marker } of placements) marker.remove();
      gate.remove();
    },
  };
}
