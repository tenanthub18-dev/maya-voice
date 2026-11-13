import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const MAXIMUM_URL_LENGTH = 2_048;
const MAXIMUM_HOSTNAME_LENGTH = 253;
const MAXIMUM_REDIRECTS = 5;

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, {all: true, verbatim: true})).map(({address}) => address);
}

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets : undefined;
}

function publicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Words(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const dottedTail = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const tailOctets = dottedTail ? parseIpv4(dottedTail) : undefined;
  const normalized = tailOctets
    ? address.slice(0, -dottedTail!.length)
      + ((tailOctets[0] ?? 0) * 256 + (tailOctets[1] ?? 0)).toString(16)
      + ':' + ((tailOctets[2] ?? 0) * 256 + (tailOctets[3] ?? 0)).toString(16)
    : address;
  const [leftText, rightText = ''] = normalized.toLowerCase().split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!normalized.includes('::') && missing !== 0)) return undefined;
  const words = [...left, ...Array.from({length: missing}, () => '0'), ...right]
    .map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words : undefined;
}

function publicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const first = words[0] ?? 0;
  const isUnspecified = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (isMappedIpv4) {
    return publicIpv4(`${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 255}.${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 255}`);
  }
  return !(
    isUnspecified || isLoopback
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
  );
}

function publicAddress(address: string): boolean {
  return isIP(address) === 4 ? publicIpv4(address) : isIP(address) === 6 ? publicIpv6(address) : false;
}

function parseAllowedUrl(input: string): URL {
  if (input.length > MAXIMUM_URL_LENGTH) throw new Error('URL is too long');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('URL is not allowed'); }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== ''
    || url.hostname.length === 0 || url.hostname.length > MAXIMUM_HOSTNAME_LENGTH
    || (url.port !== '' && !(
      (url.protocol === 'http:' && url.port === '80')
      || (url.protocol === 'https:' && url.port === '443')
    ))
  ) throw new Error('URL is not allowed');
  return url;
}

async function validateResolution(url: URL, resolver: HostResolver): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const literalKind = isIP(hostname);
  const first = literalKind ? [hostname] : await resolver(hostname);
  const second = literalKind ? first : await resolver(hostname);
  if (first.length === 0 || second.length === 0 || [...first, ...second].some((address) => !publicAddress(address))) {
    throw new Error('URL is not allowed');
  }
}

export async function validatePublicHttpUrl(
  input: string,
  resolver: HostResolver = defaultResolver,
): Promise<string> {
  const url = parseAllowedUrl(input);
  await validateResolution(url, resolver);
  return url.toString();
}

export async function validatePublicRedirectChain(
  input: string,
  options: {fetcher?: typeof fetch; resolver?: HostResolver} = {},
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const resolver = options.resolver ?? defaultResolver;
  let current = await validatePublicHttpUrl(input, resolver);
  for (let redirect = 0; redirect <= MAXIMUM_REDIRECTS; redirect += 1) {
    const response = await fetcher(current, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get('location');
    if (!location || redirect === MAXIMUM_REDIRECTS) throw new Error('URL is not allowed');
    current = await validatePublicHttpUrl(new URL(location, current).toString(), resolver);
  }
  throw new Error('URL is not allowed');
}
