import type {
  RuntimeRequestMap,
  RuntimeResponseMap,
} from './types.js';

export type RuntimeRequestType = keyof RuntimeRequestMap;

type RuntimeRequest<K extends RuntimeRequestType = RuntimeRequestType> = {
  [RequestType in RuntimeRequestType]: RuntimeRequestMap[RequestType] extends undefined
    ? { type: RequestType }
    : { type: RequestType } & NonNullable<RuntimeRequestMap[RequestType]>;
}[K];

type OptionalRuntimeRequestType = {
  [RequestType in RuntimeRequestType]: undefined extends RuntimeRequestMap[RequestType]
    ? RequestType
    : never;
}[RuntimeRequestType];

type RequiredRuntimeRequestType = Exclude<
  RuntimeRequestType,
  OptionalRuntimeRequestType
>;

/**
 * Leaf runtime-request client shared by extension pages and content modules.
 * Keep this module type-only apart from browser.runtime.sendMessage: importing
 * a one-line sender must not pull protocol validators and feature policy into
 * small popup/debug bundles.
 */
export function sendRuntimeRequest<K extends OptionalRuntimeRequestType>(
  type: K,
  payload?: NonNullable<RuntimeRequestMap[K]>,
): Promise<RuntimeResponseMap[K]>;
export function sendRuntimeRequest<K extends RequiredRuntimeRequestType>(
  type: K,
  payload: RuntimeRequestMap[K],
): Promise<RuntimeResponseMap[K]>;
export async function sendRuntimeRequest<K extends RuntimeRequestType>(
  type: K,
  payload?: NonNullable<RuntimeRequestMap[K]>,
): Promise<RuntimeResponseMap[K]> {
  const request = (
    payload === undefined
      ? { type }
      : { type, ...payload }
  ) as RuntimeRequest<K>;
  return await browser.runtime.sendMessage(request) as RuntimeResponseMap[K];
}
