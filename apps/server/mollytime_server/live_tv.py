"""Bounded playlist parsing and public-network downloads for experimental live TV."""

import hashlib
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit

MAX_BYTES = 2 * 1024 * 1024
MAX_CHANNELS = 2000


def validate_url(value):
    if len(value) > 4096 or any(ord(c) <= 32 for c in value):
        raise ValueError("地址格式无效")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("仅支持不含账号密码的 HTTP / HTTPS 地址")
    if parsed.fragment or parsed.hostname.lower() in ("localhost", "localhost.localdomain"):
        raise ValueError("地址格式无效")
    # Reject malformed ports and explicitly private addresses even in uploaded playlists.
    _ = parsed.port
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise ValueError("仅支持公网地址")
    return parsed


def download_playlist(url):
    """Pin each connection to a validated IP; revalidate every redirect (no DNS rebinding)."""
    deadline = time.monotonic() + 12
    for _ in range(4):
        parsed = validate_url(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError("订阅地址必须指向公网服务器")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("下载超时，请上传列表文件")
        address = addresses[0][4][0]
        connection = http.client.HTTPConnection(parsed.hostname, port, timeout=min(remaining, 5))
        try:
            sock = socket.create_connection((address, port), timeout=min(remaining, 5))
            connection.sock = sock
            if parsed.scheme == "https":
                connection.sock = ssl.create_default_context().wrap_socket(
                    sock, server_hostname=parsed.hostname
                )
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            connection.request(
                "GET",
                path,
                headers={"User-Agent": "MollyTime-LiveTV/1", "Accept-Encoding": "identity"},
            )
            connected_socket = connection.sock
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("订阅重定向无效")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f"订阅下载失败（HTTP {response.status}）")
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("下载超时，请上传列表文件")
                connected_socket.settimeout(min(remaining, 5))
                chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("列表不能超过 2 MB")
            data = b"".join(chunks)
            try:
                return data.decode("utf-8-sig")
            except UnicodeDecodeError:
                return data.decode("gb18030")
        finally:
            connection.close()
    raise ValueError("订阅重定向次数过多")


def parse_playlist(text, family_id):
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("列表不能超过 2 MB")
    channels, seen, skipped = [], set(), 0
    group, pending = "未分组", None
    for raw in text.lstrip("\ufeff").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            # Attribute values may contain commas; split outside quoted attributes.
            match = re.match(r'^#EXTINF:(?:[^",]|"[^"]*")*,(.*)$', line)
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', line))
            pending = {
                "name": (match.group(1).strip() if match else "") or attrs.get("tvg-name", ""),
                "group": attrs.get("group-title", "未分组"),
            }
            continue
        if line.startswith("#"):
            continue
        if ",#genre#" in line:
            group = line.split(",", 1)[0].strip() or "未分组"
            pending = None
            continue
        if pending is not None:
            name, channel_group, url = pending["name"], pending["group"], line
            pending = None
        elif "," in line and not line.startswith(("http://", "https://")):
            name, url = (part.strip() for part in line.split(",", 1))
            channel_group = group
        else:
            skipped += 1
            continue
        try:
            validate_url(url)
            if not name or len(name) > 256 or len(channel_group) > 128:
                raise ValueError("频道名称无效")
        except ValueError:
            skipped += 1
            continue
        if url in seen:
            skipped += 1
            continue
        seen.add(url)
        identity = hashlib.sha256((family_id + "\n" + url).encode()).hexdigest()[:32]
        channels.append({"id": identity, "name": name, "group": channel_group, "url": url})
        if len(channels) > MAX_CHANNELS:
            raise ValueError("最多支持 2000 个频道，请缩小列表后导入")
    if not channels:
        raise ValueError("没有找到有效频道，请提供 M3U 或 TXT 直播列表")
    return channels, skipped
