// Remote Access — the home-side pairing surface for the native mobile app.
//
// Reads `GET /v1/remote/info` (LAN addrs, external origin, whether a token is
// required) and the LOOPBACK-ONLY `GET /v1/remote/pairing` (token + ready-made
// `jarvis://pair` links). Renders a QR per origin so the phone can scan-to-pair,
// plus copyable links. DDNS *editing* lives in the mobile app (per design); this
// screen is just "how do I connect my phone to this machine".
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Section, Row } from "./Section";
import { t } from "../../../utils/i18n";
import { apiUrl } from "../../../services/api";
import {
  fetchDesktopStatus,
  setDesktopLanExposure,
  supportsLanExposure,
} from "../../../services/desktop";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

interface RemoteInfo {
  device_name: string;
  lan_addrs: string[];
  port: number;
  external: { hostname?: string; public_ip?: string; reachable?: boolean | null };
  requires_auth: boolean;
  version?: string | null;
}
interface PairingLink {
  origin: string;
  link: string;
}
interface Pairing {
  device_name: string;
  token: string | null;
  origins: string[];
  pairing_links: PairingLink[];
}

export function RemoteAccessSection({ embedded }: { embedded?: boolean } = {}) {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingBlocked, setPairingBlocked] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Desktop (Electron) shell only: the embedded server's LAN-exposure toggle.
  const [lanExposure, setLanExposure] = useState<boolean | null>(null);
  const [lanBusy, setLanBusy] = useState(false);

  async function reload(): Promise<void> {
    setError(null);
    try {
      const r = await fetch(apiUrl("/v1/remote/info"));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setInfo((await r.json()) as RemoteInfo);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const r = await fetch(apiUrl("/v1/remote/pairing"));
      if (r.status === 403) {
        setPairingBlocked(true);
        setPairing(null);
      } else if (r.ok) {
        setPairingBlocked(false);
        setPairing((await r.json()) as Pairing);
      }
    } catch {
      /* pairing is best-effort */
    }
  }

  useEffect(() => {
    void reload();
    if (supportsLanExposure()) {
      void fetchDesktopStatus().then((s) => {
        if (s) setLanExposure(s.lan_exposure === true);
      });
    }
  }, []);

  const toggleLan = async (enabled: boolean): Promise<void> => {
    setLanBusy(true);
    setLanExposure(enabled); // optimistic; the window reloads on success anyway
    try {
      const s = await setDesktopLanExposure(enabled);
      if (s) setLanExposure(s.lan_exposure === true);
      await reload();
    } finally {
      setLanBusy(false);
    }
  };

  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Section
      id="remote-access"
      titleKey="settingsRemoteTitle"
      titleFallback="Remote Access"
      descKey="settingsRemoteDesc"
      descFallback="Connect the Jarvis mobile app to this machine. Scan a QR on the same Wi-Fi, then configure DDNS from the app for access from anywhere."
      embedded={embedded}
    >
      {error && <p className="settings-warning">{error}</p>}

      {lanExposure !== null && (
        <Row
          label={tx("settingsRemoteLanToggle", "Expose on LAN")}
          hint={tx(
            "settingsRemoteLanToggleHint",
            "Bind the embedded server to 0.0.0.0 with a generated access token so phones on this network can pair. The app reloads when toggled.",
          )}
        >
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={lanExposure}
              disabled={lanBusy}
              onChange={(e) => void toggleLan(e.target.checked)}
            />
            <span>
              {lanBusy
                ? tx("settingsRemoteLanRestarting", "Restarting…")
                : lanExposure
                  ? tx("settingsRemoteLanOn", "on — LAN + token")
                  : tx("settingsRemoteLanOff", "off — this Mac only")}
            </span>
          </label>
        </Row>
      )}

      {info && (
        <>
          <Row label={tx("settingsRemoteDevice", "This device")}>
            <span>{info.device_name}{info.version ? ` · v${info.version}` : ""}</span>
          </Row>
          <Row
            label={tx("settingsRemoteAuth", "Authentication")}
            hint={tx("settingsRemoteAuthHint", "Set JARVIS_ACCESS_TOKEN before exposing the server beyond the LAN.")}
          >
            <span>
              {info.requires_auth
                ? tx("settingsRemoteAuthOn", "token required (good for external access)")
                : tx("settingsRemoteAuthOff", "none — loopback/LAN only")}
            </span>
          </Row>
          {info.lan_addrs.length > 0 && (
            <Row label={tx("settingsRemoteLan", "LAN addresses")}>
              <code>{info.lan_addrs.map((a) => `${a}:${info.port}`).join("  ")}</code>
            </Row>
          )}
          {info.external.hostname && (
            <Row label={tx("settingsRemoteExternal", "External hostname")}>
              <code>{info.external.hostname}</code>
              {info.external.reachable != null && (
                <span>{info.external.reachable ? " ✓ reachable" : " — not confirmed"}</span>
              )}
            </Row>
          )}
        </>
      )}

      {pairingBlocked && (
        <p className="settings-hint">
          {tx(
            "settingsRemotePairingLoopback",
            "Open this page on the host machine (loopback) to reveal the pairing QR + token.",
          )}
        </p>
      )}

      {pairing && pairing.pairing_links.length > 0 && (
        <div className="settings-remote-pairing">
          <p className="settings-hint">
            {tx("settingsRemoteScan", "In the mobile app: Settings → Scan pairing QR.")}
          </p>
          {pairing.pairing_links.map((p) => (
            <div key={p.origin} className="settings-remote-qr">
              <QRCodeSVG value={p.link} size={148} includeMargin />
              <div className="settings-remote-qr-meta">
                <code>{p.origin}</code>
                <button type="button" className="settings-btn settings-btn-ghost" onClick={() => copy(p.link)}>
                  {copied === p.link ? tx("settingsCopied", "Copied") : tx("settingsCopyLink", "Copy link")}
                </button>
              </div>
            </div>
          ))}
          {pairing.token && (
            <Row label={tx("settingsRemoteToken", "Access token")}>
              <button type="button" className="settings-btn settings-btn-ghost" onClick={() => copy(pairing.token ?? "")}>
                {copied === pairing.token ? tx("settingsCopied", "Copied") : tx("settingsRemoteCopyToken", "Copy token")}
              </button>
            </Row>
          )}
        </div>
      )}

      <button type="button" className="settings-btn settings-btn-ghost" onClick={() => void reload()}>
        {tx("settingsRefresh", "Refresh")}
      </button>
    </Section>
  );
}
