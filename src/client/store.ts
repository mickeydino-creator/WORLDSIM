// Minimal external store (useSyncExternalStore) for client game state.
// Selector results are memoised per state snapshot and compared shallowly, so selectors may
// return derived arrays/objects without triggering render loops.
import { useRef, useSyncExternalStore } from 'react';

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const plain = (x: object) => Array.isArray(x) || Object.getPrototypeOf(x) === Object.prototype;
  if (!plain(a) || !plain(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe,
    use<S>(selector: (s: T) => S): S {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const cache = useRef<{ state: T; selector: (s: T) => S; value: S } | null>(null);
      const snapshot = () => {
        const c = cache.current;
        if (c && c.state === state && c.selector === selector) return c.value;
        const value = selector(state);
        if (c && shallowEqual(c.value, value)) {
          cache.current = { state, selector, value: c.value };
          return c.value;
        }
        cache.current = { state, selector, value };
        return value;
      };
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(subscribe, snapshot, snapshot);
    },
  };
}
