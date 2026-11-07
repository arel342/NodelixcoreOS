# Local HTTPS migration

NodelixcoreOS serves the dashboard, REST API, and WebSocket from one Node.js TLS listener. The endpoint schemes are **HTTPS** and **WSS**. There is no HTTP API listener and no automatic HTTP fallback. TLS configuration errors stop startup.

## 1. Prepare a stable LAN name

Prefer a stable LAN hostname such as `nodelixcoreos.local` over hard-coding a DHCP address. Configure a DHCP reservation or local DNS/mDNS record so that the hostname resolves to the current server address. Do not put an IP address in the certificate unless it is stable and you intend to keep using it.

The exact server hostname, every address that clients will type, and `TLS_SERVER_NAMES` must match the certificate Subject Alternative Name (SAN). This repository cannot infer your LAN subnet, server address, or router configuration.

## 2. Create the private Root CA offline

On a separate, controlled CA workstation (not on the NodelixcoreOS server and not inside the Git repository), create the CA directory and private key:

```sh
mkdir nodelix-local-ca
cd nodelix-local-ca
chmod 700 .
openssl ecparam -name prime256v1 -genkey -noout -out root-ca.key
chmod 600 root-ca.key
openssl req -x509 -new -key root-ca.key -sha256 -days 3650 \
  -out root-ca.crt \
  -subj "/CN=NodelixcoreOS Local Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
```

Keep `root-ca.key` offline and backed up securely. **Never copy it to the server, APK, or Git repository.** Only `root-ca.crt` (the public CA certificate) is distributed.

## 3. Generate the server key and certificate request

On the NodelixcoreOS server, create a protected certificate directory. Generate the server private key there; it never needs to leave this server:

```sh
mkdir -p certs
chmod 700 certs
openssl ecparam -name prime256v1 -genkey -noout -out certs/server.key
chmod 600 certs/server.key
```

Create `server-san.cnf` outside Git or in a temporary working directory. Replace the example hostname with the actual stable LAN hostname. Add an IP SAN only for an address that will remain stable:

```ini
[ req ]
prompt = no
distinguished_name = dn
req_extensions = request_ext

[ dn ]
CN = nodelixcoreos.local

[ request_ext ]
subjectAltName = @alt_names

[ server_cert ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = nodelixcoreos.local
# Optional, only for a stable server IP:
# IP.1 = 192.168.1.20
```

Create a CSR:

```sh
openssl req -new -key certs/server.key -out server.csr -config server-san.cnf
```

Transfer **only** `server.csr` to the offline CA workstation. The server private key stays on the server.

## 4. Sign the server CSR on the CA workstation

Copy the CSR to the CA workstation, then issue a server certificate:

```sh
openssl x509 -req -in server.csr \
  -CA root-ca.crt -CAkey root-ca.key -CAcreateserial \
  -out server.crt -days 397 -sha256 \
  -extfile server-san.cnf -extensions server_cert
```

Return `server.crt` to the server. Copy the public `root-ca.crt` to `certs/root-ca.crt`. The server directory should contain:

- `certs/server.key` — private, mode 600, never commit.
- `certs/server.crt` — public server certificate.
- `certs/root-ca.crt` — public Root CA certificate.

Set permissions:

```sh
chmod 600 certs/server.key
chmod 644 certs/server.crt certs/root-ca.crt
```

This server implementation deliberately expects the server certificate to be signed directly by the configured self-signed Root CA. It checks the current validity dates, issuer/signature, private-key match, SAN, and every configured server name before opening the listener.

## 5. Configure the environment

Copy `.env.example` to `.env` if this is a new installation. Set these values to match the certificate and your actual LAN:

```dotenv
PORT=3000
BIND_HOST=0.0.0.0
LOCAL_ALLOWED_CIDRS=127.0.0.1/32,::1/128
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key
TLS_CA_CERT_PATH=./certs/root-ca.crt
TLS_SERVER_NAMES=nodelixcoreos.local
TRUST_PROXY=false
```

