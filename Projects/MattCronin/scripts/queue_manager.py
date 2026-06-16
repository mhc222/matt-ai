#!/usr/bin/env python3
"""Manage the draft/action queue for the Matt Cronin Sales Agent.

Usage:
  python3 scripts/queue_manager.py list
  python3 scripts/queue_manager.py save --type email_reply --to "..." --subject "..." --body-file /tmp/draft.txt --context '{"company": "..."}'
  python3 scripts/queue_manager.py approve --draft-id abc123
  python3 scripts/queue_manager.py skip --draft-id abc123 [--reason "..."]
  python3 scripts/queue_manager.py executed --draft-id abc123 [--result "sent"]
  python3 scripts/queue_manager.py get --draft-id abc123
"""
import argparse
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
PENDING_DIR = BASE_DIR / "queue" / "pending"
PROCESSED_DIR = BASE_DIR / "queue" / "processed"


def _ensure_dirs():
    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)


def save_draft(
    item_type: str,
    context: dict,
    draft: dict | None = None,
    to: str = "",
    subject: str = "",
    body: str = "",
    cc: str = "",
) -> str:
    _ensure_dirs()
    draft_id = uuid.uuid4().hex[:8]
    if draft is None:
        draft = {"to": to, "subject": subject, "body": body, "cc": cc}
    item = {
        "id": draft_id,
        "type": item_type,
        "created_at": datetime.now().isoformat(),
        "status": "pending",
        "context": context,
        "draft": draft,
    }
    (PENDING_DIR / f"{draft_id}.json").write_text(json.dumps(item, indent=2))
    print(f"Saved: {draft_id}")
    return draft_id


def list_pending(verbose: bool = False) -> list:
    _ensure_dirs()
    items = []
    for f in sorted(PENDING_DIR.glob("*.json")):
        try:
            items.append(json.loads(f.read_text()))
        except Exception as e:
            print(f"Warning: could not read {f.name}: {e}", file=sys.stderr)
    if not items:
        print("No pending items.")
        return items
    for item in items:
        ctx = item.get("context", {})
        company = ctx.get("company", "?")
        contact = ctx.get("from_name", ctx.get("contact_name", "?"))
        created = item.get("created_at", "")[:16].replace("T", " ")
        print(f"\n[{item['id']}] {item['type'].upper()} — {contact} @ {company} ({created})")
        if verbose:
            draft = item.get("draft", {})
            print(f"  To:      {draft.get('to', '')}")
            print(f"  Subject: {draft.get('subject', '')}")
            body_preview = draft.get("body", "")[:200].replace("\n", " ")
            print(f"  Body:    {body_preview}...")
            if ctx:
                print(f"  Context: {json.dumps(ctx, indent=4)}")
    return items


def get_draft(draft_id: str) -> dict:
    path = PENDING_DIR / f"{draft_id}.json"
    if not path.exists():
        # Check processed too
        path = PROCESSED_DIR / f"{draft_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Draft {draft_id} not found")
    return json.loads(path.read_text())


def approve(draft_id: str) -> dict:
    src = PENDING_DIR / f"{draft_id}.json"
    if not src.exists():
        raise FileNotFoundError(f"Pending draft {draft_id} not found")
    item = json.loads(src.read_text())
    item["status"] = "approved"
    item["approved_at"] = datetime.now().isoformat()
    _ensure_dirs()
    dst = PROCESSED_DIR / f"{draft_id}.json"
    dst.write_text(json.dumps(item, indent=2))
    src.unlink()
    print(f"Approved: {draft_id}")
    return item


def skip(draft_id: str, reason: str = "") -> dict:
    src = PENDING_DIR / f"{draft_id}.json"
    if not src.exists():
        raise FileNotFoundError(f"Pending draft {draft_id} not found")
    item = json.loads(src.read_text())
    item["status"] = "skipped"
    item["skipped_at"] = datetime.now().isoformat()
    item["skip_reason"] = reason
    _ensure_dirs()
    dst = PROCESSED_DIR / f"{draft_id}.json"
    dst.write_text(json.dumps(item, indent=2))
    src.unlink()
    print(f"Skipped: {draft_id}" + (f" ({reason})" if reason else ""))
    return item


def log_executed(draft_id: str, result: str = "sent") -> dict:
    path = PROCESSED_DIR / f"{draft_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Processed draft {draft_id} not found — run approve first")
    item = json.loads(path.read_text())
    item["status"] = "executed"
    item["executed_at"] = datetime.now().isoformat()
    item["execution_result"] = result
    path.write_text(json.dumps(item, indent=2))
    print(f"Logged as executed: {draft_id} ({result})")
    return item


def main():
    parser = argparse.ArgumentParser(description="Matt Cronin Agent Queue Manager")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list").add_argument("-v", "--verbose", action="store_true")

    save_p = sub.add_parser("save")
    save_p.add_argument("--type", required=True, help="email_reply | outreach | hubspot_update | sequence_enroll")
    save_p.add_argument("--to", default="")
    save_p.add_argument("--subject", default="")
    save_p.add_argument("--body", default="")
    save_p.add_argument("--body-file", help="Path to text file containing email body")
    save_p.add_argument("--cc", default="")
    save_p.add_argument("--context", default="{}", help="JSON string of context metadata")

    get_p = sub.add_parser("get")
    get_p.add_argument("--draft-id", required=True)

    approve_p = sub.add_parser("approve")
    approve_p.add_argument("--draft-id", required=True)

    skip_p = sub.add_parser("skip")
    skip_p.add_argument("--draft-id", required=True)
    skip_p.add_argument("--reason", default="")

    exec_p = sub.add_parser("executed")
    exec_p.add_argument("--draft-id", required=True)
    exec_p.add_argument("--result", default="sent")

    args = parser.parse_args()

    if args.command == "list":
        list_pending(verbose=args.verbose)

    elif args.command == "save":
        body = args.body
        if args.body_file:
            body = Path(args.body_file).read_text()
        ctx = json.loads(args.context)
        save_draft(
            item_type=args.type,
            context=ctx,
            to=args.to,
            subject=args.subject,
            body=body,
            cc=args.cc,
        )

    elif args.command == "get":
        item = get_draft(args.draft_id)
        print(json.dumps(item, indent=2))

    elif args.command == "approve":
        approve(args.draft_id)

    elif args.command == "skip":
        skip(args.draft_id, reason=args.reason)

    elif args.command == "executed":
        log_executed(args.draft_id, result=args.result)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
