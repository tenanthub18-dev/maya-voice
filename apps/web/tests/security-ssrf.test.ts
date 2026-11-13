import {describe, expect, it, vi} from 'vitest';

import {validatePublicHttpUrl, validatePublicRedirectChain} from '@/lib/security/ssrf';

const publicResolver = vi.fn(async () => ['93.184.216.34']);

describe('website import SSRF guard', () => {
  it.each([
    'ftp://example.com/menu',
    'https://user:password@example.com/menu',
    'https://example.com:444/menu',
    'http://example.com:8080/menu',
    'http://127.0.0.1/menu',
    'http://127.1/menu',
    'http://10.0.0.1/menu',
    'http://172.16.0.1/menu',
    'http://192.168.1.1/menu',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/menu',
    'http://[::1]/menu',
    'http://[fc00::1]/menu',
    'http://[fe80::1]/menu',
    'http://[::ffff:127.0.0.1]/menu',
  ])('rejects hostile URL %s', async (url) => {
    await expect(validatePublicHttpUrl(url, publicResolver)).rejects.toThrow('URL is not allowed');
  });

  it('rejects overlong URLs and hostnames before resolving them', async () => {
    await expect(validatePublicHttpUrl(`https://example.com/${'a'.repeat(2_100)}`, publicResolver))
      .rejects.toThrow('URL is too long');
    await expect(validatePublicHttpUrl(`https://${'a'.repeat(254)}.com/`, publicResolver))
      .rejects.toThrow();
  });

  it.each(['10.0.0.8', '127.0.0.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])
    ('rejects a hostname resolving to non-public address %s', async (address) => {
      await expect(validatePublicHttpUrl('https://restaurant.example/menu', async () => [address]))
        .rejects.toThrow('URL is not allowed');
    });

  it('resolves twice so a rebinding hostname cannot switch to a private address', async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['169.254.169.254']);

    await expect(validatePublicHttpUrl('https://restaurant.example/menu', resolver))
      .rejects.toThrow('URL is not allowed');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('revalidates every redirect destination and rejects public-to-private redirects', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {location: 'http://169.254.169.254/latest/meta-data'},
    }));

    await expect(validatePublicRedirectChain('https://restaurant.example/menu', {fetcher, resolver: publicResolver}))
      .rejects.toThrow('URL is not allowed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns the validated final URL after a bounded public redirect chain', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: '/menu.pdf'}}))
      .mockResolvedValueOnce(new Response(null, {status: 200}));

    await expect(validatePublicRedirectChain('https://restaurant.example/start', {fetcher, resolver: publicResolver}))
      .resolves.toBe('https://restaurant.example/menu.pdf');
  });
});
