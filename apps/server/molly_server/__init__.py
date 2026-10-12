"""Molly Server — media catalog for the Molly TV client.

Owns its own auth (HMAC + opaque refresh) and its own REST shape under
`/api/*`. No Jellyfin compatibility shims — that protocol set was a
temporary bridge while the TV client was still a fork of
`jellyfin-androidtv` v0.19.10. The new TV client speaks our protocol
directly.
"""

__version__ = "0.2.0"