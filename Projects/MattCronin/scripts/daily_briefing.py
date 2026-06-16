#!/usr/bin/env python3
"""Session start briefing for the Matt Cronin Sales Agent.

Runs automatically via the SessionStart hook. Reads queue state, checks
timestamps, and prints context for Claude to act on.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
QUEUE_PENDING = BASE_DIR / "queue" / "pending"
QUEUE_PROCESSED = BASE_DIR / "queue" / "processed"
CONFIG_FILE = BASE_DIR / "config" / "settings.json"
LAST_RUN_FILE = BASE_DIR / "queue" / ".last_run"

def load_config():
    return json.loads(CONFIG_FILE.read_text())

def read_last_run() -> str:
    if LAST_RUN_FILE.exists():
        return LAST_RUN_FILE.read_text().strip()
    return "never"

def write_last_run():
    QUEUE_PENDING.parent.mkdir(parents=True, exist_ok=True)
    LAST_RUN_FILE.write_text(datetime.now(timezone.utc).isoformat())

def count_processed_today() -> int:
    today = datetime.now().date().isoformat()
    count = 0
    if QUEUE_PROCESSED.exists():
        for f in QUEUE_PROCESSED.glob("*.json"):
            try:
                item = json.loads(f.read_text())
                executed_at = item.get("executed_at", "")
                if executed_at.startswith(today) and item.get("status") == "executed":
                    count += 1
            except Exception:
                pass
    return count

def list_pending() -> list:
    QUEUE_PENDING.mkdir(parents=True, exist_ok=True)
    items = []
    for f in sorted(QUEUE_PENDING.glob("*.json")):
        try:
            items.append(json.loads(f.read_text()))
        except Exception:
            pass
    return items

def main():
    cfg = load_config()
    now = datetime.now()
    last_run = read_last_run()
    pending = list_pending()
    sent_today = count_processed_today()
    max_sends = cfg["email"]["max_daily_sends"]

    print("=" * 60)
    print(f"MATT CRONIN SALES AGENT — Daily Briefing")
    print(f"Session opened: {now.strftime('%A, %B %d %Y at %I:%M %p')}")
    print(f"Last session:   {last_run}")
    print("=" * 60)

    print(f"\nEMAIL BUDGET: {sent_today}/{max_sends} sent today")

    if pending:
        print(f"\nPENDING QUEUE ({len(pending)} items awaiting your approval):")
        for item in pending:
            item_type = item.get("type", "unknown").upper()
            created = item.get("created_at", "")[:16].replace("T", " ")
            context = item.get("context", {})
            company = context.get("company", "Unknown")
            contact = context.get("from_name", context.get("contact_name", "Unknown"))
            print(f"  [{item['id']}] {item_type} — {contact} @ {company} (queued {created})")
        print(f"\n  Run: python3 scripts/queue_manager.py list   to see full drafts")
    else:
        print("\nPENDING QUEUE: Empty — no items awaiting approval")

    print("\n" + "=" * 60)
    print("STARTING SESSION ROUTINE")
    print("=" * 60)
    print("""
Claude: now run your session start routine from CLAUDE.md:

1. Pull unread email via Outlook MCP (last 24 hours)
2. Pull open deals via HubSpot MCP — flag stale ones
3. Check Slack for prospect/customer mentions
4. Research any new senders or stale deal companies
5. Draft action queue, ranked by urgency + deal value
6. Post drafts to #matt-agent-approvals in Slack
7. Poll for Matt's replies and execute approved items

Read persona.md and config/settings.json for context before drafting.
""")

    write_last_run()

if __name__ == "__main__":
    main()
