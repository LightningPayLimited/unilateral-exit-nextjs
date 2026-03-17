/**
 * localStorage persistence for broadcast state.
 */

import type { ExitState } from './types';

const STORAGE_KEY = 'unilateral-exit-state';

export async function saveState(state: ExitState): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save exit state:', e);
  }
}

export async function loadState(): Promise<ExitState | null> {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json) as ExitState;
  } catch (e) {
    console.error('Failed to load exit state:', e);
    return null;
  }
}

export async function clearState(): Promise<void> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear exit state:', e);
  }
}
