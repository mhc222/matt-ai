#!/usr/bin/env python3
"""Enroll a contact in an Apollo sequence using BrowserUse.

Runs locally on Mac. Requires Chrome logged into Apollo (https://app.apollo.io).

Usage:
  python3 scripts/browser_actions/enroll_sequence.py --draft-id abc123 --dry-run
  python3 scripts/browser_actions/enroll_sequence.py --draft-id abc123

  # Direct args:
  python3 scripts/browser_actions/enroll_sequence.py \\
    --contact-email "john@acme.com" \\
    --contact-name "John Smith" \\
    --sequence-name "Enterprise Cold Outreach" \\
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


def load_draft(draft_id: str) -> dict:
    for subdir in ("pending", "processed"):
        path = BASE_DIR / "queue" / subdir / f"{draft_id}.json"
        if path.exists():
            item = json.loads(path.read_text())
            return item
    raise FileNotFoundError(f"Draft {draft_id} not found")


def load_config() -> dict:
    return json.loads((BASE_DIR / "config" / "settings.json").read_text())


async def enroll_via_browseruse(
    contact_email: str,
    contact_name: str,
    sequence_name: str,
    sender_email: str,
) -> bool:
    try:
        from browser_use import Agent, BrowserConfig, Browser
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        print("ERROR: browser-use or langchain-anthropic not installed.")
        return False

    cfg = load_config()
    browser_cfg = cfg["browser"]
    apollo_url = cfg["apollo"]["base_url"]
    cdp_port = browser_cfg.get("use_cdp_port", 9222)

    task = f"""
You are enrolling a contact in an Apollo sequence. Follow these steps exactly.

1. Navigate to {apollo_url} (assume already logged in)
2. Search for the contact: {contact_email} or "{contact_name}"
   - Use the search bar or go to Contacts section
3. Open the contact's profile
4. Verify this is the correct person: email should be {contact_email}
5. Check if this contact is already enrolled in any active sequence.
   - If they ARE already in an active sequence, STOP and report "Contact already in sequence: [sequence name]"
6. If not in a sequence, click "Add to Sequence" or "Enroll in Sequence"
7. Search for and select the sequence named exactly: "{sequence_name}"
8. Select the sender mailbox: {sender_email}
9. Review the enrollment details and confirm/submit
10. Confirm the enrollment was successful

CRITICAL: Do NOT enroll if the contact is already in an active sequence.
CRITICAL: Select exactly the sequence named "{sequence_name}" — do not pick a similar one.
"""

    try:
        browser = Browser(
            config=BrowserConfig(
                headless=browser_cfg.get("headless", False),
                cdp_url=f"http://localhost:{cdp_port}",
            )
        )
    except Exception:
        import os
        profile_path = os.path.expanduser(browser_cfg.get("chrome_user_data_dir", ""))
        browser = Browser(
            config=BrowserConfig(
                headless=browser_cfg.get("headless", False),
                extra_chromium_args=[
                    f"--user-data-dir={profile_path}",
                    f"--profile-directory={browser_cfg.get('chrome_profile', 'Default')}",
                ] if profile_path else [],
            )
        )

    llm = ChatAnthropic(model="claude-opus-4-8", temperature=0)
    agent = Agent(task=task, llm=llm, browser=browser)

    pre_action()
    result = await agent.run()
    post_action()

    await browser.close()

    result_str = str(result).lower()
    if "already in sequence" in result_str:
        print(f"STOPPED: Contact is already enrolled in a sequence.")
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="Enroll contact in Apollo sequence")
    parser.add_argument("--draft-id", help="Load from queue")
    parser.add_argument("--contact-email", help="Contact's email address")
    parser.add_argument("--contact-name", help="Contact's full name")
    parser.add_argument("--sequence-name", help="Exact sequence name in Apollo")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cfg = load_config()
    sender_email = cfg["vibes"]["sender_email"]

    if args.draft_id:
        item = load_draft(args.draft_id)
        ctx = item.get("context", {})
        draft = item.get("draft", {})
        contact_email = ctx.get("contact_email") or draft.get("to", "")
        contact_name = ctx.get("contact_name") or ctx.get("from_name", "")
        sequence_name = draft.get("sequence_name") or ctx.get("sequence_name", "")
    else:
        if not args.contact_email or not args.sequence_name:
            parser.error("Provide --draft-id or --contact-email and --sequence-name")
        contact_email = args.contact_email
        contact_name = args.contact_name or ""
        sequence_name = args.sequence_name

    if args.dry_run:
        print("DRY RUN — no Apollo enrollment will happen\n")
        print(f"  Contact: {contact_name} <{contact_email}>")
        print(f"  Sequence: {sequence_name}")
        print(f"  Sender:  {sender_email}")
        print("\nRun without --dry-run to enroll.")
        return

    print(f"\nEnrolling {contact_name} <{contact_email}> in sequence: {sequence_name}")
    success = asyncio.run(
        enroll_via_browseruse(contact_email, contact_name, sequence_name, sender_email)
    )

    if success:
        print("Enrollment successful.")
        if args.draft_id:
            import subprocess
            log_script = BASE_DIR / "scripts" / "queue_manager.py"
            subprocess.run([
                sys.executable, str(log_script),
                "executed", "--draft-id", args.draft_id, "--result", f"enrolled in {sequence_name}"
            ])
    else:
        print("Enrollment failed or skipped. See output above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
