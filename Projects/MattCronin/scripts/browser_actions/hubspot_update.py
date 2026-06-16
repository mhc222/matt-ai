#!/usr/bin/env python3
"""Deep HubSpot operations via BrowserUse (for actions beyond what the MCP supports).

Use this for: creating tasks, adding meeting notes, updating deal stages when
the MCP write operations aren't working, or doing multi-step HubSpot actions.

Usage:
  python3 scripts/browser_actions/hubspot_update.py --draft-id abc123 --dry-run
  python3 scripts/browser_actions/hubspot_update.py --draft-id abc123

  # Direct args:
  python3 scripts/browser_actions/hubspot_update.py \\
    --action add_note \\
    --contact-email "john@acme.com" \\
    --note "Called John, leaving voicemail. Will follow up via email." \\
    --dry-run
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.parent
sys.path.insert(0, str(Path(__file__).parent))

from jitter import pre_action, post_action

HUBSPOT_URL = "https://app.hubspot.com"

ACTION_TYPES = {
    "add_note": "Add a note to a contact or deal record",
    "update_stage": "Move a deal to a different pipeline stage",
    "create_task": "Create a follow-up task on a contact or deal",
    "log_call": "Log a call activity",
}


def load_draft(draft_id: str) -> dict:
    for subdir in ("pending", "processed"):
        path = BASE_DIR / "queue" / subdir / f"{draft_id}.json"
        if path.exists():
            return json.loads(path.read_text())
    raise FileNotFoundError(f"Draft {draft_id} not found")


def load_config() -> dict:
    return json.loads((BASE_DIR / "config" / "settings.json").read_text())


def build_task(
    action: str,
    contact_email: str = "",
    deal_name: str = "",
    note: str = "",
    new_stage: str = "",
    task_title: str = "",
    task_due_days: int = 1,
) -> str:
    base = f"""
You are updating a record in HubSpot CRM at {HUBSPOT_URL}.
Assume you are already logged in.

"""
    if action == "add_note":
        return base + f"""
1. Navigate to {HUBSPOT_URL}/contacts
2. Search for contact: {contact_email or deal_name}
3. Open the contact record
4. Click "Add note" or the Notes activity option
5. Type this note exactly: {note}
6. Click Save / Add note
7. Confirm the note appears in the activity feed
"""

    elif action == "update_stage":
        return base + f"""
1. Navigate to {HUBSPOT_URL}/deals
2. Find the deal named: "{deal_name}"
3. Open the deal record
4. Change the Deal Stage to: "{new_stage}"
5. Save the change
6. Confirm the stage now shows "{new_stage}"
"""

    elif action == "create_task":
        return base + f"""
1. Navigate to {HUBSPOT_URL}/contacts or deals
2. Search for: {contact_email or deal_name}
3. Open the record
4. Create a new task with title: "{task_title}"
5. Set due date to {task_due_days} business day(s) from today
6. Assign it to Matt Cronin (the logged-in user)
7. Save the task
"""

    elif action == "log_call":
        return base + f"""
1. Navigate to {HUBSPOT_URL}/contacts
2. Search for: {contact_email}
3. Open the contact record
4. Log a call activity
5. Add this note to the call log: {note}
6. Set the call outcome to "Left voicemail" or the appropriate outcome
7. Save the activity log
"""

    else:
        raise ValueError(f"Unknown action: {action}. Valid: {list(ACTION_TYPES.keys())}")


async def update_via_browseruse(task: str) -> bool:
    try:
        from browser_use import Agent, BrowserConfig, Browser
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        print("ERROR: browser-use or langchain-anthropic not installed.")
        return False

    cfg = load_config()["browser"]
    cdp_port = cfg.get("use_cdp_port", 9222)

    try:
        browser = Browser(
            config=BrowserConfig(
                headless=cfg.get("headless", False),
                cdp_url=f"http://localhost:{cdp_port}",
            )
        )
    except Exception:
        import os
        profile_path = os.path.expanduser(cfg.get("chrome_user_data_dir", ""))
        browser = Browser(
            config=BrowserConfig(
                headless=cfg.get("headless", False),
                extra_chromium_args=[
                    f"--user-data-dir={profile_path}",
                    f"--profile-directory={cfg.get('chrome_profile', 'Default')}",
                ] if profile_path else [],
            )
        )

    llm = ChatAnthropic(model="claude-opus-4-8", temperature=0)
    agent = Agent(task=task, llm=llm, browser=browser)

    pre_action()
    await agent.run()
    post_action()

    await browser.close()
    return True


def main():
    parser = argparse.ArgumentParser(description="Deep HubSpot operations via BrowserUse")
    parser.add_argument("--draft-id", help="Load from queue")
    parser.add_argument("--action", choices=list(ACTION_TYPES.keys()),
                        help="What to do in HubSpot")
    parser.add_argument("--contact-email", default="")
    parser.add_argument("--deal-name", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--new-stage", default="")
    parser.add_argument("--task-title", default="")
    parser.add_argument("--task-due-days", type=int, default=1)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.draft_id:
        item = load_draft(args.draft_id)
        ctx = item.get("context", {})
        draft = item.get("draft", {})
        action = draft.get("action") or ctx.get("hubspot_action", "add_note")
        contact_email = ctx.get("contact_email", "")
        deal_name = ctx.get("deal_name", "")
        note = draft.get("note") or draft.get("body", "")
        new_stage = draft.get("new_stage", "")
        task_title = draft.get("task_title", "")
        task_due_days = draft.get("task_due_days", 1)
    else:
        if not args.action:
            parser.error("Provide --draft-id or --action")
        action = args.action
        contact_email = args.contact_email
        deal_name = args.deal_name
        note = args.note
        new_stage = args.new_stage
        task_title = args.task_title
        task_due_days = args.task_due_days

    task = build_task(
        action=action,
        contact_email=contact_email,
        deal_name=deal_name,
        note=note,
        new_stage=new_stage,
        task_title=task_title,
        task_due_days=task_due_days,
    )

    if args.dry_run:
        print("DRY RUN — no HubSpot changes will be made\n")
        print(f"Action: {action}")
        print(f"Contact: {contact_email}")
        print(f"Deal: {deal_name}")
        print(f"\nBrowserUse task that would run:\n{task}")
        return

    print(f"\nRunning HubSpot {action} via BrowserUse...")
    success = asyncio.run(update_via_browseruse(task))

    if success:
        print("HubSpot update completed.")
        if args.draft_id:
            import subprocess
            log_script = BASE_DIR / "scripts" / "queue_manager.py"
            subprocess.run([
                sys.executable, str(log_script),
                "executed", "--draft-id", args.draft_id, "--result", action
            ])
    else:
        print("HubSpot update failed. See output above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
