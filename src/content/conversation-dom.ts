export interface ActiveConversationDom {
  routeRoot: HTMLElement;
  container: HTMLElement;
  inputHost: HTMLElement;
  inputParent: HTMLElement;
  displayName: string | null;
}

const ROUTE_ROOT_SELECTOR = 'app-messages-conversation-route';
const INPUT_HOST_SELECTOR = 'app-group-message-input';
const USER_NAME_SELECTOR = 'app-account-username .user-name';
const COMPOSER_LABEL_SELECTOR = 'app-group-message-input .label';
const TEXTAREA_SELECTORS = [
  'app-group-message-input textarea',
  'textarea.message-input',
  'textarea[placeholder*="message"]',
];

function getActiveConversationRouteRoot(): HTMLElement | null {
  const routeRoot = document.querySelector(ROUTE_ROOT_SELECTOR);
  return routeRoot instanceof HTMLElement ? routeRoot : null;
}

function parseDisplayName(text: string): string | null {
  const match = /@([^\s]+)/.exec(text);
  return match?.[1] ?? (text.replace(/^Message\s+/i, '').trim() || null);
}

function getDirectTextContent(element: HTMLElement): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .trim();
}

function resolveDisplayName(routeRoot: ParentNode): string | null {
  const userName = routeRoot.querySelector(USER_NAME_SELECTOR);
  if (userName instanceof HTMLElement) {
    const directText = getDirectTextContent(userName);
    if (directText) {
      return parseDisplayName(directText);
    }
  }

  const composerLabel = routeRoot.querySelector(COMPOSER_LABEL_SELECTOR);
  if (!(composerLabel instanceof HTMLElement)) {
    return null;
  }

  const text = composerLabel.textContent?.trim() ?? '';
  if (!text) {
    return null;
  }

  return parseDisplayName(text);
}

function isUsableTextarea(element: Element | null): element is HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement &&
    !element.disabled &&
    !element.readOnly &&
    element.offsetParent !== null
  );
}

export function getActiveConversationDom(): ActiveConversationDom | null {
  const routeRoot = getActiveConversationRouteRoot();
  if (!routeRoot) {
    return null;
  }

  const inputHost = routeRoot.querySelector(INPUT_HOST_SELECTOR);
  if (!(inputHost instanceof HTMLElement) || !inputHost.parentElement) {
    return null;
  }

  const container = inputHost.closest('app-group-message-container');
  if (!(container instanceof HTMLElement)) {
    return null;
  }

  return {
    routeRoot,
    container,
    inputHost,
    inputParent: inputHost.parentElement,
    displayName: resolveDisplayName(routeRoot),
  };
}

export function getActiveConversationDisplayName(): string | null {
  const routeRoot = getActiveConversationRouteRoot();
  if (!routeRoot) {
    return null;
  }

  return resolveDisplayName(routeRoot);
}

export function findActiveConversationTextarea(): HTMLTextAreaElement | null {
  const conversation = getActiveConversationDom();
  if (!conversation) {
    return null;
  }

  for (const selector of TEXTAREA_SELECTORS) {
    const candidate = conversation.container.querySelector(selector);
    if (isUsableTextarea(candidate)) {
      return candidate;
    }
  }

  return null;
}
