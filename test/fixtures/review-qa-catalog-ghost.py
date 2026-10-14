#!/usr/bin/env python3
import json
import os
import re
import sys
import uuid

no_session = "--no-session" in sys.argv
session_id = str(uuid.uuid4())
cwd = os.getcwd()
safe_cwd = re.sub(r"^[\\/]+", "", cwd)
safe_cwd = re.sub(r"[\\/:\\x00]", "-", safe_cwd)
session_directory = os.path.join(os.environ["PI_CODING_AGENT_DIR"], "sessions", f"--{safe_cwd}--")
model = {
    "id": "review-qa-model",
    "provider": "review-qa",
    "name": "Review QA model",
    "input": ["text"],
    "contextWindow": 8192,
    "maxTokens": 4096,
}

if not no_session:
    os.makedirs(session_directory, exist_ok=True)
    with open(os.path.join(session_directory, f"{session_id}.jsonl"), "w", encoding="utf-8") as session_file:
        session_file.write(
            json.dumps(
                {
                    "type": "session",
                    "id": session_id,
                    "cwd": cwd,
                    "timestamp": "2026-10-14T00:00:00.000Z",
                }
            )
            + "\n"
        )

for line in sys.stdin:
    command = json.loads(line)
    if command["type"] == "get_available_models":
        data = {"models": [model]}
    elif command["type"] == "get_state":
        data = {"model": model, "sessionId": session_id}
    else:
        data = {}
    sys.stdout.write(
        json.dumps(
            {
                "type": "response",
                "id": command["id"],
                "command": command["type"],
                "success": True,
                "data": data,
            }
        )
        + "\n"
    )
    sys.stdout.flush()
