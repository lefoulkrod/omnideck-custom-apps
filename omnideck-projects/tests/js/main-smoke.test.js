import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';

const dashboard = {
  first_run: true,
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

const conversation = {
  type: 'conversation', id: 'chat-1', title: 'Garden research', turn_count: 2,
  event_count: 12, size: 2048, artifact_count: 1, artifact_bytes: 1024, total_size: 3072,
  first_message: 'Plan the garden', started_at: '2026-07-01T10:00:00Z',
  last_activity: '2026-07-01T10:10:00Z', projects: [],
};

const conversationDetails = {
  conversation,
  storage: {
    total: 2048, file_count: 2, complete: true,
    categories: [{ key: 'events', label: 'Event history', size: 1900, file_count: 1, percent: 92.8 }],
    files: [{ name: 'events.jsonl', relative_path: 'events.jsonl', size: 1900, category: 'events' }],
  },
  agent_activity: {
    spawned_count: 1, totals: { turns: 2, tool_results: 3, outputs: 1 },
    agents: [{
      id: 'root.researcher.2', name: 'Researcher',
      status: 'completed', started_at: '2026-07-01T10:01:00Z',
      completed_at: '2026-07-01T10:09:00Z', turn_count: 2,
      tool_result_count: 3, output_count: 1, spawned: true,
    }],
  },
  artifact_summary: { count: 1, present_count: 1, missing_count: 0, bytes: 1024 },
  artifacts: [{
    type: 'artifact', id: 'artifact-1', title: 'garden.md', status: 'present',
    path: '/home/omnideck/garden.md', size: 1024, projects: [], agent_name: 'Researcher',
  }],
  related_bytes: 3072,
};

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf8');
  document.open();
  document.write(html);
  document.close();
  window.omnideck = {
    invoke: vi.fn(async (action) => {
      if (action === 'get_dashboard') return dashboard;
      if (action === 'list_conversations') return { conversations: [conversation], total: 1, returned: 1 };
      if (action === 'get_conversation_details') return conversationDetails;
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
  expect(document.querySelector('.welcome-panel')).not.toBeNull();
  expect(document.querySelector('#ask-omnideck')).toBeNull();
  expect(document.querySelector('[data-route="conversations"] .bi-chat-left-text')).not.toBeNull();
});

it('shows the welcome banner only on the first home load', async () => {
  document.querySelector('#refresh-button').click();
  await vi.waitFor(() => expect(document.querySelector('.welcome-panel')).toBeNull());
});

it('expands conversation storage, artifact, and spawned-agent details', async () => {
  window.location.hash = '#/conversations';
  await vi.waitFor(() => {
    expect(document.querySelector('[data-action="conversation-details"]')).not.toBeNull();
  });
  expect(document.querySelector('[data-filter="conversations-artifacts"]')?.textContent).toContain('Has artifacts');
  expect(document.querySelector('[data-filter="conversations-sort"]')?.textContent).toContain('Largest total storage');
  document.querySelector('[data-action="conversation-details"]').click();
  await vi.waitFor(() => {
    expect(document.querySelector('.conversation-details')?.textContent).toContain('Spawned agent 1');
  });
  expect(document.querySelector('.conversation-details')?.textContent).not.toContain('Root agent');
  expect(document.querySelector('.conversation-details')?.textContent).toContain('2 turns');
  expect(document.querySelector('.conversation-details')?.textContent).toContain('Event history');
  document.querySelector('[data-action="ask-conversation-details"]').click();
  expect(window.omnideck.chat.compose).toHaveBeenLastCalledWith(expect.objectContaining({
    context: expect.objectContaining({ kind: 'omnideck-resource' }),
  }));
});

it('opens the project form from the primary action', async () => {
  document.querySelector('#new-project').click();
  expect(document.querySelector('#project-modal').hidden).toBe(false);
  await vi.waitFor(() => {
    expect(document.querySelector('#project-name')).toBe(document.activeElement);
  });
});
