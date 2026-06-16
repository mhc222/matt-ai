#!/usr/bin/env python3
"""Send an approved email draft via Outlook Web using BrowserUse.

Runs locally on Mac. Requires:
  - pip install browser-use langchain-anthropic playwright
  - playwright install chromium
  - Chrome running, logged into Outlook Web (https://outlook.office.com/mail/)
    OR set ANTHROPIC_API_KEY and let the script launch its own browser.

Usage:
  # Dry run (shows what would be sent, no browser):
  python3 scripts/browser_actions/send_email.py --draft-id abc123 --dry-run

  # Live send:
  python3 scripts/browser_actions/send_email.py --draft-id abc123

  # Direct args (without a queue draft):
  python3 scripts/browser_actions/send_email.py --to "john@acme.com" --subject "Hi" --body "..."
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
    path = BASE_DIR / "queue" / "pending" / f"{draft_id}.json"
    if not path.exists():
        # Also check processed (approved but not yet executed)
        path = BASE_DIR / "queue" / "processed" / f"{draft_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Draft {draft_id} not found in queue")
    item = json.loads(path.read_text())
    return item["draft"]


def load_config() -> dict:
    return json.loads((BASE_DIR / "config" / "settings.json").read_text())


def check_send_budget() -> tuple[int, int]:
    """Returns (sent_today, max_daily). Raises if over limit."""
    cfg = load_config()
    max_sends = cfg["email"]["max_daily_sends"]
    today = __import__("datetime").date.today().isoformat()
    processed_dir = BASE_DIR / "queue" / "processed"
    sent_today = 0
    if processed_dir.exists():
        for f in processed_dir.glob("*.json"):
            try:
                item = json.loads(f.read_text())
                if (
                    item.get("status") == "executed"
                    and item.get("executed_at", "").startswith(today)
                    and item.get("type") in ("email_reply", "outreach")
                ):
                    sent_today += 1
            except Exception:
                pass
    return sent_today, max_sends


async def send_via_browseruse(
    to: str,
    subject: str,
    body: str,
    cc: str = "",
) -> bool:
    """Use BrowserUse agent to send an email in Outlook Web."""
    try:
        from browser_use import Agent, BrowserConfig, Browser
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        print("ERROR: browser-use or langchain-anthropic not installed.")
        print("Run: pip install browser-use langchain-anthropic playwright && playwright install chromium")
        return False

    cfg = load_config()
    browser_cfg = cfg["browser"]
    outlook_url = cfg["outlook_web"]["base_url"]

    cc_instruction = ""
    if cc:
        cc_instruction = f"4. In the CC field, type: {cc}\n"

    task = f"""
You are helping send an email in Outlook Web App. Follow these steps exactly.

1. Navigate to {outlook_url} (the user is already logged in)
2. Wait for the inbox to load (2 seconds)
3. Click "New mail" button (usually top-left, may say "New message" or have a pencil/compose icon)
4. Wait 2 seconds for the compose window to open
5. In the To field, type exactly: {to}
   Then press Tab to confirm the address
6. {cc_instruction}In the Subject field, type exactly: {subject}
7. Click in the message body area
8. Type the following email body exactly as written — do NOT modify any content:

{body}

9. Wait 3 seconds
10. Click the Send button
11. Confirm that the email was sent (compose window closes or a "Sent" confirmation appears)

CRITICAL: Type the email body exactly as provided. Do not rephrase, summarize, or modify it.
CRITICAL: Do not add any disclaimer or signature beyond what is already in the body.
"""

    import os
    cdp_port = browser_cfg.get("use_cdp_port", 9222)

    try:
        browser = Browser(
            config=BrowserConfig(
                headless=browser_cfg.get("headless", False),
                cdp_url=f"http://localhost:{cdp_port}",
            )
        )
    except Exception:
        # Fall back: launch fresh browser with Chrome profile
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
    return True


def main():
    parser = argparse.ArgumentParser(description="Send email via Outlook Web")
    parser.add_argument("--draft-id", help="Load from queue/pending/ or queue/processed/")
    parser.add_argument("--to", help="Recipient email(s), comma-separated")
    parser.add_argument("--subject", help="Email subject")
    parser.add_argument("--body", help="Email body text (or path to .txt file)")
    parser.add_argument("--cc", default="", help="CC recipient(s)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be sent, no browser")
    args = parser.parse_args()

    # Load fields
    if args.draft_id:
        draft = load_draft(args.draft_id)
        to = draft["to"]
        subject = draft["subject"]
        body = draft["body"]
        cc = draft.get("cc", "")
    else:
        if not args.to or not args.subject:
            parser.error("Provide --draft-id or both --to and --subject")
        to = args.to
        subject = args.subject
        body = args.body or ""
        if body and body.endswith(".txt") and Path(body).exists():
            body = Path(body).read_text()
        cc = args.cc

    if dry_run := args.dry_run:
        print("DRY RUN — no email will be sent\n")
        print(f"  To:      {to}")
        if cc:
            print(f"  CC:      {cc}")
        print(f"  Subject: {subject}")
        print(f"  Body:\n")
        print(body)
        print("\nRun without --dry-run to send.")
        return

    # Check send budget
    sent_today, max_sends = check_send_budget()
    if sent_today >= max_sends:
        print(f"ERROR: Daily send limit reached ({sent_today}/{max_sends}). Not sending.")
        sys.exit(1)
    print(f"Send budget: {sent_today}/{max_sends} sent today. OK to proceed.")

    print(f"\nSending via BrowserUse to: {to}")
    print(f"Subject: {subject}")

    success = asyncio.run(send_via_browseruse(to, subject, body, cc))

    if success:
        print("\nEmail sent successfully.")
        if args.draft_id:
            # Auto-log execution
            log_script = BASE_DIR / "scripts" / "queue_manager.py"
            import subprocess
            subprocess.run([
                sys.executable, str(log_script),
                "executed", "--draft-id", args.draft_id, "--result", "sent"
            ])
    else:
        print("\nFailed to send email. Check BrowserUse output above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
