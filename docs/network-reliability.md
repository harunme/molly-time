# Client DNS recovery

The November 7, 2026 home-network incident returned `216.236.61.204` for
`mollytime.app` from the router, while both authoritative nameservers and several
public resolvers returned the production address. A verified HTTPS request using
encrypted DNS succeeded on the same Wi-Fi. This establishes a bad local DNS path;
it does not establish whether the router or its upstream created the bad record.

## Android parent and TV

`apps/shared/android/com/molly/network/MollyHttp.kt` supplies builders for API,
image/media, upload, web-bundle and APK-update clients. They resolve official
MollyTime names and Alibaba OSS names through AliDNS DoH, then DNSPod DoH if the
first resolver fails. Fixed provider bootstrap addresses avoid dependency on
the local DNS cache. No application-server IP is embedded. The resolver HTTP
client has no cookies, no application interceptors, no redirects and bounded
timeouts. The disk HTTP cache follows the providers' DNS cache headers and is
evicted on network changes. Custom servers, LAN names and unrelated external
hosts retain system resolution.

If both DoH services are unavailable, system DNS is the last availability path.
All business connections still perform normal HTTPS hostname and trust-chain
verification; an incorrect local answer cannot authorize an invalid certificate.
There is no new application-level replay of write requests.

## iOS

`OfficialDNS` configures the default Network-framework privacy context when using
the official service. Its two DoH endpoints use IP URLs with publicly trusted IP
certificates, avoiding hostname bootstrapping. A bounded, anonymous DNS-message
probe selects a reachable provider. A network-path change reselects the provider
and flushes this process's Network-framework cache. Custom service origins restore
system resolution. Because Apple's setting is process-wide, other connections
in the official-service process also use the selected resolver.

API reads wait for resolver selection. A DNS/connectivity/TLS transport failure
can rotate providers and retry GET/HEAD once, with the same URL and credentials.
POST/PUT/PATCH/DELETE are never replayed by this layer. Existing upload offset,
multipart and session-restoration policies retain ownership of their retries.
Neither this code nor the Android code overrides certificate validation.

Apple's fallback resolver does not override an already configured system/VPN
encrypted resolver. Background URLSession runs in a system process, and its
behavior must be checked separately on devices. A successful simulator request
through a Mac's system proxy does not prove DNS recovery without that proxy.

During local verification the Mac's Tailscale DNS takeover caused direct Apple
foreground probes to time out despite provider rotation. Temporarily disabling
only Tailscale's DNS acceptance (then restoring it) allowed the actual `OfficialDNS`
code and a simulator foreground request to obtain HTTP 200 with proxies disabled,
while the household router still returned the incorrect address. The simulator's
background URLSession health request also obtained HTTP 200; this does not replace
physical-device upload testing after process termination. The VPN behavior is a
platform-policy boundary, not a reason to change the user's VPN or relax TLS.

## Validation and release

Local tests cover a poisoned system resolver, blocked/empty primary answers,
backup selection, custom-name isolation, TLS hostname/trust failures before
credential delivery, read-only recovery and non-replayed mutations.

```bash
swift test --package-path apps/ios --disable-xctest
bash -c 'source tools/android-env.sh
./apps/android/gradlew -p apps/android :app:testDebugUnitTest --tests com.molly.network.OfficialDnsTest'
bash -c 'source tools/android-env.sh
./apps/tv/gradlew -p apps/tv :client:testDebugUnitTest --tests com.molly.network.OfficialDnsTest'
```

An explicitly opted-in, anonymous real-network smoke test uses the actual Android
transport to verify `/healthz` with standard TLS verification:

```bash
MOLLYTIME_NETWORK_SMOKE=1 bash -c 'source tools/android-env.sh
./apps/android/gradlew -p apps/android :app:testDebugUnitTest --tests com.molly.network.OfficialDnsNetworkTest'
```

The network smoke test is skipped by default; normal CI does not depend on public
resolver availability. APK build/CI unit-test defaults remain unchanged. Build
new native clients through the repository build scripts. Existing installations
need the native update; a TV web-only update cannot install a DNS resolver.

Before release, use physical iOS and Android/TV devices on Wi-Fi with deliberately
incorrect system DNS, with proxies/VPNs accounted for. Verify fresh login,
session restoration, covers, playback, signed OSS URLs, uploads after lock screen,
Wi-Fi/cellular switching and client updates. Also test blocked primary and both
blocked providers, and rejection of an invalid server certificate. Check iOS
background uploads after process termination independently.

## Browser and household network

This native-client change cannot repair DNS before a browser loads the website.
The router's upstream DNS configuration and stale record still require separate
maintenance. No router or production DNS settings are changed by this patch.
Public website availability also needs DNS/TLS monitoring from domestic carrier
networks; the GitHub public HTTPS deployment check alone cannot detect this class
of household resolver failure.
