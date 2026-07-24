#!/usr/bin/env python3
"""
run_extraction.py — Run skill extraction on conversations.

Usage:
    python3 run_extraction.py                    # Process all pending conversations
    python3 run_extraction.py --model gemma3:27b  # Use a specific model
    python3 run_extraction.py --new-only          # Only process conversations added since last sync
"""
import sys
import time
import argparse

sys.path.insert(0, '/home/omnideck/apps/conversation-kb')
from app import process_skills_batch, get_skill_status, sync

def main():
    parser = argparse.ArgumentParser(description="Run skill extraction")
    parser.add_argument("--model", default="gpt-oss:120b", help="Ollama model to use")
    parser.add_argument("--new-only", action="store_true", help="Sync first, then only process new conversations")
    parser.add_argument("--max-batch-seconds", type=int, default=100, help="Max seconds per batch")
    args = parser.parse_args()

    # If --new-only, sync the search index first to pick up new conversations
    if args.new_only:
        print("Syncing search index for new conversations...")
        sync_result = sync(max_seconds=100)
        print(f"  {sync_result.get('message', sync_result)}")
        print()

    status = get_skill_status()
    print(f"Before: {status['skills_extracted']} skills extracted, {status['pending']} pending")
    print(f"Model: {args.model}")
    print()

    if status['pending'] == 0:
        print("Nothing to do — all conversations have skills extracted.")
        return

    total_processed = 0
    total_skipped = 0
    batch_num = 0

    while True:
        batch_num += 1
        result = process_skills_batch(model=args.model, max_seconds=args.max_batch_seconds)

        if 'error' in result:
            print(f"Batch {batch_num}: ERROR: {result['error']}", flush=True)
            break

        total_processed += result.get('processed', 0) - result.get('skipped_low_value', 0)
        total_skipped += result.get('skipped_low_value', 0)
        remaining = result.get('remaining', 0)

        print(f"Batch {batch_num}: {result['message']} | Total skills: {total_processed} | Skipped: {total_skipped} | Remaining: {remaining}", flush=True)

        if result.get('processed', 0) == 0 and remaining > 0:
            print("No progress, stopping", flush=True)
            break

        if remaining == 0:
            break

        time.sleep(1)

    # Final status
    status = get_skill_status()
    print(f"\nDone! {status['skills_extracted']} skills extracted, {status['pending']} pending", flush=True)
    for t, c in sorted(status.get('type_counts', {}).items()):
        print(f"  {t}: {c}", flush=True)


if __name__ == "__main__":
    main()