Replace `LOCAL_ALLOWED_CIDRS` with the actual client-side LAN subnet(s), for example `192.168.1.0/24` only if that is truly your LAN. You can list both IPv4 and IPv6 CIDRs separated by commas. The default loopback-only rule intentionally prevents LAN clients from connecting until an administrator configures the proper subnet. Empty allowlists, catch-all networks (`0.0.0.0/0`, `::/0`), and non-local/public subnets are rejected. Only RFC1918 IPv4, IPv4 loopback/link-local, IPv6 ULA, IPv6 link-local, and IPv6 loopback CIDRs are accepted.

Determine the subnet from the server/router configuration (for example, `ip -4 route` on Linux/Termux or `ipconfig` on Windows). Do not assume the server is always assigned the same IP. A stable DNS hostname plus DHCP reservation is preferred.

## 6. Restrict the host firewall and router

Allow inbound TCP port 3000 only from the same explicitly approved LAN subnet. Example for a Windows server (replace the subnet with the real one):

```powershell
New-NetFirewallRule -DisplayName "NodelixcoreOS HTTPS LAN" -Direction Inbound -Protocol TCP -LocalPort 3000 -RemoteAddress 192.168.1.0/24 -Action Allow
```

Example for a Linux host using UFW:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
```

Do not add a broad inbound allow rule. Do not configure router port forwarding, DMZ, or UPnP forwarding for this service. Keep the server behind the local network boundary. The application CIDR check is an additional boundary, not a replacement for the host firewall.

## 7. Trust the private CA in the Android application

The Android application source is not included in this repository. The Android-side changes below must be made in the separate Android project and tested on the actual APK before the migration is declared complete.

Copy only the public `root-ca.crt` into the Android project as `app/src/main/res/raw/nodelix_local_ca.crt`. Add an Android Network Security Configuration (for example, `app/src/main/res/xml/network_security_config.xml`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">nodelixcoreos.local</domain>
        <trust-anchors>
            <certificates src="@raw/nodelix_local_ca" />
        </trust-anchors>
    </domain-config>
</network-security-config>
```

Reference it from the application manifest using `android:networkSecurityConfig="@xml/network_security_config"` and keep `android:usesCleartextTraffic="false"`. The mobile client must use `https://nodelixcoreos.local:3000` for REST and `wss://nodelixcoreos.local:3000` for WebSocket. Keep platform hostname verification enabled. Do not use a trust-all TrustManager, disable hostname checks, or silently fall back to HTTP.

The Android project should trust the public CA certificate only. Never put `root-ca.key` or `certs/server.key` in the APK. SPKI pinning is not enabled by this server change; implement it only with primary and backup pins plus a tested rotation/recovery plan.

## 8. Verify the local server

After the CA certificate is trusted by the client, start the server:

```sh
npm start
```

Check the certificate and endpoint from another LAN device:

```sh
openssl s_client -connect nodelixcoreos.local:3000 -servername nodelixcoreos.local -CAfile certs/root-ca.crt -tls1_2
curl --cacert certs/root-ca.crt https://nodelixcoreos.local:3000/api/session
```

The browser should show a valid certificate for the exact hostname. A request with an untrusted CA, a mismatched hostname, an expired certificate, or unsupported TLS version must fail at the client. An HTTP request to the HTTPS port must not return an API response; the service does not listen for plain HTTP.

## 9. Certificate renewal

Renew before the 397-day server certificate expires. Generate a fresh server key/CSR, sign it using the offline Root CA, update the server certificate and key atomically, verify the configured SAN names, then restart the server. For planned CA rotation, distribute and trust the new public CA certificate in the Android application before switching the server certificate. Keep a documented overlapping trust period and a tested backup-pin/trust recovery strategy if the app later implements pinning.

Never renew by copying the CA private key to the server.

## 10. Rollback

If HTTPS startup or Android trust fails:

1. Stop the server process; do not re-enable a plain HTTP listener.
2. Restore the previous source/configuration backup on a maintenance branch or local copy, but keep the service stopped or bound to loopback and the firewall restricted until HTTPS is repaired.
3. Restore the last known-good server certificate/key pair and matching public CA certificate, then validate the SAN and expiry.
4. Re-test HTTPS, REST, WSS, and Android trust before allowing LAN access again.

Rollback must not expose the previous HTTP-only service to the LAN. If the TLS configuration cannot be restored, leave the web service unavailable rather than accepting credentials over HTTP.
