// Throwaway X.509 for relay tests: a root CA that signs the fake relay's
// certificate and the fake ACME CA's issued certificates.

import { X509Certificate, webcrypto } from "node:crypto";

import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const DAY = 24 * 60 * 60_000;

export interface KeyAndCert {
  keyPem: string;
  certPem: string;
}

export interface Validity {
  notBefore?: Date;
  notAfter?: Date;
}

function pem(label: string, der: ArrayBuffer): string {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function newKeys(): Promise<webcrypto.CryptoKeyPair> {
  return webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
}

let serial = 1;
const nextSerial = () => (serial++).toString(16).padStart(4, "0");

export class TestCa {
  readonly certPem: string;
  private readonly keys: webcrypto.CryptoKeyPair;
  private readonly cert: x509.X509Certificate;

  private constructor(keys: webcrypto.CryptoKeyPair, cert: x509.X509Certificate) {
    this.keys = keys;
    this.cert = cert;
    this.certPem = cert.toString("pem");
  }

  static async create(name = "Wink Test Root"): Promise<TestCa> {
    const keys = await newKeys();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: nextSerial(),
      name: `CN=${name}`,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 3650 * DAY),
      keys,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    return new TestCa(keys, cert);
  }

  private async leaf(host: string, publicKey: webcrypto.CryptoKey, validity: Validity): Promise<string> {
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: nextSerial(),
      subject: `CN=${host}`,
      issuer: this.cert.subject,
      notBefore: validity.notBefore ?? new Date(Date.now() - 60_000),
      notAfter: validity.notAfter ?? new Date(Date.now() + 90 * DAY),
      signingAlgorithm: ALG,
      publicKey,
      signingKey: this.keys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
        // Like a real CA's leaves: an AKI equal to the root's SKI, which ARI's certID needs.
        await x509.AuthorityKeyIdentifierExtension.create(this.keys.publicKey),
      ],
    });
    return cert.toString("pem");
  }

  async issue(host: string, validity: Validity = {}): Promise<KeyAndCert> {
    const keys = await newKeys();
    const certPem = await this.leaf(host, keys.publicKey, validity);
    return { keyPem: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)), certPem };
  }

  /** Signs a PKCS#10 CSR (base64url DER, as ACME finalize sends it) for its first DNS SAN. */
  async signCsr(csrB64url: string, validity: Validity = {}): Promise<{ certPem: string; host: string }> {
    const csr = new x509.Pkcs10CertificateRequest(Buffer.from(csrB64url, "base64url"));
    if (!(await csr.verify())) throw new Error("CSR signature invalid");
    const host = sanOf(csr.extensions).find((name) => name.type === "dns")?.value;
    if (!host) throw new Error("CSR has no DNS name");
    const publicKey = await csr.publicKey.export(ALG, ["verify"]);
    return { certPem: `${(await this.leaf(host, publicKey, validity)).trim()}\n${this.certPem.trim()}\n`, host };
  }
}

export interface ChallengeCertInfo {
  dnsNames: string[];
  otherNames: number;
  critical: boolean;
  /** extnValue of id-pe-acmeIdentifier: DER OCTET STRING of the SHA-256 key authorization. */
  value: Buffer;
  /** Names of the keyUsage bits set, or null without that extension. */
  keyUsage: { usages: string[]; critical: boolean } | null;
}

const KEY_USAGES = ["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"] as const;

/** SubjectAltName, acmeIdentifier criticality and digest, and key usage of an RFC 8737 challenge certificate. */
export function inspectChallengeCert(certPem: string): ChallengeCertInfo {
  const cert = new x509.X509Certificate(certPem);
  const names = sanOf(cert.extensions);
  const ext = cert.extensions.find((candidate) => candidate.type === "1.3.6.1.5.5.7.1.31");
  if (!ext) throw new Error("no acmeIdentifier extension");
  const keyUsage = cert.getExtension(x509.KeyUsagesExtension);
  return {
    dnsNames: names.filter((name) => name.type === "dns").map((name) => name.value),
    otherNames: names.filter((name) => name.type !== "dns").length,
    critical: ext.critical,
    value: Buffer.from(ext.value),
    keyUsage: keyUsage && {
      usages: KEY_USAGES.filter((name) => (keyUsage.usages & x509.KeyUsageFlags[name]) !== 0),
      critical: keyUsage.critical,
    },
  };
}

function sanOf(extensions: readonly x509.Extension[]): readonly x509.GeneralName[] {
  for (const ext of extensions) if (ext instanceof x509.SubjectAlternativeNameExtension) return ext.names.items;
  return [];
}

export function leafFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}
