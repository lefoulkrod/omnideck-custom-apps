#!/usr/bin/env python3
"""Run failure pattern extraction with 35B model + keep_alive."""
import sys, time, requests, os

sys.path.insert(0, '/home/omnideck/apps/conversation-kb')

# Warm up the 35B model
print('Warming up 35B model...', flush=True)
requests.post('http://localhost:11434/api/chat', json={
    'model': 'huihui_ai/qwen3.5-abliterated:35b',
    'messages': [{'role': 'user', 'content': 'Say OK'}],
    'stream': False,
    'options': {'temperature': 0.1, 'num_ctx': 1024, 'keep_alive': '30m'},
}, timeout=300)
print('Model warmed up. Starting extraction...', flush=True)

from extraction import extract_failure_patterns

total_new = 0
total_skipped = 0
batch = 0
while True:
    batch += 1
    result = extract_failure_patterns(model='huihui_ai/qwen3.5-abliterated:35b', max_seconds=90)
    if 'error' in result:
        print(f'Batch {batch}: ERROR: {result["error"]}', flush=True)
        break
    total_new += result.get('patterns_extracted', 0)
    total_skipped += result.get('skipped', 0)
    print(f'Batch {batch}: {result["message"]} | Total: {total_new} new, {total_skipped} skipped', flush=True)
    if result.get('processed', 0) == 0:
        print('Done!', flush=True)
        break
    time.sleep(1)

print(f'Final: {total_new} new patterns, {total_skipped} skipped', flush=True)