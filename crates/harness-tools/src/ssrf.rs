//! SSRF protection for the always-on, ungated `http.fetch` tool.
//!
//! `http.fetch` hands a model-supplied URL to the HTTP client. Without a guard
//! a prompt-injected model can reach cloud metadata endpoints
//! (`169.254.169.254`), loopback admin surfaces (`localhost:7001`), and RFC-1918
//! internal services — turning the agent into an SSRF pivot. This module owns
//! the policy + IP-classification used to reject those targets.
//!
//! The classification is intentionally conservative: we block anything that
//! isn't a routable public address. The functions here are pure (no I/O); DNS
//! resolution lives in `http.rs` so it can be injected in tests.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Policy controlling SSRF protection for `http.fetch`.
#[derive(Clone, Debug)]
pub struct SsrfPolicy {
    /// When `true` (default) requests to loopback / link-local / private /
    /// reserved addresses are rejected. Set `false` to restore the legacy
    /// unrestricted behaviour (operator opt-out).
    pub block_private: bool,
    /// Hostnames exempt from the private-range check (exact match,
    /// case-insensitive). A matching host is fetched even if it resolves to a
    /// private address — for operators who deliberately point `http.fetch` at
    /// an internal service.
    pub allow_hosts: Vec<String>,
}

impl Default for SsrfPolicy {
    fn default() -> Self {
        Self {
            block_private: true,
            allow_hosts: Vec::new(),
        }
    }
}

impl SsrfPolicy {
    /// The legacy behaviour: no SSRF checks at all. Used by tests that exercise
    /// formatting/transport against stub or loopback servers.
    pub fn unrestricted() -> Self {
        Self {
            block_private: false,
            allow_hosts: Vec::new(),
        }
    }

    /// Build a policy from an operator allowlist. A single `"*"` entry disables
    /// blocking entirely; otherwise the listed hosts bypass the private-range
    /// check while everything else stays guarded.
    pub fn from_allow_hosts(hosts: Vec<String>) -> Self {
        if hosts.iter().any(|h| h.trim() == "*") {
            return Self::unrestricted();
        }
        Self {
            block_private: true,
            allow_hosts: hosts,
        }
    }

    /// Whether `host` is explicitly allowlisted (case-insensitive exact match).
    pub fn is_allowlisted(&self, host: &str) -> bool {
        self.allow_hosts
            .iter()
            .any(|h| h.trim().eq_ignore_ascii_case(host))
    }
}

/// Classify an IP address. Returns `Some(reason)` when the address must be
/// blocked for SSRF safety, `None` when it is an acceptable public target.
pub fn classify_blocked(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible addresses smuggle
            // a v4 target through a v6 literal — classify the embedded v4.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return classify_v4(mapped);
            }
            classify_v6(v6)
        }
    }
}

fn classify_v4(v4: Ipv4Addr) -> Option<&'static str> {
    let o = v4.octets();
    if v4.is_unspecified() {
        return Some("unspecified address (0.0.0.0)");
    }
    if v4.is_loopback() {
        return Some("loopback address (127.0.0.0/8)");
    }
    if v4.is_private() {
        return Some("private RFC-1918 address");
    }
    if v4.is_link_local() {
        return Some("link-local address (169.254.0.0/16) — cloud metadata");
    }
    if v4.is_broadcast() {
        return Some("broadcast address");
    }
    if v4.is_multicast() {
        return Some("multicast address");
    }
    if o[0] == 0 {
        return Some("reserved address (0.0.0.0/8)");
    }
    // Carrier-grade NAT / shared address space (100.64.0.0/10).
    if o[0] == 100 && (o[1] & 0xc0) == 64 {
        return Some("shared CGNAT address (100.64.0.0/10)");
    }
    // Reserved future-use block (240.0.0.0/4).
    if o[0] >= 240 {
        return Some("reserved address (240.0.0.0/4)");
    }
    None
}

fn classify_v6(v6: Ipv6Addr) -> Option<&'static str> {
    let seg = v6.segments();
    if v6.is_unspecified() {
        return Some("unspecified address (::)");
    }
    if v6.is_loopback() {
        return Some("loopback address (::1)");
    }
    if v6.is_multicast() {
        return Some("multicast address");
    }
    // Unique-local addresses (fc00::/7).
    if (seg[0] & 0xfe00) == 0xfc00 {
        return Some("unique-local address (fc00::/7)");
    }
    // Link-local addresses (fe80::/10).
    if (seg[0] & 0xffc0) == 0xfe80 {
        return Some("link-local address (fe80::/10)");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_loopback_and_metadata_and_private() {
        for addr in [
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254", // AWS/GCP metadata
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "0.0.0.0",
            "100.64.0.1", // CGNAT
            "::1",
            "fe80::1",   // link-local
            "fc00::1",   // unique-local
            "fd00::1",   // unique-local
            "::ffff:127.0.0.1", // v4-mapped loopback
            "::ffff:169.254.169.254",
        ] {
            assert!(
                classify_blocked(ip(addr)).is_some(),
                "expected {addr} to be blocked"
            );
        }
    }

    #[test]
    fn allows_public_addresses() {
        for addr in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"] {
            assert!(
                classify_blocked(ip(addr)).is_none(),
                "expected {addr} to be allowed"
            );
        }
    }

    #[test]
    fn allowlist_matches_case_insensitively() {
        let p = SsrfPolicy::from_allow_hosts(vec!["Internal.Example".into()]);
        assert!(p.block_private);
        assert!(p.is_allowlisted("internal.example"));
        assert!(p.is_allowlisted("INTERNAL.EXAMPLE"));
        assert!(!p.is_allowlisted("other.example"));
    }

    #[test]
    fn wildcard_allowlist_disables_blocking() {
        let p = SsrfPolicy::from_allow_hosts(vec!["*".into()]);
        assert!(!p.block_private);
    }

    #[test]
    fn unrestricted_policy_blocks_nothing() {
        assert!(!SsrfPolicy::unrestricted().block_private);
    }
}
