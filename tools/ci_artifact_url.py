"""Resolve a short-lived GitHub Actions artifact download URL without logging it."""

import argparse
import base64
import http.client
import os
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--artifact-id", type=int, required=True)
    args = parser.parse_args()
    if not args.repo.replace("/", "").replace("-", "").replace("_", "").isalnum() or args.repo.count("/") != 1:
        raise ValueError("Invalid repository")
    if args.artifact_id <= 0:
        raise ValueError("Invalid artifact ID")
    token = os.environ["GITHUB_TOKEN"]
    connection = http.client.HTTPSConnection("api.github.com", timeout=20)
    connection.request(
        "GET", f"/repos/{args.repo}/actions/artifacts/{args.artifact_id}/zip",
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "mollytime-deploy"},
    )
    response = connection.getresponse()
    url = response.getheader("Location")
    if response.status != 302 or not url:
        raise RuntimeError(f"GitHub artifact URL request failed: HTTP {response.status}")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or len(url) > 4096:
        raise ValueError("Invalid GitHub artifact redirect")
    print(base64.urlsafe_b64encode(url.encode("ascii")).decode("ascii").rstrip("="))


if __name__ == "__main__":
    main()
