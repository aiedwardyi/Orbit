// Peer address helpers and plaintext TLS alerts.

import { isIPv4, isIPv6 } from "node:net";
import type { Socket } from "node:net";

function stripMapped(ip: string): string {
  return ip.startsWith("::ffff:") && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

function expandV6(ip: string): number[] | null {
  if (!isIPv6(ip) || ip.includes(".")) return null;
  const [head, tail = ""] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const fill = ip.includes("::") ? 8 - a.length - b.length : 0;
  const groups = [...a, ...Array(fill).fill("0"), ...b].map((g) => parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

/** IPv4 /24 or IPv6 /48 for logs. Never the full address. */
export function peerPrefix(address: string | undefined): string | null {
  if (!address) return null;
  const ip = stripMapped(address);
  if (isIPv4(ip)) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  const groups = expandV6(ip);
  if (!groups) return null;
  return `${groups.slice(0, 3).map((g) => g.toString(16)).join(":")}::/48`;
}

/** Rate-limit key: the full IPv4 address, or the IPv6 /64. */
export function rateKey(address: string | undefined): string {
  if (!address) return "unknown";
  const ip = stripMapped(address);
  if (isIPv4(ip)) return ip;
  const groups = expandV6(ip);
  return groups ? groups.slice(0, 4).map((g) => g.toString(16)).join(":") : "unknown";
}

/** Address as it goes into `go {peer}`: plain IP, mapped IPv4 unwrapped. */
export function peerAddress(address: string | undefined): string {
  return address ? stripMapped(address) : "";
}

export const ALERT_UNRECOGNIZED_NAME = 112;
export const ALERT_NO_APPLICATION_PROTOCOL = 120;
export const ALERT_INTERNAL_ERROR = 80;

/** Writes a fatal plaintext TLS alert and closes. Needs no certificate. */
export function sendAlert(socket: Socket, description: number): void {
  if (socket.destroyed) return;
  socket.end(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, description]));
  socket.setTimeout(2_000, () => socket.destroy());
}
