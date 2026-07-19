import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';

const dashboard = {
  projects: [],
  stats: {
    projects: 0,
    conversations: 2,
    conversation_bytes: 2048,
    artifacts: 1,
    artifact_bytes: 1024,
    unassigned: 3,
    missing_artifacts: 0,
    orphaned_artifacts: 0,
  },
  recent: { conversations: [], artifacts: [] },
  attention: {
    unassigned_conversations: 2,
    unassigned_artifacts: 1,
    missing_artifacts: 0,
    orphaned_artifacts: 0,
  },
  roots: {},
  last_storage_scan: null,
};

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf8');
  document.open();
  document.write(html);
  document.close();
  window.omnideck = {
    invoke: vi.fn(async (action) => {
      if (action === 'get_dashboard') return dashboard;
      throw new Error(`Unexpected action: ${action}`);
    }),
    chat: { open: vi.fn(), compose: vi.fn() },
  };
  window.location.hash = '#/home';
  await import('../../web/main.js');
});

it('renders the home overview from backend data', async () => {
  await vi.waitFor(() => {
    expect(document.querySelector('#content')?.textContent).toContain(
      'Make sense of what Omnideck creates.',
    );
  });
  expect(document.querySelector('#inbox-badge')?.textContent).toBe('3');
});

it('opens the project form from the primary action', async () => {
  document.querySelector('#new-project').click();
  expect(document.querySelector('#project-modal').hidden).toBe(false);
  await vi.waitFor(() => {
    expect(document.querySelector('#project-name')).toBe(document.activeElement);
  });
});
