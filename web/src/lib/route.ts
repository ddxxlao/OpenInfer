import {useSyncExternalStore} from 'react';

export type Route =
  | {page: 'home'}
  | {page: 'devices'}
  | {page: 'sessions'}
  | {page: 'new_session'}
  | {page: 'session'; id: string}
  | {page: 'api_keys'};

export function parseRoute(hash: string): Route {
  const [, section, rest] = hash.replace(/^#/, '').split('/');
  if (section === 'home' || !section) return {page: 'home'};
  if (section === 'devices') return {page: 'devices'};
  if (section === 'api-keys') return {page: 'api_keys'};
  if (section === 'sessions') {
    if (!rest) return {page: 'sessions'};
    return rest === 'new' ? {page: 'new_session'} : {page: 'session', id: rest};
  }
  return {page: 'devices'};
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
