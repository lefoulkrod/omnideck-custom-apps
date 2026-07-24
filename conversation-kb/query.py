#!/usr/bin/env python3
"""
query.py — CLI interface to the Conversation Knowledge Base.

Lets agents (and humans) search past conversations from the command line.

Usage:
    python3 query.py "how did I set up the email routine"
    python3 query.py "fine tune model" --limit 3
    python3 query.py "Keycloak" --limit 5 --format json
    python3 query.py --conversation <conv_id>   # get full trajectory
    python3 query.py --stats                     # show KB stats
"""

import sys
import os
import json
import argparse

# Add the app directory to the path so we can import its functions
APP_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_DIR)

from app import search, get_conversation, get_stats, get_sync_status, sync


def format_search_results(result, fmt="text"):
    """Format search results for CLI output."""
    if fmt == "json":
        return json.dumps(result, indent=2, default=str)
    
    lines = []
    lines.append(f"Query: {result.get('query', '')}")
    lines.append(f"Searched {result.get('total_chunks_searched', 0)} chunks")
    lines.append("")
    
    for i, r in enumerate(result.get("results", []), 1):
        lines.append(f"{'='*60}")
        lines.append(f"{i}. {r['title']}")
        lines.append(f"   Date: {r['date']} | Score: {r['score']:.1%} | Matches: {r['match_count']}")
        lines.append(f"   ID: {r['conversation_id']}")
        lines.append(f"   Path: {r.get('events_path', 'N/A')}")
        lines.append("")
        
        for m in r.get("matches", [])[:3]:
            lines.append(f"   [{m['chunk_type']}] ({m['score']:.1%})")
            # Truncate and clean up the text
            text = m['chunk_text'].replace('\n', ' ').strip()
            if len(text) > 200:
                text = text[:200] + "..."
            lines.append(f"   {text}")
            lines.append("")
    
    return "\n".join(lines)


def format_conversation(conv, fmt="text"):
    """Format a full conversation for CLI output."""
    if fmt == "json":
        return json.dumps(conv, indent=2, default=str)
    
    if "error" in conv:
        return f"Error: {conv['error']}"
    
    lines = []
    lines.append(f"Title: {conv['title']}")
    lines.append(f"Date: {conv['date']}")
    lines.append(f"Events: {conv['num_events']} | Tool calls: {conv['num_tool_calls']} | User msgs: {conv['num_user_msgs']}")
    lines.append(f"Tokens: ~{conv['est_tokens']}")
    lines.append(f"{'='*60}")
    lines.append("")
    lines.append(conv.get("trajectory", "(no trajectory available)"))
    
    return "\n".join(lines)


def format_full_trajectory(conv_id, fmt="text", max_result_chars=2000):
    """Read the raw events.jsonl and format the full, uncompressed trajectory.
    
    This gives agents the complete picture: full tool call arguments, full
    thinking, full results (truncated only if extremely long).
    """
    import os as _os
    
    events_path = _os.path.join(CONV_DIR, conv_id, "events.jsonl")
    if not _os.path.exists(events_path):
        return f"Error: No events.jsonl found for conversation {conv_id}"
    
    # Load title
    meta_path = _os.path.join(CONV_DIR, conv_id, "metadata.json")
    title = "(no title)"
    if _os.path.exists(meta_path):
        try:
            import json as _json
            title = _json.load(open(meta_path)).get("title", "(no title)")
        except:
            pass
    
    events = []
    with open(events_path) as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except:
                pass
    
    if fmt == "json":
        return json.dumps({"conversation_id": conv_id, "title": title, "events": events}, indent=2, default=str)
    
    lines = []
    lines.append(f"# Conversation: {title}")
    lines.append(f"# ID: {conv_id}")
    lines.append(f"# Total events: {len(events)}")
    lines.append("")
    
    step_num = 0
    
    for evt in events:
        etype = evt.get("type")
        
        if etype == "user_message":
            content = evt.get("content") or ""
            lines.append(f"\n## USER MESSAGE:")
            lines.append(content)
            lines.append("")
        
        elif etype == "iteration":
            step_num += 1
            thinking = evt.get("thinking") or ""
            content = evt.get("content") or ""
            tool_calls = evt.get("tool_calls") or []
            
            lines.append(f"\n### Step {step_num}:")
            if thinking:
                lines.append(f"THINKING: {thinking}")
            
            for tc in tool_calls:
                tool_name = tc.get("name", "?")
                args = tc.get("arguments", {})
                # Full args, not truncated
                lines.append(f"  TOOL_CALL: {tool_name}({json.dumps(args, default=str)})")
            
            if content:
                lines.append(f"RESPONSE: {content}")
        
        elif etype == "tool_result":
            content = evt.get("content") or ""
            tool_name = evt.get("tool_name", "?")
            
            # Full result, but truncate if extremely long
            if len(content) > max_result_chars:
                preview = content[:max_result_chars]
                lines.append(f"  RESULT({tool_name}): {preview}")
                lines.append(f"  ... [truncated, {len(content)} total chars]")
            else:
                lines.append(f"  RESULT({tool_name}): {content}")
    
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Search the Conversation Knowledge Base")
    parser.add_argument("query", nargs="?", help="Search query")
    parser.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    parser.add_argument("--conversation", help="Get trajectory by conversation ID (use --full for complete uncompressed version)")
    parser.add_argument("--full", action="store_true", help="With --conversation: read raw events.jsonl for full detail (no truncation of tool calls, thinking, or results)")
    parser.add_argument("--max-result", type=int, default=2000, help="With --full: max chars per tool result (default 2000)")
    parser.add_argument("--stats", action="store_true", help="Show KB statistics")
    parser.add_argument("--sync", action="store_true", help="Sync new conversations")
    parser.add_argument("--sync-status", action="store_true", help="Check if sync needed")
    
    args = parser.parse_args()
    
    if args.stats:
        stats = get_stats()
        if args.format == "json":
            print(json.dumps(stats, indent=2, default=str))
        else:
            print(f"Conversations: {stats['total_conversations']}")
            print(f"Search chunks: {stats['total_chunks']}")
            print(f"Skills: {stats['total_skills']}")
            print(f"Memories: {stats['total_memories']}")
            print(f"Date range: {stats['date_range']['start']} → {stats['date_range']['end']}")
        return
    
    if args.sync_status:
        status = get_sync_status()
        if args.format == "json":
            print(json.dumps(status, indent=2, default=str))
        else:
            print(f"Indexed: {status['indexed']}")
            print(f"On disk: {status['on_disk']}")
            print(f"New: {status['new_conversations']}")
            print(f"Updated: {status['updated_conversations']}")
            print(f"Needs sync: {status['needs_sync']}")
        return
    
    if args.sync:
        result = sync(max_seconds=100)
        if args.format == "json":
            print(json.dumps(result, indent=2, default=str))
        else:
            print(result.get("message", str(result)))
            if result.get("remaining", 0) > 0:
                print(f"Remaining: {result['remaining']} — run again to continue")
        return
    
    if args.conversation:
        conv = get_conversation(args.conversation)
        print(format_conversation(conv, args.format))
        return
    
    if not args.query:
        parser.print_help()
        return
    
    result = search(args.query, limit=args.limit)
    
    if "error" in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)
    
    print(format_search_results(result, args.format))


if __name__ == "__main__":
    main()